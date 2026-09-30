#!/usr/bin/env bash
# The two roles a Fargate task needs. They are different principals and the distinction matters:
#
#   execution role - AWS acting on your behalf BEFORE your code exists, to pull the image and
#                    set up logging. Your container never assumes it.
#   task role      - your code's own identity once running. This is what reaches DynamoDB and SQS.
#
# Database permissions on the execution role do nothing at all.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

aws iam create-role --role-name itpipes-ecs-execution \
  --assume-role-policy-document file://iam/trust-ecs-tasks.json \
  --query 'Role.Arn' --output text
aws iam attach-role-policy --role-name itpipes-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
echo "execution role ready"

# worker-policy.json is a template: the account id is not committed.
RENDERED=$(mktemp -t itpipes-policy)
sed "s|\${AWS_ACCOUNT_ID}|$ACCOUNT|g" iam/worker-policy.json > "$RENDERED"

aws iam create-role --role-name itpipes-worker-task \
  --assume-role-policy-document file://iam/trust-ecs-tasks.json \
  --query 'Role.Arn' --output text
aws iam put-role-policy --role-name itpipes-worker-task \
  --policy-name worker-least-privilege --policy-document "file://$RENDERED"
echo "task role ready (least privilege: one table, four queue actions, one metric namespace)"
