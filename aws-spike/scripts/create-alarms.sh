#!/usr/bin/env bash
# The three signals from DESIGN.md §5, as real CloudWatch alarms.
# Periods are shortened from the design's 15 minutes so they can be observed in a session.
set -euo pipefail

# 1. Queue not draining. Design threshold: import > 1 hour.
aws cloudwatch put-metric-alarm \
  --alarm-name itpipes-import-queue-not-draining \
  --namespace AWS/SQS --metric-name ApproximateAgeOfOldestMessage \
  --dimensions Name=QueueName,Value=import-queue \
  --statistic Maximum --period 60 --evaluation-periods 1 \
  --threshold 3600 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching
echo "created: itpipes-import-queue-not-draining"

# 2. DLQ has anything in it at all.
aws cloudwatch put-metric-alarm \
  --alarm-name itpipes-import-dlq-not-empty \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=import-dlq \
  --statistic Maximum --period 60 --evaluation-periods 1 \
  --threshold 0 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching
echo "created: itpipes-import-dlq-not-empty"

# 3. Failure rate over 5%. Needs metric math: failed / (failed + succeeded) * 100.
aws cloudwatch put-metric-alarm \
  --alarm-name itpipes-import-failure-rate \
  --evaluation-periods 1 --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --metrics '[
    {"Id":"failed","ReturnData":false,"MetricStat":{
      "Metric":{"Namespace":"ITpipes/Conversion","MetricName":"JobOutcome",
        "Dimensions":[{"Name":"Lane","Value":"import"},{"Name":"Outcome","Value":"failed"}]},
      "Period":60,"Stat":"Sum"}},
    {"Id":"succeeded","ReturnData":false,"MetricStat":{
      "Metric":{"Namespace":"ITpipes/Conversion","MetricName":"JobOutcome",
        "Dimensions":[{"Name":"Lane","Value":"import"},{"Name":"Outcome","Value":"succeeded"}]},
      "Period":60,"Stat":"Sum"}},
    {"Id":"rate","ReturnData":true,"Label":"failure rate %",
      "Expression":"100 * FILL(failed,0) / (FILL(failed,0) + FILL(succeeded,0))"}
  ]'
echo "created: itpipes-import-failure-rate"
