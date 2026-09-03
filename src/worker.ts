export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  /** The worker that currently holds the job. Present for legibility; `attempt` is what fences. */
  owner?: string;
  outputKey?: string;
  error?: string;
}

/**
 * Every write states what it expects to already be true.
 *
 * There is deliberately no unconditional `put`. A read followed by an unconditional write is
 * check-then-act, and that is what let two deliveries of the same job both start a conversion and
 * then race to publish. Removing `put` makes that race unrepresentable rather than merely avoided.
 * `compareAndSwap` maps directly onto a DynamoDB conditional expression.
 */
export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  /** Returns false if `expected` no longer matches the stored record; the write is then not applied. */
  compareAndSwap(
    expected: { id: string; status: JobStatus; attempt: number },
    next: Job,
  ): Promise<boolean>;
}

export interface QueueMessage {
  jobId: string;
  receiveCount: number;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export interface RunningConversion {
  /**
   * Resolves with the process exit code. An invalid input is an expected outcome, not an
   * exceptional one, so it arrives as data. Rejects only if the conversion could not be run at all.
   */
  completion: Promise<number>;
  /** Terminates the process *and reaps it* — resolves only once it is confirmed gone. */
  kill(): Promise<void>;
}

export interface Converter {
  start(inputKey: string, outputKey: string): RunningConversion;
}

export interface Clock {
  timeout(ms: number): Promise<never>;
}

/** Per-lane settings. One codebase serves imports and exports by varying these. */
export interface WorkerConfig {
  /** Import ~15 min, export ~90 min. Always below the queue's visibility timeout. */
  timeoutMs: number;
  maxAttempts: number;
  workerId: string;
}

/**
 * Exit codes that will never succeed on a retry. Exit 2 is an invalid database — "required table
 * missing" — so retrying spends attempts to reach the answer already known in the first seconds.
 * Everything else, exit 137 (SIGKILL, usually OOM) included, is treated as transient.
 */
const PERMANENT_EXIT_CODES = new Set([2]);

/** Each attempt writes to its own key, so no attempt can overwrite another's output. */
export function attemptOutputKey(jobId: string, attempt: number): string {
  return `jobs/${jobId}/attempts/${attempt}/result.json`;
}

export async function handle(
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
  config: WorkerConfig,
): Promise<void> {
  const job = await store.get(message.jobId);
  if (!job) {
    await message.ack();
    return;
  }

  if (job.status === "succeeded" || job.status === "failed") {
    await message.ack();
    return;
  }

  const attempt = job.attempt + 1;

  const claimed = await store.compareAndSwap(
    { id: job.id, status: job.status, attempt: job.attempt },
    {
      id: job.id,
      inputKey: job.inputKey,
      status: "running",
      attempt,
      owner: config.workerId,
    },
  );

  // Another delivery claimed this job between our read and our write. Start nothing: ack and leave
  // it to the owner. If the owner dies, its own message redelivers and a later attempt takes over.
  if (!claimed) {
    await message.ack();
    return;
  }

  const outputKey = attemptOutputKey(job.id, attempt);
  const conversion = converter.start(job.inputKey, outputKey);

  let exitCode: number;
  try {
    exitCode = await Promise.race([
      conversion.completion,
      clock.timeout(config.timeoutMs),
    ]);
  } catch (error) {
    // Timed out, or the conversion could not be run. A timed-out subprocess keeps running unless
    // its owner terminates and reaps it — holding memory and scratch disk, occupying a task that
    // cannot take other work, and still able to write its output when it eventually finishes.
    await conversion.kill();
    await finishFailure(message, store, job, attempt, String(error), config, false);
    return;
  }

  if (exitCode === 0) {
    // The only fenced write in the system. It succeeds solely if this attempt still owns the job,
    // so an attempt that returns after a newer one has published loses here and its output file is
    // simply left unreferenced. Publication cannot be duplicated even though work can be.
    await store.compareAndSwap(
      { id: job.id, status: "running", attempt },
      {
        id: job.id,
        inputKey: job.inputKey,
        status: "succeeded",
        attempt,
        owner: config.workerId,
        outputKey,
      },
    );
    await message.ack();
    return;
  }

  await finishFailure(
    message,
    store,
    job,
    attempt,
    `conversion exited with code ${exitCode}`,
    config,
    PERMANENT_EXIT_CODES.has(exitCode),
  );
}

/**
 * A permanent failure is terminal immediately. A transient one is retried by leaving the message on
 * the queue — SQS redelivery drives retries, not application bookkeeping — until attempts run out.
 */
async function finishFailure(
  message: QueueMessage,
  store: JobStore,
  job: Job,
  attempt: number,
  error: string,
  config: WorkerConfig,
  permanent: boolean,
): Promise<void> {
  const exhausted = message.receiveCount >= config.maxAttempts;

  if (!permanent && !exhausted) {
    await message.retry();
    return;
  }

  await store.compareAndSwap(
    { id: job.id, status: "running", attempt },
    {
      id: job.id,
      inputKey: job.inputKey,
      status: "failed",
      attempt,
      owner: config.workerId,
      error,
    },
  );
  await message.ack();
}
