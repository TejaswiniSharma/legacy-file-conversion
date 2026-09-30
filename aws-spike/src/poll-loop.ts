/**
 * The task's poll loop, which the exercise deliberately left out of the starter.
 *
 * One message in flight at a time, per D1: the batch limit of ReceiveMessage is not a concurrency
 * setting, and at ~2 GB per conversion a task can only run one.
 */
import { SQSClient, ReceiveMessageCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

import { handle } from "../../src/worker.ts";
import { DynamoJobStore } from "./dynamo-store.ts";
import { SqsQueueMessage } from "./sqs-message.ts";
import { FakeConverter, RealClock } from "./fake-converter.ts";
import { recordTerminal, classify } from "./metrics.ts";
import type { WorkerConfig } from "../../src/worker.ts";

const REGION = "us-east-1";
const sqs = new SQSClient({ region: REGION });
const store = new DynamoJobStore("itpipes-jobs", REGION);
const converter = new FakeConverter();
const clock = new RealClock();

const lane = process.argv[2] ?? "import";

// The ceilings from DESIGN.md §1, which sit below each lane's queue visibility timeout (20 and 100
// minutes) so a retry never begins while an attempt is legitimately still running.
//
// JOB_TIMEOUT_MS overrides them. A demo needs to watch a hung conversion get killed and reaped without
// waiting a quarter of an hour, but the default has to be the real number, not the demo one.
const LANE_TIMEOUT_MS: Record<string, number> = {
  import: 15 * 60_000,
  export: 90 * 60_000,
};

const timeoutMs = Number(process.env.JOB_TIMEOUT_MS) || LANE_TIMEOUT_MS[lane] || LANE_TIMEOUT_MS.import!;

const config: WorkerConfig =
  lane === "export"
    ? { timeoutMs, maxAttempts: 3, workerId: "export-worker-1", resultFilename: "package.zip" }
    : { timeoutMs, maxAttempts: 3, workerId: "import-worker-1", resultFilename: "result.json" };

const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: `${lane}-queue` }))).QueueUrl!;
console.log(`polling ${lane}-queue as ${config.workerId} (one job at a time)\n`);

// POLL_SECONDS=0 means run forever, which is what an ECS service expects. A task that exits on its own
// looks like a crash to the service, which replaces it, forever.
const pollSeconds = Number(process.env.POLL_SECONDS ?? 60);
const deadline = pollSeconds === 0 ? Infinity : Date.now() + pollSeconds * 1000;

/**
 * ECS sends SIGTERM on scale-in and on deploys, then SIGKILLs after stopTimeout (120s maximum).
 * Stop taking new work, let the job in flight finish, then exit.
 *
 * Caveat worth stating: this only works here because the fake converter yields to the event loop. The
 * real import converter is an in-process library that blocks the Node thread, so a real import worker
 * would never run this handler. That is exactly DD2 in the working notes.
 */
let draining = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (draining) return;
    draining = true;
    console.log(`${signal} received: draining, will exit after the current job`);
  });
}
while (Date.now() < deadline && !draining) {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      AttributeNames: ["ApproximateReceiveCount"],
    }),
  );

  const raw = out.Messages?.[0];
  if (!raw) continue;

  const message = new SqsQueueMessage(sqs, queueUrl, raw);
  console.log(`received ${message.jobId} (receiveCount=${message.receiveCount})`);

  await handle(message, store, converter, clock, config);

  const after = await store.get(message.jobId);
  console.log(
    `  -> status=${after?.status} attempt=${after?.attempt}` +
      (after?.outputKey ? ` outputKey=${after.outputKey}` : "") +
      (after?.error ? ` error="${after.error}"` : ""),
  );

  if (after) {
    await recordTerminal(lane, after);
    if (after.status === "succeeded" || after.status === "failed") {
      console.log(`     metric: Outcome=${after.status} ErrorClass=${classify(after)}`);
    }
  }
}

console.log(draining ? "\ndrained cleanly, exiting" : "\npoll window closed");
