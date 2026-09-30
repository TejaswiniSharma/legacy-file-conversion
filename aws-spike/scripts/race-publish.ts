/**
 * A slow attempt finishes after a newer one has already published, against REAL DynamoDB.
 *
 * This is worker.test.ts test 2 with the in-memory fake swapped for the real service, and it is the
 * scenario the whole design exists to survive: the orphaned conversion cannot be stopped, so it must be
 * unable to publish.
 */
import { DynamoJobStore } from "../src/dynamo-store.ts";
import type { Job } from "../../src/worker.ts";

const store = new DynamoJobStore("itpipes-jobs");
const jobId = `race-publish-${Date.now()}`;

await store.create({ id: jobId, inputKey: "uploads/legacy.mdb", status: "queued", attempt: 0 });
console.log(`seeded ${jobId} as queued, attempt 0\n`);

// --- Attempt 1 claims, then stalls. Its read is captured and held.
const readA = (await store.get(jobId))!;
await store.compareAndSwap(
  { id: jobId, status: readA.status, attempt: readA.attempt },
  { id: jobId, inputKey: readA.inputKey, status: "running", attempt: 1, owner: "worker-a" },
);
console.log("attempt 1 claimed the job, then stalled (its conversion is still running somewhere)");

// --- The message is redelivered. Attempt 2 takes over and finishes properly.
const readB = (await store.get(jobId))!;
await store.compareAndSwap(
  { id: jobId, status: readB.status, attempt: readB.attempt },
  { id: jobId, inputKey: readB.inputKey, status: "running", attempt: 2, owner: "worker-b" },
);
console.log("attempt 2 took over as attempt 2");

const publishedB = await store.compareAndSwap(
  { id: jobId, status: "running", attempt: 2 },
  {
    id: jobId,
    inputKey: readB.inputKey,
    status: "succeeded",
    attempt: 2,
    owner: "worker-b",
    outputKey: `jobs/${jobId}/attempts/2/result.json`,
  },
);
console.log(`attempt 2 published: ${publishedB ? "OK" : "rejected"}\n`);

// --- Only now does the orphan from attempt 1 finish and try to publish its own result.
const publishedA = await store.compareAndSwap(
  { id: jobId, status: "running", attempt: 1 },
  {
    id: jobId,
    inputKey: readA.inputKey,
    status: "succeeded",
    attempt: 1,
    owner: "worker-a",
    outputKey: `jobs/${jobId}/attempts/1/result.json`,
  },
);
console.log(`attempt 1 publishes late: ${publishedA ? "WROTE (corruption)" : "rejected by the fence"}`);

if (store.lastConflict) {
  const c = store.lastConflict;
  console.log(
    `  it learned who won from the rejection itself, no second read: ` +
      `attempt=${c.attempt} owner=${c.owner}`,
  );
}

const final = (await store.get(jobId))!;
console.log(`\nstored: status=${final.status} attempt=${final.attempt} owner=${final.owner}`);
console.log(`        outputKey=${final.outputKey}`);

const safe = !publishedA && final.attempt === 2 && final.outputKey?.includes("/attempts/2/");
console.log(
  safe
    ? "\nPASS: the stale attempt could not overwrite the published result."
    : "\nFAIL: the stale attempt corrupted the record.",
);
process.exit(safe ? 0 : 1);
