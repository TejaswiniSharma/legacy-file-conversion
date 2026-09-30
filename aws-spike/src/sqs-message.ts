import {
  SQSClient,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";

import type { QueueMessage } from "../../src/worker.ts";

/**
 * The real backing for the QueueMessage seam.
 *
 * `ack` deletes the message. `retry` shortens its visibility so it comes back sooner.
 *
 * The design says retries come from *not deleting* and letting visibility expire, which would make
 * `retry` a no-op. Setting the visibility explicitly does the same thing sooner, and the delay is the
 * natural place to put the backoff that NOTES.md lists as not implemented. With a delay of 0 the
 * redelivery is immediate, which is what makes an end-to-end run observable inside a minute rather than
 * twenty.
 */
export class SqsQueueMessage implements QueueMessage {
  readonly jobId: string;
  readonly receiveCount: number;

  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  private readonly receiptHandle: string;
  private readonly retryDelaySeconds: number;

  constructor(sqs: SQSClient, queueUrl: string, message: Message, retryDelaySeconds = 0) {
    this.sqs = sqs;
    this.queueUrl = queueUrl;
    this.receiptHandle = message.ReceiptHandle!;
    this.retryDelaySeconds = retryDelaySeconds;
    this.jobId = JSON.parse(message.Body!).jobId;
    this.receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
  }

  async ack(): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: this.receiptHandle }),
    );
  }

  async retry(): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: this.receiptHandle,
        VisibilityTimeout: this.retryDelaySeconds,
      }),
    );
  }
}
