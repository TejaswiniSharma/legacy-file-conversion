# Observations: running the design against real AWS

Throwaway spike, not part of the submission. The point is to turn claims that rested on reasoning into
things actually observed, so they can be answered with evidence at the onsite.

Region `us-east-1`, table `itpipes-jobs`, on-demand billing.

---

## Hour 1: DynamoDB

### What was run

**`scripts/race-claim.ts`** reproduces `worker.test.ts` test 1 against the real service. Two workers read
the same `queued` job, both believe it is theirs, both issue a conditional claim.

```
worker-a read: status=queued attempt=0
worker-b read: status=queued attempt=0

worker-a claim: WON
worker-b claim: rejected

stored: status=running attempt=1 owner=worker-a
```

**`scripts/race-publish.ts`** reproduces test 2, the scenario the whole design exists to survive. Attempt 1
claims and stalls, attempt 2 takes over and publishes, then the orphan from attempt 1 finishes and tries
to write its own result.

```
attempt 1 claimed the job, then stalled
attempt 2 took over as attempt 2
attempt 2 published: OK

attempt 1 publishes late: rejected by the fence
  learned who won from the rejection itself, no second read: attempt=2 owner=worker-b

stored: status=succeeded attempt=2 owner=worker-b
        outputKey=jobs/.../attempts/2/result.json
```

**Why this matters.** The unit tests run against an in-memory fake that I wrote, which models DynamoDB by
comparing and writing without awaiting in between. That is an assumption about the real service. These two
scripts check the assumption holds. "How do you know your fake is faithful?" now has an answer other than
"I reasoned about it."

### What was learned

**Reserved words bite, but only in expressions.** `status` and `owner` are both DynamoDB reserved words.
Only `status` appears in the `ConditionExpression`, so only it needs an `ExpressionAttributeNames` alias
(`#s`). `owner` sits in the item body and needs nothing. The rule is about attributes referenced in
expressions, not attributes that exist.

**`ConditionalCheckFailedException.Item` comes back unmarshalled-raw.** Setting
`ReturnValuesOnConditionCheckFailure: "ALL_OLD"` hands the loser the item that beat it, so it learns who
owns the job without a second read. But it arrives as raw AttributeValues (`{ S: "worker-b" }`) even
through the DocumentClient, because it rides on the exception rather than the command output. It has to
be run through `unmarshall` by hand. First attempt printed `[object Object]`.

**PutItem, not UpdateItem.** The `JobStore` interface hands over a complete `next` Job, so the compare-
and-swap is a whole-item replace with a condition attached. That is safe here precisely because the fence
guarantees a single writer per job. With concurrent writers touching different fields, this would have to
be `UpdateItem` instead. Worth saying out loud, because it is a consequence of the fence rather than an
accident.

**A rejected conditional write still consumes a write unit.** Irrelevant at 1,000 jobs/day, but it means
losing a race is not free.

**TTL is approximate.** The attribute must be epoch seconds as a Number, and deletion happens within
roughly 48 hours of expiry rather than on the dot. So "metadata retained for 90 days" implemented as TTL
really means "90 days, then removed soon after". Fine here, would not be fine for a hard compliance
deadline.

### Data model, which NOTES.md listed as undesigned

- **Partition key `jobId`, no sort key.** One item per job.
- **No GSI in v1.** Every access path in the design is by `jobId`: the caller polls `GET /jobs/{id}`, and
  DLQ triage starts from a message that already carries the `jobId`. A GSI on status only becomes
  necessary when someone needs to list jobs without one in hand, such as a support dashboard asking for
  today's failures. That is the trigger for adding it, not a v1 requirement.
- **On-demand billing.** 1,000 jobs/day is far below the point where provisioned capacity is worth
  planning.
- **TTL on `expiresAt`** for the 90-day metadata retention, with the caveat above.

---

## Hour 2: SQS and the worker end to end

Both lanes built with the numbers from DESIGN.md §1: `import-queue` at 1200s visibility, `export-queue` at
6000s, each with a DLQ and `maxReceiveCount` 3.

### The retry boundary, observed

`scripts/redelivery.ts` sends one message and receives it repeatedly without deleting. The 20 minute
visibility timeout is too long to sit through, so an in-flight message has its visibility shortened, which
exercises the real mechanism without the wait.

```
receive 1: ApproximateReceiveCount=1
receive 2: ApproximateReceiveCount=2
receive 3: ApproximateReceiveCount=3
receive 4: nothing returned. The queue has given up on it.

import-dlq depth: 1
```

Not deleting a message really is the retry, and exceeding `maxReceiveCount` really does move it to the
DLQ rather than back onto the queue.

### The worker, against real DynamoDB and real SQS

`src/poll-loop.ts` runs the unmodified `handle()` from the submission with the real store, the real queue,
and a fake converter whose exit code comes from the input filename. All four paths behave as designed:

| Input | Result |
|---|---|
| `ok.mdb` | `succeeded` at attempt 1, `outputKey=jobs/{id}/attempts/1/result.json` |
| `corrupt.mdb` (exit 2) | `failed` at attempt 1, no retries spent |
| `oom.mdb` (exit 137) | retried as attempts 1, 2, 3, then `failed` |
| `slow.mdb` (hangs) | killed and reaped on every attempt, then `failed` |

The attempt counter increments on every claim, so each retry converts into its own key. That is the
fencing model working end to end rather than in a unit test.

### The finding worth taking to the onsite

**The DLQ never saw the exhausted job.** After `oom.mdb` burned all three attempts and was marked
`failed`, `import-dlq` was still holding only the one message from the redelivery test.

There are two exhaustion mechanisms and they overlap:

- **Application level.** `finishFailure` sees `receiveCount >= maxAttempts`, marks the job `failed` with
  the reason, and acks.
- **Queue level.** SQS moves a message to the DLQ once it exceeds `maxReceiveCount`.

Both are set to 3, so the application always wins. It acks on the third receive, and SQS never gets a
fourth to redrive.

That is arguably the right behaviour: a caller polling the API sees `failed` with a reason, rather than
the job vanishing silently into a DLQ. But it changes what the DLQ alarm in §5 actually means. **It is not
"a job exhausted its retries". It is "a worker died before it could record the outcome"** — a task
OOM-killed, or stopped mid-flight by a deploy. That makes it a signal about worker health, not about job
failure, and the action on it should say so.

DESIGN.md §4's worker diagram shows the exhaustion path leading to the DLQ, which reads as though that is
the normal route. It is not. Building it surfaced the gap; the fix is either to describe the DLQ as the
crash safety net it actually is, or to raise `maxAttempts` above `maxReceiveCount` so the queue really
does own exhaustion.

### Metrics and alarms

The worker now emits a count on every terminal state, and all three §5 signals exist as real alarms.

**Where the metric is emitted.** From the poll loop, not from `handle()`. §5 says "emitted by the worker",
but putting the call inside `handle()` would give the submitted worker an AWS dependency and stop its
tests running without credentials. The task is the honest place for it.

**Driving it.** Submitted 8 `corrupt.mdb` and 2 `ok.mdb`, so the expected failure rate is 80%. CloudWatch
agreed:

```
JobOutcome / failed     8.0
JobOutcome / succeeded  2.0
metric math "rate"      80.0
```

**All three alarms observed in the right state:**

```
itpipes-import-dlq-not-empty       ALARM  1 datapoint [1.0]  > threshold 0.0
itpipes-import-failure-rate        ALARM  1 datapoint [80.0] > threshold 5.0
itpipes-import-queue-not-draining  OK     1 datapoint [0.0]  not > threshold 3600.0
```

The failure-rate alarm went from `INSUFFICIENT_DATA` to `ALARM` about two minutes after the jobs ran. The
queue-age alarm lagged the other two by a further minute before settling to `OK`, which is worth knowing:
**alarm state is not immediate, so a dashboard checked seconds after an incident starts still looks
fine.**

**What the failure-rate alarm actually took.** It is not a threshold on one metric, it is metric math over
two series:

```
100 * FILL(failed,0) / (FILL(failed,0) + FILL(succeeded,0))
```

Two things this forced:

- **Metric math can only reference series it can name exactly.** There is no wildcard for a dimension, so
  a series carrying `Lane + Outcome + ErrorClass` cannot be summed across error classes inside the
  expression. That is why the worker emits two metrics: `JobTerminal` with the error class for
  dashboards, and `JobOutcome` without it, purely so the alarm can divide one by the other.
- **`FILL(x, 0)` is doing real work.** Metric math returns no data for a period where an input series has
  no datapoint. Without `FILL`, a minute with failures but zero successes would produce *nothing* rather
  than 100%, so the alarm would stay quiet during exactly the incident it exists to catch.

**`--treat-missing-data notBreaching` matters.** These queues are idle most of the time, so most periods
have no data at all. Without it the alarms sit in `INSUFFICIENT_DATA` rather than `OK`, which is hard to
read on a dashboard.

**Periods were shortened to 60 seconds** so the alarms could be watched inside a session. The design says
a rolling 15 minutes, which is the right window for real traffic.

---

## Fargate: the deployment leg

The unmodified `handle()` from the submission ran as a container on Fargate, against real DynamoDB and
SQS, emitting real metrics, logging to CloudWatch. Both a success and a permanent failure processed
correctly on the first task launch.

```
17:01:04 polling import-queue as import-worker-1 (one job at a time)
17:01:07 received ok-...           -> status=succeeded attempt=1  metric: Outcome=succeeded
17:01:08 received corrupt-...      -> status=failed attempt=1     metric: Outcome=failed ErrorClass=permanent
```

### What it took

`scripts/deploy.sh` is the §5 pipeline done by hand: build, push to ECR, register a task definition,
run a task. Before it could run, six things had to exist:

| Piece | What it is |
|---|---|
| ECR repository | where the image lives |
| ECS cluster | a logical grouping, nothing more |
| Log group | `/ecs/itpipes-worker`, 1-day retention |
| **Execution role** | what ECS needs to *start* the task: pull the image, write logs |
| **Task role** | what the *worker code* needs while running: DynamoDB, SQS, `PutMetricData` |
| Task definition | 1 vCPU / 4 GB, the image, the command, both roles, `stopTimeout` 120 |

### Cold start, measured

DESIGN.md estimated 30 to 60 seconds. The real breakdown for an 80 MB image:

```
created -> pull started   14s   Fargate provisioning the network interface and capacity
image pull                 6s   no cross-task cache, every task pulls fresh
pull -> code running       2s
TOTAL                     21s
```

Two consequences. First, provisioning dominates, not the pull, so a smaller image buys less than it
looks like it should. Second, this is the *import* image at 80 MB with no JVM. The shared image from D2
would carry the vendor JVM and JAR as well, so the pull would grow several-fold while the 14s of
provisioning stayed fixed. That is the real shape of the one-image tradeoff: it costs seconds per task
launch, not minutes, and only on the pull line.

### What was learned

**The two roles are different principals, and confusing them is the classic first-timer failure.** The
execution role is ECS acting on your behalf before your code exists. The task role is your code's own
identity once it is running. DynamoDB permissions on the execution role do nothing; the container never
assumes it. The task role here is least-privilege: `GetItem` and `PutItem` on one table, four SQS actions
on `*-queue`, and `PutMetricData` locked to the `ITpipes/Conversion` namespace.

**Architecture mismatch is silent until it is not.** This Mac is Apple Silicon; Fargate is x86 by
default. A native `docker build` produces an arm64 image that Fargate accepts, registers, and then fails
to start with an unhelpful exec error. The deploy script builds `--platform linux/amd64` up front. The
alternative is declaring `ARM64` in the task definition and running on Graviton, which is cheaper.

**No NAT gateway was needed.** Default VPC, public subnet, `assignPublicIp=ENABLED`. The task pulls
from ECR and reaches DynamoDB and SQS over its public IP. A NAT gateway would bill about $32 a month
whether or not anything runs, which is the single easiest way to turn a free experiment into a surprise
invoice. Production would more likely use private subnets with VPC endpoints for ECR, DynamoDB and SQS,
which also avoids the NAT.

**The SDK needed no configuration to find the task role.** The credential provider chain picks it up
from the container's metadata endpoint. The same `DynamoJobStore` and `SqsQueueMessage` that ran on the
laptop with a local profile ran in the container with the task role, unchanged.

**`docker init` in the wrong directory.** It was run in the submitted repo and generated a Dockerfile,
compose file and two others there. They were untracked, so nothing reached the public repo, but a
`git add -A` would have pushed generated boilerplate to the link the reviewers hold. Removed. Worth a
habit: check `pwd` before running anything that writes files.

### Autoscaling: the full cycle worked, and the lag is the finding

Built: `import-svc` at `desiredCount` 0, a scalable target of 0 to 10, step-scaling policies on queue
depth (1-4 messages to 1 task, 4-20 to 3, 20+ to 8), scale-in back to zero after three quiet minutes, and
two alarms driving them.

Six jobs submitted. The fleet scaled itself from zero, drained the queue, and scaled back:

```
01:31:29 UTC  6 jobs submitted, queue depth 6
01:33     ~   alarm still OK: "no datapoints were received for 1 period
                and 1 missing datapoint was treated as [NonBreaching]"
01:39:00      alarm ALARM: "1 datapoint [6.0] was greater than the threshold (0.0)"
01:41:36      desiredCount = 3
later         all six jobs succeeded at attempt 1, owner import-worker-1
              queue depth 0, desiredCount 0, runningCount 0
```

`desiredCount` 3 is exactly what the step configuration specifies: a breach of 6 over a threshold of 0
falls in the [4, 20) band, whose `ExactCapacity` is 3. Scale from zero, process, scale back to zero, with
nobody driving it.

**A second run, 22 jobs, watched end to end:**

```
14:37:42   22 jobs submitted (18 ok, 4 corrupt), queue depth 22
14:38:22   tasks 0/0, queue 22, both alarms OK    <- the wait
14:40:35   desiredCount 8, running 0              <- scaled out, top step band
14:41:08   running 8, queue 0                     <- provisioned AND drained
14:41:41   failure-rate alarm also ALARM (18%)
14:45:06   backlog-empty alarm ALARM (queue <= 0 for 3 periods)
14:45:38   desiredCount 0, runningCount 0        <- scaled back in
```

Eight minutes, submit to fully idle, with nobody driving it. All 22 jobs landed correctly: 18 succeeded
and 4 failed on the permanent path, confirmed against the job table (26 rows before, 48 after).

Scale-in is worth one caveat. It fired because SQS was still publishing zeros shortly after the drain.
The `backlog-empty` alarm uses `treatMissingData=notBreaching`, so if the queue went quiet long enough
for SQS to stop publishing altogether, the alarm would stop breaching and the fleet would stay up. For a
"queue is empty, scale down" alarm, missing data arguably *should* be treated as breaching, since silence
from an idle queue is the condition you are scaling in for. Not observed here, and the immediate
post-drain path works, but it is the wrong default for the direction this alarm points.

`ExactCapacity` 8 is the `[20, inf)` band, as configured. And the ratio is the thing to notice:
**about 3 minutes of waiting, 33 seconds of working** — and most of those 33 seconds was Fargate
provisioning, not conversion. Twenty-two fake conversions at ~300ms across 8 tasks is under 2 seconds of
actual work. The system spent roughly a hundred times longer getting ready than doing the job.

That is tolerable only because A1 says nothing is waiting. It is also the clearest possible argument for
why a latency KPI would force warm capacity instead of scale-from-zero.

**The lag is variable, not fixed.** The first run took about ten minutes to scale; this one took three.
The difference is where the burst lands in SQS's publication cycle, plus the fact that freshly created
alarms are slower on their first evaluation. The honest statement is "minutes, variable, bounded below by
how often SQS publishes" — not a single number. I had quoted eight minutes as though it were a constant
after seeing it once.

**The finding is that wait.** On the first run, roughly eight minutes passed before a usable datapoint
existed. At 90 seconds the alarm was still reporting *no datapoints*.

Confirmed afterwards: a three-hour window at a 60-second period returned **zero datapoints** for an idle
queue. SQS does not publish queue-depth metrics continuously, so most one-minute periods contain nothing
at all, and `treatMissingData=notBreaching` reads each empty period as "the queue is fine".

A 300-second period would match the publication cadence and stop the alarm flapping on missing data, but
it would not make the reaction meaningfully faster. **Scale-out cannot react faster than SQS publishes**,
so the floor is minutes, not seconds, however the alarm is tuned. Add the 21-second cold start on top.

That is fine under A1, where nothing has a deadline, and under A2, where the overnight burst has hours.
But it means **queue-depth scaling alone can never satisfy a completion-latency KPI** — the exact future
requirement A1 flags. Meeting a p95 target would need warm capacity rather than scale-from-zero, which
inverts the cost argument in §6.

**Three corrections to my own readings, recorded because the mistakes are instructive:**

- When `backlog-empty` showed OK, I took it as evidence CloudWatch could see depth > 0. With
  `notBreaching`, OK is also what a missing datapoint produces, so both alarms were consistent with no
  data at all, and I read one as confirmation.
- Seeing no scale-out at 90 seconds, I concluded autoscaling had failed. It had not; it was waiting for
  its first datapoint. **A 90-second horizon cannot distinguish "broken" from "not yet".**
- Checking afterwards, I found no `succeeded` lines in the logs and nearly concluded the scaled tasks had
  done nothing. The log group has 1-day retention and this was the following day. **Absence in a
  short-retention log is not evidence.** The DynamoDB records, with their 90-day TTL, held the answer.

### Timeout defaults corrected

The worker ran with a 5-second job timeout on both lanes, a demo shortcut so a hung conversion could be
watched without waiting a quarter of an hour. It was commented, but it was still the default, and a
default that contradicts the design is the kind of thing a reviewer finds.

Now the defaults are the design's ceilings — 15 minutes for imports, 90 for exports, both below their
queue's visibility timeout — and `JOB_TIMEOUT_MS` overrides them for demos. The real number is the
default; the demo number is the exception.

### Not built

Nothing further. Earlier this section said the ECS **service** and **autoscaling** were missing. This was a single `run-task`, which exits after its poll window.
A service would keep N tasks alive and is where the queue-depth scaling policy attaches. That is the last
gap NOTES.md names and the natural next step.

### Smaller notes

- `retry()` is implemented as `ChangeMessageVisibility`, not as a no-op. The design says retries come from
  not deleting and letting visibility expire; setting it explicitly does the same thing sooner, and the
  delay is the natural home for the backoff NOTES.md lists as unimplemented.
- Node's strip-only TypeScript mode rejects constructor parameter properties. Hit it twice, once in the
  submission's tests and once here. Worth remembering when using this zero-install setup.
- Total cost of both hours: a few dozen DynamoDB writes and a few dozen SQS calls. Effectively nothing,
  but `scripts/teardown.sh` removes the table and all four queues.
