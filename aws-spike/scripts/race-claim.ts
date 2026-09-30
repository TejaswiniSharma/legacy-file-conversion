/**
 * Two deliveries of the same job, arriving together, against REAL DynamoDB.
 *
 * This is worker.test.ts test 1 with the in-memory fake swapped for the real service. The fake models
 * DynamoDB by comparing and writing without awaiting in between; this checks that the model is faithful.
 */
import { DynamoJobStore } from "../src/dynamo-store.ts";
import type { Job } from "../../src/worker.ts";

const store = new DynamoJobStore("itpipes-jobs");
const jobId = `race-claim-${Date.now()}`;

const seed: Job = {
  id: jobId,
  inputKey: "uploads/legacy.mdb",
  status: "queued",
  attempt: 0,
};

await store.create(seed);
console.log(`seeded ${jobId} as queued, attempt 0\n`);

// Both workers read the job before either writes, which is exactly the <100ms duplicate delivery.
const [readA, readB] = await Promise.all([store.get(jobId), store.get(jobId)]);
console.log(`worker-a read: status=${readA!.status} attempt=${readA!.attempt}`);
console.log(`worker-b read: status=${readB!.status} attempt=${readB!.attempt}`);
console.log("both read the same state, so both believe the job is theirs to take\n");

const claim = (reader: Job, workerId: string) =>
  store.compareAndSwap(
    { id: reader.id, status: reader.status, attempt: reader.attempt },
    {
      id: reader.id,
      inputKey: reader.inputKey,
      status: "running",
      attempt: reader.attempt + 1,
      owner: workerId,
    },
  );

const [wonA, wonB] = await Promise.all([claim(readA!, "worker-a"), claim(readB!, "worker-b")]);

console.log(`worker-a claim: ${wonA ? "WON" : "rejected"}`);
console.log(`worker-b claim: ${wonB ? "WON" : "rejected"}`);

const final = await store.get(jobId);
console.log(`\nstored: status=${final!.status} attempt=${final!.attempt} owner=${final!.owner}`);

const winners = [wonA, wonB].filter(Boolean).length;
console.log(
  winners === 1
    ? "\nPASS: exactly one worker claimed the job. The loser starts no conversion."
    : `\nFAIL: ${winners} workers claimed the same job.`,
);
process.exit(winners === 1 ? 0 : 1);
