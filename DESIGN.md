# Design Review: Legacy File Conversion Service

## 1. Architecture

Imports and exports have almost nothing in common. An import takes seconds to minutes and produces at
most 500 MB of JSON from an in-process TypeScript library. An export takes tens of minutes and produces
a 10–40 GB package from a vendor JVM subprocess. So they get their own queues, their own ECS services
and their own task definitions.

They do share one repository and one container image, because the code that must never diverge is the
job lifecycle, not the converter.

```
                              ┌── import-queue ──→ import-svc ──┐
  caller → API Gateway        │     └─ import-dlq   (Fargate)   │
             ↓                │                                 ├──→ S3 (results)
           Lambda ──→ enqueue ─┤                                 │
             ↓                │                                 │
          DynamoDB            └── export-queue ──→ export-svc ──┘
        (job metadata)              └─ export-dlq   (Fargate)
```

| Component | Choice | Why |
|---|---|---|
| Ingest | API Gateway + Lambda | Validates the request, writes a job row, enqueues. File bytes never pass through it, because callers submit S3 references. At ~1,000 jobs/day this is nowhere near a constraint. |
| Job metadata | DynamoDB | The single source of truth for job state. TTL gives the 90-day retention for free. |
| Work distribution | Two SQS queues, one DLQ each | A queue has only one visibility timeout, and the two lanes need different ones. |
| Compute | ECS Fargate, two services | Lambda cannot run a 40-minute export at any configuration. Fargate has no runtime ceiling, gives the vendor JVM a real process model, and scales to zero. |
| Results | S3 under `jobs/{jobId}/…` | Durable, cheap, and callers already speak S3. |
| Scaling | Queue depth per lane, from zero | Volume is bursty and mostly idle. Cold start does not matter against jobs measured in minutes. |

### The two lanes

| | `import-worker` | `export-worker` |
|---|---|---|
| Reads | one Access DB, 10 MB–2 GB | JSON + media map → tens of GB of video and images |
| Produces | ≤500 MB JSON | 10–40 GB zip |
| Duration | seconds to several minutes | tens of minutes |
| Converter | TypeScript library, in-process | vendor JVM subprocess |
| CPU / memory | 1 vCPU / 4 GB | 8 GB; vCPU deferred pending measurement |
| Ephemeral storage | 20 GB (default) | ~200 GB — the default cannot hold the package |
| Job timeout | ~15 min | ~90 min |
| Queue visibility timeout | ~20 min | ~100 min |
| **Jobs in flight per task** | **1** | **1** |
| Share of ~1,000/day | ~800 | ~200 |

Share a queue and a task definition, and every row above has to collapse into a single number. That is
the argument for splitting, and it is easier to see as a table than to explain.

### Three choices worth defending

**Two queues, not one.** A queue has exactly one visibility timeout. Set it to 90 minutes so exports can
finish, and a crashed import sits invisible for 90 minutes before anyone retries it. Set it to 15 minutes
so imports recover quickly, and a 40-minute export gets redelivered while it is still running, putting two
workers on the same job. There is no value that works for both. Fargate's 20 GB default disk, against
10–40 GB packages, points the same way.

**One image, two task definitions.** Configuration lives in the task definition, not in the image, so the
same bytes can run with different CPU, memory, disk, entry point, queue and IAM role. Sharing the image
keeps a single copy of the code that must not diverge: claiming a job, changing its state, publishing its
result. Two copies of that is how one of them quietly goes wrong. The cost is that import tasks carry a
JVM they never run. Splitting into two images later needs a second build target and no application code
change at all.

**One job per task, not ten.** `ReceiveMessage` returns at most 10 messages per call, and the proposal
turned that batch limit into a concurrency setting. At ~2 GB per conversion, that is 20 GB of demand on a
4 GB task. Workers still receive in batches; they just process one job at a time.

```
concurrency per task = min( vCPU count, floor(usable memory / per-job memory) )
```

Both limits independently give 1, in both lanes. Throughput comes from running more tasks, not from
stacking more jobs onto a task — which suits Fargate, where the task is the unit of isolation and the
thing that gets OOM-killed as a whole.

A **task definition** is a blueprint, written once. A **task** is a running copy of it. Ten concurrent
jobs means ten tasks from one definition, not ten definitions.

| | Count |
|---|---|
| Task definitions | **2** — `import-worker`, `export-worker`. Fixed. |
| Running tasks | **0 to ~70**, set by queue-depth autoscaling |
| Jobs per task | **1** |

Packing several jobs onto one larger task was considered and rejected — it saves about 10% of the compute
line for a tenfold blast radius, and does not work for imports at all. The arithmetic is in NOTES.md.

## 2. Risk ranking

Ranked by **immediacy**: how certainly and how soon each one fires. The first two are arithmetic and fail
on day one, every time, before any logic runs. The third needs a race to happen, but hurts most when it
does.

### Risk 1 — One queue and one task definition cannot serve both lanes

A queue has one visibility timeout, and the two lanes need different ones. Ninety minutes lets exports
finish but strands a crashed import for 90 minutes. Fifteen minutes recovers imports quickly but
redelivers a still-running export, putting two workers on one job. Separately, Fargate's default 20 GB
disk cannot hold a 10–40 GB package no matter how it is tuned.

**Impact.** Large exports fail on disk before the conversion logic is ever reached, and imports — 80% of
daily volume — queue behind tens-of-minutes exports. Onboarding evenings mix both, so it is worst exactly
when volume peaks.

### Risk 2 — Worker concurrency exceeds task memory by about 5×

A conversion needs ~2 GB and is single-threaded, and the proposal runs up to 10 at once on a 1 vCPU / 4 GB
task. That is ~20 GB of demand against 4 GB. The number 10 is SQS's batch limit, not a sizing decision.

For imports it is worse than the arithmetic suggests. The converter is an in-process TypeScript library
and Node runs JavaScript on one thread, so ten "concurrent" conversions actually serialise while all ten
hold their memory. You pay the full cost of concurrency and get none of the benefit.

**Impact.** Guaranteed OOM kills under real load — the source of the observed exit 137. The knock-on
effects matter more than the failures themselves: healthy work gets redelivered and duplicated, and every
kill leaves an unreaped subprocess behind. Both feed Risk 3.

### Risk 3 — A job can report `succeeded` while publishing the wrong bytes

Every attempt writes to the same `jobs/{jobId}/result`, and nothing decides which attempt is allowed to
write there. With at-least-once delivery, the failure runs like this:

> a task is OOM-killed mid-conversion → SQS redelivers → a second worker claims the job → nothing reaped
> the first subprocess, so it is still running → both write the same key → whichever finishes last wins →
> the job is marked succeeded.

The worker reads the job and then writes it, which is check-then-act, so two deliveries arriving under
100 ms apart can both pass the terminal-state check and both start converting.

**Impact.** The customer gets an inspection package built from a superseded conversion while the job
reports success, and no alarm fires. These are municipal compliance records: a failed job gets retried, a
wrong one gets archived and trusted, and it surfaces weeks later when someone opens a bad package.

### Deliberately left alone

**The ingest path (API Gateway → Lambda → DynamoDB).** It validates a request, writes a row and enqueues.
File bytes never pass through it. At ~1,000 jobs/day it is nowhere near a constraint, and rebuilding it
would spend the v1 budget on the one part already sized correctly. *Revisit when* volume passes ~10,000
jobs/day, ingest p99 goes above ~1 s, or Lambda throttling shows up in metrics.

**Webhook delivery semantics.** Retries with backoff give at-least-once delivery, so duplicates are
possible and ordering is not guaranteed. That is fine, because the job API is the system of record and
every caller can poll — the webhook is a convenience, not the contract. Exactly-once delivery would be
real work for a guarantee nobody needs. *Revisit when* a consumer appears that cannot poll, or missed
completions exceed about 1% of webhook-enabled jobs.

**Load shedding.** The system never rejects work. The usual advice is to return "system busy" once the
queue gets deep, but that is aimed at systems where a person is waiting. Here the callers are backend
services, onboarding submits ~3,000 jobs on purpose, and there is no latency target — absorbing bursts is
the whole point. Rejecting an onboarding batch would break the exact case the system exists to serve.
*Revisit when* arrivals outpace the drain rate for more than a day, or once a latency KPI is agreed.

## 3. Smallest changes before v1

Grouped by cost, because several of these are one-line changes that close large risks. Nothing here is new
design; each item is the smallest expression of a decision in §1 and §4.

**Configuration only — cheapest, and closes the most certain failure**

| Change | Closes |
|---|---|
| Jobs in flight per task: 10 → **1** | Risk 2 entirely. It is a config value, and removing it also removes most exit-137s and the orphans they create |
| Export task: **8 GB memory, ~200 GB disk** | The half of Risk 1 where a 40 GB package cannot be written to a 20 GB disk |
| Per-lane timeouts: import ~15 min, export ~90 min, with queue visibility set above each | The flat 30-second timeout, which kills every real job of either kind |

**Infrastructure**

| Change | Closes |
|---|---|
| Two queues with a DLQ each, two ECS services from two task definitions | The rest of Risk 1 |
| Wire up the three alarms from §5 | A DLQ nobody watches is a silent pile-up |
| S3 lifecycle rule that expires unreferenced attempt prefixes | The orphan storage cost this design introduces |

**Code**

| Change | Closes |
|---|---|
| Claim jobs with a **conditional write** instead of read-then-write | The duplicate-execution race — two deliveries under 100 ms apart can no longer both start work |
| **Attempt-scoped result keys**, plus one fenced publish that only succeeds if the writer still owns the job | Risk 3. Silent corruption becomes impossible rather than unlikely |
| **Kill and reap** the subprocess on timeout | Orphans holding memory and disk, and idling a whole task |
| Classify exits: **2 fails immediately, 137 retries** | Three wasted attempts on files that can never convert, and permanent failure of jobs that would have succeeded |

**Deliberately not in v1**, each with its trigger recorded in NOTES.md: caller-supplied idempotency keys,
moving the import conversion to a `worker_thread`, ECS task scale-in protection, and load shedding.

## 4. Job lifecycle

Both lanes run the same state machine. Only the converter and the timings differ. The reasoning behind
these diagrams is in NOTES.md.

### Import — submission

```
  CALLER
    │
    │  POST /jobs { inputKey }
    ▼
  API GATEWAY ──▶ LAMBDA
                    │
                    │  ① write job record
                    ├──────────────────────▶  DYNAMODB
                    │                         status  = queued
                    │                         attempt = 0
                    │
                    │  ② enqueue { jobId }
                    ├──────────────────────▶  import-queue
                    │
                    ▼
  CALLER  ◀────  { jobId }
```

### Import — worker

```
        receive from import-queue
        (batch up to 10, process ONE)
                    │
                    ▼
     ┌──────────────────────────────────┐
     │  CONDITIONAL CLAIM  (DynamoDB)   │
     │  set status=running, owner=me,   │
     │      attempt=n+1                 │
     │  ONLY IF unowned OR lease expired│
     └──────────────┬───────────────────┘
                    │
          ┌─────────┴─────────┐
          │                   │
      rejected              won
   (someone else            │
    owns it)                ▼
          │        outputKey = jobs/{id}/attempts/{n}/result.json
          ▼                  │
     ack, return             ▼
                    start converter (in-process TS library)
                             │
        ┌────────────┬───────┴────────┬──────────────┐
        │            │                │              │
     exit 0       exit 2          exit 137     timeout (15 min)
    success    invalid DB      killed / OOM          │
        │            │                │              ▼
        │            ▼                │        kill + reap
        │      mark failed            │        subprocess
        │      (permanent,            │              │
        │       no retry)             │              │
        │            │                └──────┬───────┘
        │            ▼                       │
        │           ack                      ▼
        │                          do NOT delete message
        ▼                                    │
┌───────────────────────────────┐            ▼
│ CONDITIONAL UPDATE (DynamoDB) │    SQS redelivers after
│ set outputKey, status=succeeded│    visibility timeout
│ ONLY IF I am still the owner  │            │
└───────────────┬───────────────┘            ▼
                │                    receiveCount > max?
        ┌───────┴───────┐                    │
        │               │              ┌─────┴─────┐
       won           rejected         yes         no
        │          (orphan — a         │           │
        ▼           newer attempt      ▼           ▼
       ack          already won)   import-dlq   back to
                        │                       CLAIM
                        ▼
                       ack
                  (its file is left
                   unreferenced)
```

### Import — state machine

```
              ┌──────────┐
              │  queued  │  ◀── created by Lambda
              └────┬─────┘
                   │  claim wins
                   ▼
         ┌───▶┌──────────┐
         │    │ running  │
         │    └────┬─────┘
         │         │
    lease expires; │
    another worker │
    claims as      │
    attempt n+1    │
         └─────────┤
                   │
        ┌──────────┴──────────┐
        │                     │
  fenced update         exit 2, or
  wins (still owner)    retries exhausted
        │                     │
        ▼                     ▼
  ┌────────────┐        ┌──────────┐
  │ succeeded  │        │  failed  │
  └────────────┘        └──────────┘
```

### Import — how the caller finds out

```
  CALLER ── GET /jobs/{jobId} ──▶ DYNAMODB
                                     │
     status=queued     ──────────────┤  keep polling
     status=running    ──────────────┤  keep polling
     status=succeeded  + outputKey ──┤  fetch result from S3
     status=failed     + reason    ──┤  stop
```

### Export — worker

Submission and caller polling are identical to the import lane, apart from the queue name.

```
        receive from export-queue
        (batch up to 10, process ONE)
                    │
                    ▼
     ┌──────────────────────────────────┐
     │  CONDITIONAL CLAIM  (DynamoDB)   │
     │  ONLY IF unowned OR lease expired│
     └──────────────┬───────────────────┘
          ┌─────────┴─────────┐
      rejected              won
          │                   │
          ▼                   ▼
     ack, return   outputKey = jobs/{id}/attempts/{n}/package.zip
                              │
                              ▼
                    spawn JVM subprocess ────────┐
                              │                  │
                              │        ┌─────────▼───────────────┐
                              │        │ HEARTBEAT every ~30 s   │
                              │        │ extend lease AND        │
                              │        │ extend visibility       │
                              │        │ (Node loop is free —    │
                              │        │  the JVM is a subprocess)│
                              │        └─────────────────────────┘
                              │
        ┌────────────┬────────┴───────┬──────────────┐
     exit 0       exit 2          exit 137    timeout (~90 min)
    success    invalid input    killed / OOM         │
        │            │                │              ▼
        │            ▼                │      SIGTERM the JVM,
        │      mark failed            │      then confirm it is
        │      (permanent,            │      actually dead (reap)
        │       no retry)             │              │
        │            │                └──────┬───────┘
        │            ▼                       ▼
        │           ack             do NOT delete message
        ▼                                    │
┌───────────────────────────────┐            ▼
│ CONDITIONAL UPDATE (DynamoDB) │    SQS redelivers after
│ set outputKey, status=succeeded│    visibility timeout
│ ONLY IF I am still the owner  │            │
└───────────────┬───────────────┘            ▼
        ┌───────┴───────┐            receiveCount > max?
       won           rejected              ┌─────┴─────┐
        │          (orphan — a            yes         no
        ▼           newer attempt          │           │
       ack          already won)           ▼           ▼
                        │            export-dlq   back to CLAIM
                        ▼
                       ack
              (its package is left
               unreferenced)
```

### Export — state machine

Same states as the import lane, with one difference: the lease is renewed by a heartbeat while the JVM
runs, so it only expires if the worker is actually gone.

```
              ┌──────────┐
              │  queued  │  ◀── created by Lambda
              └────┬─────┘
                   │  claim wins
                   ▼
   heartbeat  ┌──────────┐
   every ~30s │ running  │◀─── another worker claims as
   renews  ──▶└────┬─────┘     attempt n+1, once the
   the lease       │            lease finally expires
                   │
        ┌──────────┴──────────┐
        │                     │
  fenced update         exit 2, or
  wins (still owner)    retries exhausted
        │                     │
        ▼                     ▼
  ┌────────────┐        ┌──────────┐
  │ succeeded  │        │  failed  │
  └────────────┘        └──────────┘
```

## 5. Operations, deployment, and observability

### Three operational signals

Two filters decided this set. An alert must have an **action** — if nobody does anything differently when
it fires, it belongs on the dashboard instead. And it must be **low-noise**, because an alarm that cries
wolf gets muted, which is worse than not having it.

| Signal | Metric and source | Threshold | Action |
|---|---|---|---|
| **Queue not draining** | `ApproximateAgeOfOldestMessage`, per queue. CloudWatch, SQS built-in — no instrumentation needed | Import > 1 hr; **Export > 8 hrs** | Check whether the service is already at its maximum task count. If it is, raise the ceiling. If it is not, autoscaling is not reacting — check the scaling policy and look for task launch failures. |
| **Jobs exhausted retries** | `ApproximateNumberOfMessagesVisible` on each DLQ. CloudWatch, SQS built-in | ≥ 1 message, sustained 5 min | Inspect the message, read the job's recorded error, decide whether it is a bug or bad input. The DLQ is the human-investigation queue. |
| **Job failure rate** | Custom metric emitted by the worker on every terminal state, split by lane and error class | > 5% over a rolling 15 min | Depends which class moved. Permanent failures up means look upstream at what is producing bad files. Transient up means look at the fleet. Either spiking within ~30 min of a deploy means roll back. |

Two notes on these choices. **Age, not depth** — depth is *supposed* to hit 3,000 during onboarding, so it
makes a terrible alarm, whereas age growing means nothing is draining. And the **export threshold of 8
hours comes from assumption A2**: if the oldest export is older than that, the onboarding burst will not
clear by morning and the assumption the fleet was sized against is breaking. It is not a number picked to
sound reasonable.

The failure-rate signal is the broadest of the three on purpose, because it is also how a bad release gets
caught.

### Watched on a dashboard, not alerted

Worth seeing, but no immediate action when they move:

- **Publish rejections** — orphaned attempts that finished late and lost the fence. Should be zero.
  Sustained non-zero means duplicate execution is happening and the lease timing is wrong.
- **Exit 137 count** — should be near zero once concurrency is 1. Too noisy to alarm on, because deploys
  produce these as well.
- **Running tasks vs. maximum**, per service — how much scaling headroom is left.
- **Unreferenced attempt storage** — the orphan cost this design introduces.
- **Job duration p50/p95 per lane** — settles the open measurements and the export vCPU question.

### How a change reaches production

```
  pull request ──▶ unit + integration tests (GitHub Actions)
                            │
                       merge to main
                            │
                            ▼
             build ONE image, tagged with the commit SHA
                            │
                            ▼
                       push to ECR
                            │
                            ▼
        register a new revision of BOTH task definitions
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
         update import-svc  ──watch──▶  update export-svc
         (fails fast:                   (slow: tens of
          jobs take minutes)             minutes per job)
```

- **Import first, deliberately.** Imports finish in minutes, so a bad build shows up quickly. An export
  takes tens of minutes to produce its first data point.
- **Detecting a bad release:** the failure-rate signal crossing 5%, correlated with the new task
  definition revision. The DLQ alarm is the slower confirmation.
- **Reversing it:** point the service back at the previous task definition revision. Job state lives in
  DynamoDB and results live in S3, so a rollback is a compute swap, not a migration.
- **What rollback cannot undo:** work already killed in flight. Exports in progress are lost to the
  120-second stop timeout either way, and come back through SQS redelivery rather than through the
  deployment system.

## 6. Sizing and cost

us-east-1 pricing. Consumption is assumed to be same-region, so egress is excluded — see NOTES.md, since
that assumption could double the bill if it is wrong. Durations and output sizes are midpoints of the
ranges in the brief, and are the softest inputs here.

| Input | Value | Basis |
|---|---|---|
| Fargate vCPU / memory | $0.04048 per vCPU-hr, $0.004445 per GB-hr | us-east-1 |
| Fargate disk above 20 GB | $0.000111 per GB-hr | us-east-1 |
| S3 Standard | $0.023 per GB-month | us-east-1 |
| Import duration | 3 min average | brief: "seconds to several minutes" |
| Export duration | 30 min average | brief: "tens of minutes" |
| Import output | 150 MB average | brief caps at 500 MB |
| Export output | 20 GB average | brief: 10–40 GB |

**Cost per task-hour**

```
import   1 vCPU / 4 GB / 20 GB disk        export   1 vCPU / 8 GB / 200 GB disk
  vCPU     1 × 0.04048  = 0.04048            vCPU     1 × 0.04048  = 0.04048
  memory   4 × 0.004445 = 0.01778            memory   8 × 0.004445 = 0.03556
  disk     within free tier = 0              disk   180 × 0.000111 = 0.01998
                          ─────────                                 ─────────
                          $0.0583/hr                                $0.0960/hr
```

### Onboarding evening (3,000 jobs)

2,400 imports and 600 exports, cleared over an 8-hour window (assumption A2).

```
imports   2,400 × 3 min  =   120 task-hours ÷ 8h = 15 concurrent tasks
exports     600 × 30 min =   300 task-hours ÷ 8h = 38 concurrent tasks
```

| Fleet | Peak tasks | Cost |
|---|---|---|
| Import | ~15 | 120 × $0.0583 = $7 |
| Export | ~38 | 300 × $0.0960 = $29 |
| **Total** | **~53** | **~$36** |

The burst everyone worries about costs about $36 in compute. It is a correctness problem, not a capacity
or cost problem, which is where the design effort went.

### Monthly bill at normal volume

30,000 jobs a month: 24,000 imports and 6,000 exports.

```
COMPUTE
  imports   24,000 × 0.05 hr = 1,200 task-hrs × 0.0583 =    $70
  exports    6,000 × 0.50 hr = 3,000 task-hrs × 0.0960 =   $288
                                                          ──────
                                                            $358

STORAGE  (90-day retention ⇒ steady state holds ~3 months of output)
  imports   24,000 × 0.15 GB =   3,600 GB/mo × 3 =  10,800 GB × 0.023 =   $248
  exports    6,000 × 20   GB = 120,000 GB/mo × 3 = 360,000 GB × 0.023 = $8,280
                                                                       ────────
                                                                         $8,528
```

DynamoDB, SQS, Lambda and API Gateway come to under ~$5 between them at this volume, so they are not
modelled.

| Line item | Monthly | Share |
|---|---|---|
| **S3 storage** | **$8,528** | **96%** |
| Fargate compute | $358 | 4% |
| Everything else | ~$5 | 0% |

**The number that reframes the system.** One export job costs:

```
  compute   0.5 hr × $0.0960           = $0.048
  storage   20 GB × $0.023 × 3 months  = $1.380     ← 29× the compute
```

This is not a compute service that stores things. It is a storage service that occasionally converts
things, and it should be optimised as one.

### Biggest line item and how to cut it

**Biggest line item: S3 storage for export packages — $8,280 of an ~$8,900 bill.**

**The single change that cuts it most: keep packages for less time.** The brief says *"Job metadata is
retained for 90 days"* and says nothing about result objects. A retention rule written for metadata rows
looks like it has been applied to 40 GB binaries. If packages only need to survive until the customer
downloads them, expiring them after ~7 days takes that line from **$8,280 to roughly $640, a 92% cut** —
for the cost of a conversation rather than any engineering.

Retention options and the egress caveat are in NOTES.md.
