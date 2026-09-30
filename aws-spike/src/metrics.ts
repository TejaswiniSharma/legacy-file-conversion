import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import type { Job } from "../../src/worker.ts";

export const NAMESPACE = "ITpipes/Conversion";

const cw = new CloudWatchClient({ region: "us-east-1" });

/**
 * Emitted by the task, not by `handle()`.
 *
 * DESIGN.md §5 says "custom metric emitted by the worker on every terminal state, split by lane and
 * error class". Putting the call in the poll loop rather than inside `handle()` keeps the submitted
 * worker free of an AWS dependency and keeps its tests able to run with no credentials, which matters
 * more than being literal about where the line sits.
 */
export type ErrorClass = "none" | "permanent" | "transient";

/** Reads the class back off the recorded error, the same split the worker used to decide retries. */
export function classify(job: Job): ErrorClass {
  if (job.status !== "failed") return "none";
  return job.error?.includes("code 2") ? "permanent" : "transient";
}

export async function recordTerminal(lane: string, job: Job): Promise<void> {
  if (job.status !== "succeeded" && job.status !== "failed") return;

  await cw.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: "JobTerminal",
          Value: 1,
          Unit: "Count",
          Timestamp: new Date(),
          Dimensions: [
            { Name: "Lane", Value: lane },
            { Name: "Outcome", Value: job.status },
            { Name: "ErrorClass", Value: classify(job) },
          ],
        },
        // A second series carrying only Lane and Outcome. The failure-rate alarm needs to divide
        // failures by the total, and metric math can only reference series it can name exactly, so the
        // ErrorClass dimension has to be absent rather than wildcarded.
        {
          MetricName: "JobOutcome",
          Value: 1,
          Unit: "Count",
          Timestamp: new Date(),
          Dimensions: [
            { Name: "Lane", Value: lane },
            { Name: "Outcome", Value: job.status },
          ],
        },
      ],
    }),
  );
}
