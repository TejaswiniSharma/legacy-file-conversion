#!/usr/bin/env bash
# Build the image, push it to ECR, register the task definition, run ONE task.
# This is the deployment pipeline from DESIGN.md §5, done by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/itpipes-worker
# Tagged by commit, per DESIGN.md section 5. A moving "latest" tag means two task-definition
# revisions can resolve to different images over time, so a rollback is not reproducible.
TAG=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)
# Derived rather than committed, so this runs in any account.
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query "Vpcs[0].VpcId" --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true \
          --query "Subnets[0].SubnetId" --output text)
SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=default \
      --query "SecurityGroups[0].GroupId" --output text)

echo "=== build (linux/amd64: Fargate is x86 by default, this Mac is arm64) ==="
docker build --platform linux/amd64 -t itpipes-worker:latest . 2>&1 | tail -3

echo "=== push ==="
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REPO >/dev/null
# Braces matter: in zsh, "$REPO:latest" triggers the :l history modifier and pushes to a
# mangled repository name that looks like it succeeded.
docker tag itpipes-worker:latest "${REPO}:${TAG}"
docker push "${REPO}:${TAG}" 2>&1 | tail -2

echo "=== register task definition ==="
# task-def-import.json is a template: the account id is not committed.
RENDERED=$(mktemp -t itpipes-taskdef)
sed -e "s|\${AWS_ACCOUNT_ID}|$ACCOUNT|g" -e "s|\${IMAGE_TAG}|$TAG|g" task-def-import.json > "$RENDERED"
aws ecs register-task-definition --cli-input-json "file://$RENDERED" \
  --query 'taskDefinition.[family,revision,cpu,memory]' --output text

echo "=== run one task (public subnet, public IP: no NAT gateway needed) ==="
TASK=$(aws ecs run-task \
  --cluster itpipes \
  --launch-type FARGATE \
  --task-definition itpipes-import-worker \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
echo "task: ${TASK##*/}"
