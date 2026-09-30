#!/usr/bin/env bash
# DLQs first, then the main queues with a redrive policy pointing at them.
set -euo pipefail

create_lane() {
  local lane=$1 visibility=$2
  local dlq_url dlq_arn

  dlq_url=$(aws sqs create-queue --queue-name "${lane}-dlq" --query QueueUrl --output text)
  dlq_arn=$(aws sqs get-queue-attributes --queue-url "$dlq_url" \
              --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  aws sqs create-queue --queue-name "${lane}-queue" \
    --attributes "{\"VisibilityTimeout\":\"${visibility}\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
    --query QueueUrl --output text
}

# Visibility sits above each lane's job timeout, so a retry never starts while an attempt is running.
echo "import: $(create_lane import 1200)"   # 20 min, against a ~15 min job ceiling
echo "export: $(create_lane export 6000)"   # 100 min, against a ~90 min job ceiling
