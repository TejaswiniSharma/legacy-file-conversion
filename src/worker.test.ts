import test from "node:test";
import assert from "node:assert/strict";

import { handle } from "./worker.ts";
import type {
  Clock,
  Converter,
  Job,
  JobStatus,
  JobStore,
  QueueMessage,
  RunningConversion,
  WorkerConfig,
} from "./worker.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Models DynamoDB's conditional write: the comparison and the write happen with no `await`
 * between them, so no other handler can interleave. Every race these tests provoke is therefore a
 * real race inside `handle`, not an artefact of the fake.
 */
class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(seed: Job) {
    this.jobs.set(seed.id, { ...seed });
  }

  async get(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async compareAndSwap(
    expected: { id: string; status: JobStatus; attempt: number },
    next: Job,
  ): Promise<boolean> {
    const current = this.jobs.get(expected.id);
    if (!current) return false;
    if (current.status !== expected.status || current.attempt !== expected.attempt) {
      return false;
    }
    this.jobs.set(next.id, { ...next });
    return true;
  }

  snapshot(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return { ...job };
  }
}

type Behaviour = number | "hang";

class FakeConverter implements Converter {
  readonly starts: Array<{ inputKey: string; outputKey: string }> = [];
  kills = 0;
  private readonly resolvers: Array<(code: number) => void> = [];
  private readonly behaviour: (nth: number) => Behaviour;

  /** `behaviour` receives the 1-based index of the conversion being started. */
  constructor(behaviour: (nth: number) => Behaviour = () => 0) {
    this.behaviour = behaviour;
  }

  start(inputKey: string, outputKey: string): RunningConversion {
    this.starts.push({ inputKey, outputKey });

    let resolve!: (code: number) => void;
    const completion = new Promise<number>((r) => {
      resolve = r;
    });
    this.resolvers.push(resolve);

    const outcome = this.behaviour(this.starts.length);
    if (outcome !== "hang") resolve(outcome);

    return {
      completion,
      kill: async () => {
        this.kills += 1;
      },
    };
  }

  /** Complete a conversion that was started as "hang". `nth` is 1-based. */
  finish(nth: number, code: number): void {
    this.resolvers[nth - 1]?.(code);
  }
}

/** Timeouts fire only when a test says so — no real timers, so nothing keeps the suite alive. */
class ManualClock implements Clock {
  private readonly rejects: Array<(reason: unknown) => void> = [];

  timeout(_ms: number): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      this.rejects.push(reject);
    });
  }

  fire(nth = 1): void {
    this.rejects[nth - 1]?.(new Error("conversion timed out"));
  }
}

function makeMessage(jobId: string, receiveCount = 1) {
  const calls = { acks: 0, retries: 0 };
  const message: QueueMessage = {
    jobId,
    receiveCount,
    ack: async () => {
      calls.acks += 1;
    },
    retry: async () => {
      calls.retries += 1;
    },
  };
  return { message, calls };
}

function config(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return { timeoutMs: 900_000, maxAttempts: 3, workerId: "worker-1", ...over };
}

const queuedJob: Job = {
  id: "job-1",
  inputKey: "uploads/legacy.mdb",
  status: "queued",
  attempt: 0,
};

/** Let pending microtasks and timers settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("two deliveries of the same job start only one conversion", async () => {
  // Original: both handlers read `queued`, both passed the terminal-state check, and both called
  // converter.start — the <100 ms duplicate delivery seen in testing.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter(() => 0);
  const clock = new ManualClock();

  const a = makeMessage("job-1");
  const b = makeMessage("job-1");

  await Promise.all([
    handle(a.message, store, converter, clock, config({ workerId: "worker-a" })),
    handle(b.message, store, converter, clock, config({ workerId: "worker-b" })),
  ]);

  assert.equal(converter.starts.length, 1, "the losing delivery must not start a conversion");
  assert.equal(store.snapshot("job-1").status, "succeeded");
  assert.equal(a.calls.acks + b.calls.acks, 2, "both messages are acked");
});

test("a slow attempt cannot overwrite a result published by a newer attempt", async () => {
  // Original: the late attempt's unconditional put replaced a correct result, and the job still
  // reported success — silent corruption.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter((nth) => (nth === 1 ? "hang" : 0));
  const clock = new ManualClock();

  const first = makeMessage("job-1", 1);
  const slow = handle(first.message, store, converter, clock, config({ workerId: "worker-a" }));
  await tick();

  // Redelivery after the visibility timeout: a second worker takes over and publishes.
  const second = makeMessage("job-1", 2);
  await handle(second.message, store, converter, clock, config({ workerId: "worker-b" }));

  assert.equal(store.snapshot("job-1").attempt, 2);
  assert.equal(store.snapshot("job-1").outputKey, "jobs/job-1/attempts/2/result.json");

  // Only now does the abandoned first attempt finish, and try to publish.
  converter.finish(1, 0);
  await slow;

  const final = store.snapshot("job-1");
  assert.equal(final.status, "succeeded");
  assert.equal(final.attempt, 2, "the stale attempt must not take ownership back");
  assert.equal(
    final.outputKey,
    "jobs/job-1/attempts/2/result.json",
    "the stale attempt must not replace the published result",
  );
});

test("each attempt converts into its own output key", async () => {
  // Original: every attempt was handed jobs/{id}/result.json, so attempts could overwrite one
  // another in S3 regardless of what the job record said.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter((nth) => (nth === 1 ? "hang" : 0));
  const clock = new ManualClock();

  const first = makeMessage("job-1", 1);
  const slow = handle(first.message, store, converter, clock, config());
  await tick();

  const second = makeMessage("job-1", 2);
  await handle(second.message, store, converter, clock, config());

  converter.finish(1, 0);
  await slow;

  assert.equal(converter.starts[0]?.outputKey, "jobs/job-1/attempts/1/result.json");
  assert.equal(converter.starts[1]?.outputKey, "jobs/job-1/attempts/2/result.json");
});

test("a timed-out conversion is killed and reaped", async () => {
  // Original: on timeout the subprocess was abandoned. It kept running, held memory and disk, and
  // could still write its output.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter(() => "hang");
  const clock = new ManualClock();

  const { message } = makeMessage("job-1", 1);
  const pending = handle(message, store, converter, clock, config());
  await tick();

  clock.fire(1);
  await pending;

  assert.equal(converter.kills, 1, "the subprocess must be terminated before giving up");
});

test("exit code 2 fails the job immediately without spending retries", async () => {
  // Original: an invalid database was retried three times to reach an answer already known in the
  // first seconds, delaying the caller's failure by 3x.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter(() => 2);
  const clock = new ManualClock();

  const { message, calls } = makeMessage("job-1", 1); // well below maxAttempts
  await handle(message, store, converter, clock, config());

  const final = store.snapshot("job-1");
  assert.equal(final.status, "failed");
  assert.match(final.error ?? "", /code 2/);
  assert.equal(calls.retries, 0, "a permanent failure must not be retried");
  assert.equal(calls.acks, 1);
});

test("exit code 137 is retried rather than failed", async () => {
  // Regression guard: classification must not turn transient kills into permanent failures.
  const store = new InMemoryJobStore(queuedJob);
  const converter = new FakeConverter(() => 137);
  const clock = new ManualClock();

  const { message, calls } = makeMessage("job-1", 1);
  await handle(message, store, converter, clock, config());

  assert.equal(calls.retries, 1);
  assert.equal(calls.acks, 0);
  assert.equal(store.snapshot("job-1").status, "running", "the job stays claimable for a retry");
});

test("a job already in a terminal state is acked without work", async () => {
  const store = new InMemoryJobStore({ ...queuedJob, status: "succeeded", attempt: 1 });
  const converter = new FakeConverter(() => 0);
  const clock = new ManualClock();

  const { message, calls } = makeMessage("job-1", 1);
  await handle(message, store, converter, clock, config());

  assert.equal(converter.starts.length, 0);
  assert.equal(calls.acks, 1);
});
