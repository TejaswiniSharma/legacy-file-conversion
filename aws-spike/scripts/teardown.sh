#!/usr/bin/env bash
# Removes everything this spike created. Run at the end of hour 2.
set -u
aws dynamodb delete-table --table-name itpipes-jobs --output text --query 'TableDescription.TableStatus' 2>&1
for q in import-queue import-dlq export-queue export-dlq; do
  url=$(aws sqs get-queue-url --queue-name "$q" --query QueueUrl --output text 2>/dev/null) \
    && aws sqs delete-queue --queue-url "$url" && echo "deleted $q"
done
aws cloudwatch delete-alarms --alarm-names \
  itpipes-import-queue-not-draining itpipes-import-dlq-not-empty itpipes-import-failure-rate \
  2>/dev/null && echo "deleted 3 alarms"
# Autoscaling and the service. Order matters: scale to 0, delete the service, then deregister
# the scalable target (it outlives the service otherwise).
aws application-autoscaling delete-scaling-policy --service-namespace ecs \
  --resource-id service/itpipes/import-svc --scalable-dimension ecs:service:DesiredCount \
  --policy-name import-scale-out 2>/dev/null && echo "deleted scale-out policy"
aws application-autoscaling delete-scaling-policy --service-namespace ecs \
  --resource-id service/itpipes/import-svc --scalable-dimension ecs:service:DesiredCount \
  --policy-name import-scale-in 2>/dev/null && echo "deleted scale-in policy"
aws application-autoscaling deregister-scalable-target --service-namespace ecs \
  --resource-id service/itpipes/import-svc --scalable-dimension ecs:service:DesiredCount \
  2>/dev/null && echo "deregistered scalable target"
aws cloudwatch delete-alarms --alarm-names \
  itpipes-import-backlog-present itpipes-import-backlog-empty 2>/dev/null && echo "deleted scaling alarms"
aws ecs update-service --cluster itpipes --service import-svc --desired-count 0 >/dev/null 2>&1
aws ecs delete-service --cluster itpipes --service import-svc --force >/dev/null 2>&1 && echo "deleted import-svc"
# Fargate
aws ecs list-tasks --cluster itpipes --query 'taskArns[]' --output text 2>/dev/null | tr '\t' '\n' | while read -r t; do
  [ -n "$t" ] && aws ecs stop-task --cluster itpipes --task "$t" >/dev/null && echo "stopped task ${t##*/}"
done
aws ecs delete-cluster --cluster itpipes --query 'cluster.status' --output text 2>/dev/null && echo "deleted cluster"
aws ecr delete-repository --repository-name itpipes-worker --force >/dev/null 2>&1 && echo "deleted ECR repo + images"
aws logs delete-log-group --log-group-name /ecs/itpipes-worker 2>/dev/null && echo "deleted log group"
for r in itpipes-ecs-execution itpipes-worker-task; do
  aws iam detach-role-policy --role-name $r --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy 2>/dev/null
  aws iam delete-role-policy --role-name $r --policy-name worker-least-privilege 2>/dev/null
  aws iam delete-role --role-name $r 2>/dev/null && echo "deleted role $r"
done
echo "--- remaining:"
aws dynamodb list-tables --query TableNames --output text
aws sqs list-queues --query QueueUrls --output text
