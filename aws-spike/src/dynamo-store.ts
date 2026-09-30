import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import type { Job, JobStatus, JobStore } from "../../src/worker.ts";

const RETENTION_DAYS = 90;

/**
 * The real backing for the JobStore seam.
 *
 * `compareAndSwap` is a PutItem carrying a ConditionExpression. PutItem rather than UpdateItem because
 * the interface hands over a complete `next` Job, so this is a whole-item replace. That is safe here
 * precisely because the fence guarantees only one writer owns a job at a time; with concurrent writers
 * touching different fields you would want UpdateItem instead.
 */
export class DynamoJobStore implements JobStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  /**
   * The item that beat the most recent rejected write, straight from the failed call. Populated by
   * ReturnValuesOnConditionCheckFailure, so a loser learns who owns the job without a second read.
   */
  lastConflict: Record<string, unknown> | undefined;

  constructor(tableName: string, region = "us-east-1") {
    this.tableName = tableName;
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(id: string): Promise<Job | undefined> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { jobId: id },
        ConsistentRead: true,
      }),
    );
    return out.Item ? toJob(out.Item) : undefined;
  }

  async compareAndSwap(
    expected: { id: string; status: JobStatus; attempt: number },
    next: Job,
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(next),
          // `status` and `owner` are both DynamoDB reserved words, so they have to be aliased.
          ConditionExpression: "#s = :expectedStatus AND attempt = :expectedAttempt",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":expectedStatus": expected.status,
            ":expectedAttempt": expected.attempt,
          },
          // Hands back the item that beat us, so we learn who owns the job without a second read.
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      this.lastConflict = undefined;
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        // Lost the race. Anything else is a real failure and must not be mistaken for one.
        //
        // The returned Item arrives as raw DynamoDB AttributeValues ({ S: "..." }, { N: "..." }) even
        // through the DocumentClient, because it rides on the exception rather than the command output.
        // It has to be unmarshalled by hand.
        this.lastConflict = error.Item ? unmarshall(error.Item) : undefined;
        return false;
      }
      throw error;
    }
  }

  /** Seeds a brand new job. Fails if the id already exists, which is submission-level idempotency. */
  async create(job: Job): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(job),
          ConditionExpression: "attribute_not_exists(jobId)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}

/** Reads the item that beat us out of a rejected write, when the SDK surfaces it. */
export function itemThatWon(error: unknown): Record<string, unknown> | undefined {
  return error instanceof ConditionalCheckFailedException ? error.Item : undefined;
}

function toItem(job: Job): Record<string, unknown> {
  return {
    jobId: job.id,
    inputKey: job.inputKey,
    status: job.status,
    attempt: job.attempt,
    owner: job.owner,
    outputKey: job.outputKey,
    error: job.error,
    // TTL wants epoch SECONDS as a Number. Deletion happens within roughly 48 hours of this time,
    // not on the dot, so "retained for 90 days" really means "90 days, then removed soon after".
    expiresAt: Math.floor(Date.now() / 1000) + RETENTION_DAYS * 24 * 60 * 60,
  };
}

function toJob(item: Record<string, unknown>): Job {
  return {
    id: item.jobId as string,
    inputKey: item.inputKey as string,
    status: item.status as JobStatus,
    attempt: Number(item.attempt),
    owner: item.owner as string | undefined,
    outputKey: item.outputKey as string | undefined,
    error: item.error as string | undefined,
  };
}
