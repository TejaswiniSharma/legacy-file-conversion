/**
 * Stands in for the API Gateway + Lambda ingest: write the job record, then enqueue.
 *
 * Record first, then enqueue. The other order lets a worker receive the message before the job exists.
 *
 *   node --experimental-strip-types scripts/submit-job.ts ok
 *   node --experimental-strip-types scripts/submit-job.ts corrupt
 *   node --experimental-strip-types scripts/submit-job.ts oom
 *   node --experimental-strip-types scripts/submit-job.ts slow
 */
import { SQSClient, SendMessageCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

import { DynamoJobStore } from "../src/dynamo-store.ts";

const kind = process.argv[2] ?? "ok";
const lane = process.argv[3] ?? "import";

const sqs = new SQSClient({ region: "us-east-1" });
const store = new DynamoJobStore("itpipes-jobs");

const jobId = `${kind}-${Date.now()}`;
const inputKey = `uploads/${kind}.mdb`;

const created = await store.create({ id: jobId, inputKey, status: "queued", attempt: 0 });
if (!created) {
  console.error(`job ${jobId} already exists`);
  process.exit(1);
}

const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: `${lane}-queue` }))).QueueUrl!;
await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ jobId }) }));

console.log(`submitted ${jobId} (${inputKey}) to ${lane}-queue`);
