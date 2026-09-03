# Design Review: Legacy File Conversion Service

<!-- Target: ~2 pages + optional diagram. -->

## 1. Architecture

Two independent lanes behind a shared API. Imports and exports have almost nothing in common —
seconds-to-minutes against tens-of-minutes, ≤500 MB of JSON against 10–40 GB packages, an in-process
TypeScript library against a vendor JVM subprocess — so they get separate queues, separate ECS services
and separate task definitions. They share a single repository and container image, because the code that
must not diverge is the job lifecycle, not the converter.

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
| Ingest | API Gateway + Lambda | Validates, writes a job row, enqueues. Bytes never pass through it — callers submit S3 references. At ~1,000 jobs/day this is nowhere near a constraint. |
| Job metadata | DynamoDB | Single source of truth for job state. TTL gives the 90-day retention for free. |
| Work distribution | Two SQS queues, one DLQ each | See below — a queue has exactly one visibility timeout, and the two lanes need different ones. |
| Compute | ECS Fargate, two services | No 15-minute ceiling (Lambda cannot run a 40-minute export at any configuration), real process model for the vendor JVM, scale to zero, per-task isolation. |
| Results | S3 under `jobs/{jobId}/…` | Durable, cheap, and callers already speak S3. |
| Scaling | Queue depth per lane, from zero | Volume is bursty and mostly idle; cold start is irrelevant against jobs measured in minutes. |

### The two lanes

| | `import-worker` | `export-worker` |
|---|---|---|
| Reads | one Access DB, 10 MB–2 GB | JSON + media map → tens of GB of video/images |
| Produces | ≤500 MB JSON | 10–40 GB zip |
| Duration | seconds to several minutes | tens of minutes |
| Converter | TypeScript library, in-process | vendor JVM subprocess |
| CPU / memory | 1 vCPU / 4 GB | 8 GB; vCPU deferred pending measurement |
| Ephemeral storage | 20 GB (default) | ~200 GB — the 20 GB default cannot hold the package |
| Queue visibility timeout | ~15 min | ~90 min |
| **Jobs in flight per task** | **1** | **1** |
| Share of ~1,000/day | ~800 | ~200 |

Every row is a value that would have to collapse to a single number under one shared queue and task
definition. That is the argument for the split, stated as a table.

### Three choices worth defending

**Two queues, not one.** A queue has exactly one visibility timeout. Set it to ~90 minutes so exports can
finish, and a crashed import stays invisible for 90 minutes before anyone retries it. Set it to ~15
minutes so imports recover promptly, and a 40-minute export is redelivered *while it is still running* —
two workers converting the same job. No single value serves both. This is structural, not tuning. Fargate's
20 GB default ephemeral storage, against 10–40 GB packages, is a second constraint pointing the same way.

**One image, two task definitions.** Configuration lives in the task definition, not the image, so
identical bytes give each lane its own CPU, memory, disk, entry point, queue and IAM role. Sharing the
image keeps one implementation of the code that must not diverge — claiming a job, transitioning its
state, publishing its result — which is exactly where silent corruption would come from. The cost is that
import tasks carry a JVM they never execute; splitting into two images later needs a second build target
and no application code change.

**One job in flight per task, not ten.** `ReceiveMessage` returns at most 10 messages per call, and the
provisional proposal turned that batch limit into a concurrency setting. At ~2 GB per conversion that is
20 GB of demand on a 4 GB task. Workers still *receive* in batches; they process one job at a time.

```
concurrency per task = min( vCPU count, floor(usable memory / per-job memory) )
```

Both constraints independently give 1, in both lanes. Throughput comes from more tasks, not more jobs per
task — which also matches Fargate, where the task is the unit of isolation and the thing that gets
OOM-killed as a whole.

The two are different objects, and the distinction carries the scaling story: a **task definition** is a
blueprint, written once; a **task** is a running copy of it. Ten concurrent jobs means ten tasks from one
definition, not ten definitions.

| | Count |
|---|---|
| Task definitions | **2** — `import-worker`, `export-worker`. Fixed. |
| Running tasks | **0 to ~70**, set by queue-depth autoscaling |
| Jobs per task | **1** |

*Considered and rejected:* packing ~8 jobs onto one large task is roughly 10% cheaper per unit work, since
per-task overhead amortises once instead of eight times. Declined on three grounds. Fargate sells 1, 2, 4,
8 or 16 vCPU — targeting exactly 10 forces the 16 vCPU tier and its 32 GB floor, landing ~35% *worse* than
scaling out. An OOM kills the whole task, so packing multiplies blast radius by the packing factor and
turns one bad job into eight orphaned conversions and eight redeliveries. And for imports it does not work
at all: the converter is in-process and Node executes JavaScript on one thread, so eight concurrent
`handle()` calls serialise while eight cores idle. Roughly 10% of the compute line — itself a minority of
the bill against S3 storage — is not worth a tenfold blast radius.

<!-- Job state machine and result publication are now designed — see §4. -->

## 2. Risk ranking

**Ranked by immediacy** — how certainly and how soon each one fires — rather than by severity alone. The
first two are arithmetic: they fail on day one, every time, before any logic is reached. The third needs a
race to occur, but is the one that hurts most when it does.

### Risk 1 — One queue and one task definition cannot serve both lanes

A queue has exactly one visibility timeout. Set it to ~90 minutes so exports can finish and a crashed
import stays invisible for 90 minutes before retry; set it to ~15 minutes so imports recover promptly and
a 40-minute export is redelivered *while still running*, producing two workers on one job. No single value
works. Separately, Fargate's default 20 GB ephemeral storage cannot hold a 10–40 GB package at any tuning.

**Impact.** Large exports fail on disk before conversion logic is ever reached — a total, certain failure
for the biggest packages. Meanwhile imports, which are 80% of daily volume, head-of-line block behind
tens-of-minutes exports on the shared queue. Onboarding evenings mix both, so this is worst exactly when
volume peaks.

### Risk 2 — Worker concurrency exceeds task memory by roughly 5×

A conversion needs ~2 GB and is single-threaded; the proposal runs up to 10 concurrently on a 1 vCPU /
4 GB task. That is ~20 GB of demand against 4 GB. The figure 10 is SQS's `ReceiveMessage` batch limit,
not a considered concurrency setting.

For imports it is worse than the arithmetic suggests: the converter is an in-process TypeScript library
and Node executes JavaScript on one thread, so ten concurrent conversions serialise while all ten hold
their working set. Full cost of concurrency, none of the benefit.

**Impact.** Guaranteed OOM kills under any real load — the source of the observed exit 137. Two knock-on
effects matter more than the failures themselves: a blocked event loop cannot extend visibility timeouts,
so healthy in-flight work is redelivered and duplicated; and every OOM leaves an unreaped subprocess
behind. Both feed Risk 3 directly.

### Risk 3 — A job can report `succeeded` while publishing the wrong bytes

Every attempt writes to the same `jobs/{jobId}/result`, and nothing establishes which attempt may write
there. With at-least-once delivery the failure runs:

> a task is OOM-killed mid-conversion → SQS redelivers → a second worker claims the job → nothing reaped
> the first subprocess, so it is still running → both write the same key → whichever finishes last wins →
> the job is marked succeeded.

The worker's `get()`-then-`put()` transition is check-then-act, so two deliveries arriving <100 ms apart
can both pass the terminal-state check and both start converting.

**Impact.** The customer receives an inspection package built from a superseded conversion, with the job
reporting success. No alarm fires, because from the queue's perspective everything completed. For CCTV
inspection history retained as municipal compliance record, output that is wrong but confident is
materially worse than output that failed: a failed job is retried, a wrong one is archived and trusted.
Detection is a customer opening a bad package weeks later.

### Deliberately left alone

**The ingest path (API Gateway → Lambda → DynamoDB).** It validates a request, writes a row and enqueues;
bytes never pass through it, since callers submit S3 references. At ~1,000 jobs/day this is nowhere near a
constraint, and rebuilding it would spend the v1 budget on the one component already sized correctly.
*Revisit when* sustained volume passes ~10,000 jobs/day, ingest p99 exceeds ~1 s, or Lambda concurrency
throttling appears in metrics.

**Webhook delivery semantics.** Retries with backoff give at-least-once delivery: duplicates are possible
and ordering is not guaranteed. Acceptable because the job API is the system of record and every caller
can poll — the webhook is an optimisation, not the contract. Building exactly-once delivery would be real
work for a guarantee no consumer needs. *Revisit when* a consumer appears that cannot poll, or
missed-completion reports exceed roughly 1% of webhook-enabled jobs.

**Load shedding under backpressure.** The system never rejects work. Standard advice is to return "system
busy" once the queue passes a depth threshold, but that targets user-facing systems where someone is
waiting. Here callers are backend services, onboarding submits ~3,000 jobs deliberately, and no latency
target exists — absorbing bursts is the intended behaviour, not a failure of it. Rejecting an onboarding
batch would break the exact scenario the system exists to serve. *Revisit when* arrival rate exceeds
drain rate for more than a day, or once a completion-latency KPI is agreed.

## 3. Smallest changes before v1

## 4. Job lifecycle

<!-- One import and one export end to end: state ownership, retry boundaries,
     result publication, how the caller learns the outcome. -->

The design principle underneath this section: **duplicate work cannot be prevented, duplicate publication
can.** An orphaned conversion outlives the worker that started it, on a machine that may no longer exist,
where no signal can reach it. Rather than fight that, the system lets it run and guarantees it can never
publish. Duplicate work is wasteful; duplicate publishing is what corrupts data, and only that has to be
impossible.

### Import

**Submission**

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

Record first, then enqueue — otherwise a worker could receive the message before the job exists.

**Worker processing**

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

**State machine**

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
  conditional update    exit 2, or
  wins (still owner)    retries exhausted
        │                     │
        ▼                     ▼
  ┌────────────┐        ┌──────────┐
  │ succeeded  │        │  failed  │
  └────────────┘        └──────────┘
```

**How the caller learns the outcome**

```
  CALLER ── GET /jobs/{jobId} ──▶ DYNAMODB
                                     │
     status=queued     ──────────────┤  keep polling
     status=running    ──────────────┤  keep polling
     status=succeeded  + outputKey ──┤  fetch result from S3
     status=failed     + reason    ──┤  stop
```

The result location comes from `outputKey` in the record rather than a guessable path — a direct
consequence of attempt-scoped keys.

**Retry boundary.** Retries are driven by SQS redelivery, not by application bookkeeping: a worker that
cannot finish simply does not delete the message. Timeouts are set shorter than redelivery — a ~15 minute
job ceiling against a ~20 minute visibility timeout — so a retry never begins while an attempt is
legitimately still running. The buffer covers killing and reaping the subprocess and writing the final
status. Exhausted messages land in `import-dlq`.

**Failure classification.** Exit 2 (invalid database) is permanent: the job is failed immediately with the
reason and no retries are spent, because the answer will not change. Exit 137 (SIGKILL, usually OOM) is
transient and is retried. Treating them identically would either waste three attempts on a file that can
never convert, or permanently fail a job that would have succeeded on the next run.

**Where ownership sits**

| Boundary | Owner |
|---|---|
| Job state | DynamoDB — sole source of truth |
| Work distribution and retries | SQS — never state of record |
| Result bytes | S3, one file per attempt, never overwritten |
| Deciding which attempt counts | The single conditional update |

Exactly one write in the system needs fencing: the conditional update that sets `outputKey` and
`status=succeeded` only if the writer still owns the job. S3 needs no protection, because no two attempts
ever share a filename. The ordering also falls out safely — the attempt file exists before the status
changes, so the only possible window is "result ready, job still says running." The dangerous direction,
"job says succeeded but the file is missing," cannot occur.

<!-- OPEN, to resolve before this section is final:
     - Import heartbeat: the lease expires, but an import worker cannot refresh it because the
       conversion blocks the Node event loop. Either move the conversion to a worker_thread, or
       rely on the timeout alone.
     - Is `failed` terminal? Exit 2 and exhausted retries both land there; whether either can
       return to `queued` is undecided.
     - Concrete lease duration and heartbeat interval.
     - Webhooks: the brief mentions an optional completion webhook; not yet discussed. -->

### Export

## 5. Operations, deployment, and observability

### Three operational signals

<!-- Each: the metric, where it is emitted, a rough threshold, the action it should cause. -->

### How a change reaches production

<!-- One paragraph, no more: pipeline stages, detecting a bad release, stopping/reversing it. -->

## 6. Sizing and cost

us-east-1 pricing; consumption assumed same-region, so egress is excluded (see the caveat at the end).
Durations and output sizes are midpoints of the ranges in the brief and are the softest inputs here.

| Input | Value | Basis |
|---|---|---|
| Fargate vCPU / memory | $0.04048 per vCPU-hr, $0.004445 per GB-hr | us-east-1 |
| Fargate ephemeral storage above 20 GB | $0.000111 per GB-hr | us-east-1 |
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
or cost problem — which is where the design effort went.

### Monthly bill at normal volume

30,000 jobs/month: 24,000 imports, 6,000 exports.

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

DynamoDB, SQS, Lambda and API Gateway together land under ~$5 at this volume and are not modelled.

| Line item | Monthly | Share |
|---|---|---|
| **S3 storage** | **$8,528** | **96%** |
| Fargate compute | $358 | 4% |
| Everything else | ~$5 | 0% |

**The number that reframes the system.** Cost of one export job:

```
  compute   0.5 hr × $0.0960           = $0.048
  storage   20 GB × $0.023 × 3 months  = $1.380     ← 29× the compute
```

This is not a compute service that stores things. It is a storage service that occasionally converts
things, and it should be optimised as one.

### Biggest line item and how to cut it

**Biggest line item: S3 storage for export packages — $8,280 of an ~$8,900 bill.**

**The single change that cuts it most: shorten how long packages are retained.** The brief says *"Job
metadata is retained for 90 days"* and says nothing about result objects — a retention rule written for
metadata rows appears to have been applied to 40 GB binaries. If packages only need to survive until the
customer downloads them, expiring them after ~7 days takes that line from **$8,280 to roughly $640, a 92%
cut**, for the cost of a conversation rather than any engineering.

Retention options and the egress caveat are detailed in NOTES.md.
