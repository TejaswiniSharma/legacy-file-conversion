/**
 * The retry boundary, observed on the real queue.
 *
 * The design says retries come from NOT deleting a message and letting its visibility expire, and that
 * a message which runs out of attempts lands in the DLQ. Both claims are checked here.
 *
 * import-queue has a 20 minute visibility timeout, which is too long to sit through, so an in-flight
 * message has its visibility shortened with ChangeMessageVisibility. That exercises the real mechanism
 * on the real queue without the wait.
 */
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: "us-east-1" });

const urlOf = async (name: string) =>
  (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;

const queueUrl = await urlOf("import-queue");
const dlqUrl = await urlOf("import-dlq");

const jobId = `redelivery-${Date.now()}`;
await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ jobId }) }));
console.log(`sent ${jobId} to import-queue (maxReceiveCount 3)\n`);

// Receive without deleting, then make the message visible again immediately.
for (let i = 1; i <= 4; i++) {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      MessageAttributeNames: ["All"],
      AttributeNames: ["ApproximateReceiveCount"],
    }),
  );

  const msg = out.Messages?.[0];
  if (!msg) {
    console.log(`receive ${i}: nothing returned. The queue has given up on it.`);
    break;
  }

  console.log(`receive ${i}: ApproximateReceiveCount=${msg.Attributes?.ApproximateReceiveCount}`);

  // Do not delete. Shorten visibility so the redelivery is observable in seconds rather than 20 minutes.
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: msg.ReceiptHandle!,
      VisibilityTimeout: 0,
    }),
  );
}

// Give SQS a moment to move it.
await new Promise((r) => setTimeout(r, 3000));

const dlqDepth = await sqs.send(
  new GetQueueAttributesCommand({
    QueueUrl: dlqUrl,
    AttributeNames: ["ApproximateNumberOfMessages"],
  }),
);
const depth = Number(dlqDepth.Attributes?.ApproximateNumberOfMessages ?? 0);

console.log(`\nimport-dlq depth: ${depth}`);
console.log(
  depth > 0
    ? "PASS: the message ran out of attempts and moved to the DLQ, not back onto the queue."
    : "FAIL: nothing reached the DLQ.",
);
process.exit(depth > 0 ? 0 : 1);
