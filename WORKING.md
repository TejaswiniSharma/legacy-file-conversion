# Working notes — scratch, not part of the submission

Full reasoning lives here. NOTES.md gets only the filtered pointers — assumptions, remaining risks,
where I stopped, and how I used AI. This file is the long-form working record behind those, kept in the
repository so the reasoning is preserved, but not part of the submission proper.

---

## Assumptions (long form)

### A1 — No completion-latency target
Callers submit and poll whenever; no deadline attached to a job.

The brief says how long a conversion *takes*, never what a caller *needs*. So both job types are
background work: correctness and throughput matter, per-job latency does not.

Consequences for the design:
- No priority lanes, no expedited path.
- No latency-based autoscaling — queue wait is a capacity signal, not an SLA breach.
- Scale-from-zero is fine; cold start is irrelevant against jobs measured in minutes.

What would change it: agreeing a real KPI, e.g. p95 import under 10 minutes. That would make queue wait a
customer-facing metric, justify warm capacity instead of scale-from-zero, and probably force imports into
their own lane so they cannot queue behind exports. Worth naming as the first follow-up conversation — it
is the number that decides how much of this design is over- or under-built.

### A2 — Onboarding burst has overnight to clear
~3,000 jobs arriving in an evening should be done by morning, not within N minutes.

Consequences:
- Size the fleet against an 8–12 hour window, not a peak-rate target. Materially lower concurrency and cost.
- Reinforces that scale-from-zero is acceptable.

What would change it: a customer-visible "live the same evening" onboarding commitment, or bursts arriving
during business hours alongside normal traffic instead of overnight.

---

## Open questions still to settle

- One system vs. two systems sharing an API.
- Does the 90-day retention apply to S3 result objects, or only to job metadata? (Big cost lever.)
- Is a conversion safely re-runnable — deterministic, no external side effects?
- What happens to a job that exhausts retries? Who looks at it?
- **Does the vendor export writer stream or stage?** An export downloads JSON + tens of GB of media
  before writing a 10–40 GB zip. If the JVM stages inputs on disk and then assembles the package
  separately, scratch space is ~2× package size (~80 GB, not 40 GB). Changes the task definition and the
  cost. Cannot be answered by reading the binary — needs a measurement or a vendor answer.
- **Are imports and exports independent operations?** I have been treating them as two separate things a
  customer triggers whenever — import legacy data in, export packages out, possibly years apart, possibly
  never paired. The alternative reading is that an export always follows an import as a second phase. The
  brief does not say. Decides whether the two lanes ever need to coordinate.

---

## Measurements needed before committing to task sizing

Current sizing rests on six numbers. Four are judgment calls; these measurements turn them into facts.
Each is a single run against a representative input, not a load test.

**M1 — Peak RSS of an import at the 2 GB input ceiling.**
*Decides:* whether 4 GB is right for the import task, and what `--max-old-space-size` should be.
*Why it matters:* the converter is an in-process library, so its ~2 GB lives in the V8 heap. If the
library buffers the full 500 MB of JSON output rather than streaming it, peak is ~2.8 GB and 4 GB is
correct; if it streams, 3 GB may do. Node's default old-space limit derives from available memory and can
sit below what the conversion needs — it has to be set explicitly, and below the container limit, or V8
grows until the cgroup kills the container with exit 137 and no stack trace.

**M2 — Peak RSS of the JVM on a 40 GB export, non-heap included.**
*Decides:* whether 8 GB is right for the export task.
*Why it matters:* "needs about 2 GB" almost certainly describes the heap. Resident memory is heap plus
metaspace, thread stacks, code cache, and native/direct buffers — and zip compression leans on native
buffers. Expect 25–50% above heap. Sizing the container to the stated 2 GB would be killed by memory the
heap setting never accounted for.

**M3 — Does the JVM use a second core?** Watch CPU utilization during a full export run; above ~100%
means yes.
*Decides:* 1 vCPU vs 2 vCPU on the export task — a 53% cost difference per task-hour.
*Why it matters:* the conversion is single-threaded, so a second core can only serve JVM GC, JIT, and
whatever the zip writer does natively. For 2 vCPU to pay for itself the job would have to run >53%
faster, which single-threaded work will not do. Default to 1 vCPU unless this measurement contradicts it.

**M4 — Peak disk during an export.** Answers the "streams or stages" open question above.
*Decides:* ephemeral storage between ~60 GB and 200 GB.
*Why it matters:* extra ephemeral storage is ~21% of the export task's hourly cost (180 GB above the
20 GB free tier ≈ $0.02/hr against ~$0.076/hr for 1 vCPU / 8 GB). If the writer streams inputs into the
zip, most of that line disappears.

**M5 — Does the import converter yield to the event loop?** Run a conversion with a timer logging every
500 ms and see whether it fires during the run.
*Decides:* whether an import heartbeat is even mechanically possible, and whether the worker can extend
its SQS visibility timeout mid-job.
*Why it matters:* "single-threaded" is not the same as "hogs the thread". A library that streams — read a
chunk, write a chunk — pauses at every I/O step and lets the loop breathe. A tight computation loop does
not. Not required by the current design, which assumes no import heartbeat either way, but it must be
answered before adopting DD2.

### Sizing correction (2026-09-02)

Earlier working figure was 2 vCPU / 8 GB for the export lane. Cost arithmetic does not support it — see
M3. **Current position: 1 vCPU / 8 GB**, revisit only if M3 shows real second-core usage. The 2 vCPU
figure came from exports "feeling heavier", which is the reasoning that inflates cloud bills.

---

## Deferred decisions

### DD1 — Export lane: 1 vCPU or 2 vCPU?

**Settled:** 8 GB memory, ~200 GB ephemeral storage (pending M4).
**Open:** vCPU count.

| | 1 vCPU / 8 GB | 2 vCPU / 8 GB |
|---|---|---|
| Cost per task-hour | $0.076 | $0.117 (**+53%**) |
| 30-min job | $0.0380 | $0.0583 |

The conversion is single-threaded, so a second core can only serve JVM GC, JIT, and whatever the zip
writer does natively. To break even it would have to make the job >53% faster, which single-threaded work
will not do.

**Current position:** 1 vCPU — the cheaper option is the default until evidence contradicts it.
**Blocked on:** M3 (does the JVM exceed ~100% CPU during a real export?).
**Decide before:** finalising the sizing and cost section — export compute is the dominant compute line,
so this moves the monthly estimate.

### DD2 — Move the import conversion into a `worker_thread` / child process

**Deferred.** Imports keep running the conversion on the main thread for now.

*What it would buy:* a responsive main loop — able to hear ECS's 120-second shutdown warning on deploys
and scale-in, extend the SQS visibility timeout mid-job, and run a heartbeat.

*Why deferred:* the design already survives orphaned conversions safely, because the guarantee was built
at the publish step rather than relying on clean shutdown. Under A1 nobody is waiting on a deadline, and a
dead worker does not stall the pool — only that one job waits for its lease to expire.

*Revisit when:* job loss at deploy time becomes measurable, or a latency KPI (A1) is agreed.
*Blocked on:* M5, if a heartbeat is part of the motivation.

---

## Decisions log

<!-- Record each design decision as it gets made, with the reason. Filter into DESIGN.md later. -->

### D1 — Concurrency per worker task is 1, not 10 (2026-09-02)

**Decision:** one job per task, in both lanes. Scale by adding tasks, not by stacking jobs onto a task.

```
concurrency per task = min( vCPU count, floor(usable memory / per-job memory) )
```

| Lane | vCPU | Usable memory | Memory allows | CPU allows | Concurrency |
|---|---|---|---|---|---|
| Import (1 vCPU / 4 GB) | 1 | ~3.7 GB | 1 | 1 | **1** |
| Export (1 vCPU / 8 GB) | 1 | ~7.7 GB | 2 | 1 | **1** |

Both constraints agree independently, which is a good sign the number is right.

**Three supporting findings:**

**(a) The proposal's "10" is SQS's batch limit, not a concurrency decision.** `ReceiveMessage` returns at
most 10 messages per API call. "Receive up to 10" became "process 10 concurrently". Batch size and
concurrency are different things. At ~2 GB per conversion that is 20 GB of demand on a 4 GB task — 5×
over, and the source of the observed exit 137.

**(b) For imports, concurrency buys nothing anyway.** The import converter is an in-process TypeScript
library and JavaScript is single-threaded, so ten concurrent `handle()` calls interleave only at `await`
points. CPU-bound conversion work effectively serializes while all ten hold their working set. Full cost
of concurrency, none of the benefit.

**(c) Batch-receive produces duplicate deliveries with no crash involved.** 10 messages received at t=0,
5-minute visibility timeout, 3-minute imports:

| Time | Worker | SQS |
|---|---|---|
| t=0 | receives 10 | all 10 invisible |
| t=3 | finished job 1 | |
| **t=5** | working job 2 | **visibility expires; jobs 2–10 visible again** |
| t=5+ | still on job 2 | **other workers receive jobs 2–10** |
| t=30 | finishes job 10 | job 10 also ran elsewhere ~25 min earlier |

Nine duplicate executions from arithmetic alone — no OOM, no partition, no bug. Likely the real mechanism
behind the observed "two deliveries <100 ms apart". Every duplicate is two attempts racing to write the
same `jobs/{jobId}/result` key.

**Consequence for the poll loop:** it may receive a batch, but must process one at a time and extend
visibility as it goes — or receive one at a time and leave the rest for other tasks.

### D3 — Job ownership and result publication (2026-09-02)

**The five production observations are two problems.**

| Problem | Observations | Nature |
|---|---|---|
| A — more than one attempt alive at once | duplicate delivery <100 ms; timed-out subprocess keeps running; slow attempt finishes after another published | correctness |
| B — failures are not all equal | exit 2 "required table missing"; exit 137 succeeds on a later run | efficiency + customer clarity |

**Governing principle:** duplicate *work* cannot be prevented — an orphaned subprocess outlives the
worker that started it, on a machine that may no longer exist, and no signal can reach it. Duplicate
*publication* can be prevented absolutely. Design for the second and stop fighting the first.

> Duplicate work is wasteful. Duplicate publishing is what corrupts data. Only the second must be
> impossible.

#### Ownership is a lease, not a lock

DynamoDB has no row locks. It has conditional writes — a write carrying its own condition, evaluated
by DynamoDB as one indivisible step, rejected outright if the condition is false.

Job record carries `status`, `attempt`, `owner`, `leaseExpiry`.

**Claiming** is a single conditional update: *set status=running, owner=me, attempt=n+1 — only if the job
is unowned or its lease has expired.* Two deliveries 100 ms apart both issue this; DynamoDB serialises
them; one wins, the loser is rejected and backs off. **No read-then-write anywhere in the claim path** —
that shape is what created the race in the first place.

#### Timeout must be shorter than redelivery

Retries must not begin while a job is legitimately still running.

| Lane | Max job duration | SQS visibility timeout |
|---|---|---|
| Import | ~15 min | ~20 min (job + cleanup buffer) |
| Export | ~90 min | ~100 min |

The buffer covers killing and reaping the subprocess and writing the final status. These two numbers
cannot collapse into one — independent confirmation of the D2 queue split.

#### Heartbeat — settled for exports, open for imports

Rather than asking "is worker A alive?" (needs service discovery, cannot distinguish alive-but-wedged,
fails under partition), the worker **keeps proving liveness** by extending its lease while working. A
parking meter: stop feeding it and it expires on its own.

- **Export can.** The JVM is a separate process, so the Node event loop stays free.
- **Import cannot.** The converter runs in-process and blocks the loop — a healthy worker is unable to
  report that it is healthy. Either move the conversion to a `worker_thread`/child process so the main
  loop stays responsive, or accept no heartbeat on imports and rely on the timeout alone. **Still open.**

#### Result publication — attempt-scoped keys (Option A)

**Chosen.** Each attempt writes to its own key; the job record conditionally records which one counts.

```
attempt 1 → jobs/{jobId}/attempts/1/result.json     (orphan — unreferenced, harmless)
attempt 2 → jobs/{jobId}/attempts/2/result.json     ← job record points here
```

*Why not a shared key.* S3 cannot evaluate a DynamoDB condition — they are different services. With one
shared path, an orphan finishing late overwrites a correct result that has already been published, and
the job still reports `succeeded`. The orphan could read DynamoDB first and abort, but that is
read-then-write again, with a real if narrow window. Rejected: the failure is silent corruption, the
top-ranked risk.

*Why not `If-None-Match: *` on a shared key.* Prevents the overwrite but blocks legitimate retries — an
attempt that wrote its file and then died before recording success locks every later attempt out forever.

**Result:** exactly **one** fenced write in the system — the conditional DynamoDB update that sets
`outputKey` and `status=succeeded` only if the writer is still the owner. S3 needs no protection at all,
because no two attempts ever share a filename.

**Ordering falls out for free.** The attempt file is written before the status update, so the only
possible window is "result exists but job still says running" — a caller waits slightly longer than
necessary. The dangerous direction, "job says succeeded but the file is not there", cannot occur.

**Costs accepted:**
- Orphan objects consume storage until cleaned up — up to 40 GB per orphaned export. Needs an S3
  lifecycle rule deleting unreferenced attempt prefixes after a few days.
- `jobs/{jobId}/result` stops being a predictable path. Callers read the location from the job API.
  Acceptable, since they already poll that API to learn the job finished.

#### Failure classification (Problem B)

| Exit | Meaning | Treatment |
|---|---|---|
| **2** | invalid database — permanent | Mark `failed` immediately with the reason. Burn no retries; the answer will not change. |
| **137** | SIGKILL, usually OOM — transient | Retry via SQS's native redelivery. |

No separate retry queue: SQS already redelivers, counts attempts and moves exhausted messages to a DLQ.
A second queue would add another at-least-once boundary and another place to lose a job. Longer backoff,
if wanted, comes from extending message invisibility.

**Alert on the rate of exit 2, not on occurrences.** One bad file is normal business — a customer sent a
broken database. A spike means something systemic, upstream or in our own reader.

**Note:** exit 137 is also what ECS sends when `stopTimeout` expires, so deployments manufacture this
observation themselves. Concurrency=1 with correct memory (D1) should remove most genuine OOM cases.

#### D3a — Heartbeat, decided per lane (2026-09-02)

A heartbeat is just code that runs periodically. If the conversion blocks the Node thread, that code
**never runs** — the timer is queued and sits there until the job is already finished. So a blocking
conversion and a heartbeat are mutually exclusive, not merely degraded.

| Lane | Heartbeat | Lease |
|---|---|---|
| Import | **none** | set to max job duration + buffer |
| Export | **every ~30 s**, extends the lease | short, continuously renewed |

Exports get it free: the JVM is a subprocess, so the Node loop is idle and able to check in.

Imports go without, and the lease alone carries recovery. This works *regardless* of whether the library
yields to the event loop (M5), which is why it is the safer choice — a heartbeat that silently never
fires would be worse than no heartbeat at all.

Fast detection is not worth much here anyway: a dead worker does not stall the fleet, only its own job,
and under A1 nobody is waiting on a deadline. Reclaiming in 2 minutes instead of 15 is a nicety.

#### Still open after D3

- Is `failed` terminal? Does exit 2 ("never retry") land in the same state as exhausted 137s ("might work
  tomorrow"), and can either return to `queued`?
- Lease duration as a concrete number per lane.

### D2 — Two lanes: one repo, one image, two task definitions on ECS Fargate (2026-09-02)

**Decision:** imports and exports get separate SQS queues, separate ECS services, and separate task
definitions — but share one repository and one container image.

```
                      ┌── import-queue ──→ import-svc (import-worker taskdef) ──→ S3
   POST /jobs → API ───┤
                      └── export-queue ──→ export-svc (export-worker taskdef) ──→ S3
```

**Why two lanes rather than one shared queue and fleet:**
- A queue has exactly one visibility timeout. ~90 min lets exports finish but strands a crashed import
  for 90 min; ~15 min recovers imports but redelivers a still-running export into a duplicate attempt.
  No single value serves both. This is structural, not tuning.
- Fargate's 20 GB default ephemeral storage cannot hold a 10–40 GB export package. One task definition
  cannot be right for both.
- Head-of-line blocking: a wave of tens-of-minutes exports delays seconds-to-minutes imports, which are
  80% of daily volume.
- Autoscaling on queue depth means different things for a 30-second job and a 30-minute one.

**Why one image rather than two:**
- The correctness-critical code — claim, state transition, result publication — is shared. Two copies is
  how one quietly goes wrong, and silent corruption is the top risk in this system.
- One build, one test suite, one pipeline, one artifact to scan.
- Config lives in the task definition, not the image, so identical bytes still give each lane its own
  CPU, memory, disk, entry point, queue and IAM role.
- ECS services update independently, so rollout can still be staggered (import first, watch, then export)
  and rolled back per service.

**Tradeoff accepted:** the shared image carries the JVM and vendor JAR even for import tasks (~1 GB vs
~200 MB), so the import fleet inherits JVM CVE patching it never executes. Cold-start cost is minor —
tasks are long-lived, so image pull is roughly a one-time ~20 s per task launch, not per job.

**Escape hatch:** splitting into two images later is a multi-stage Dockerfile plus a second ECR repo. It
requires **no application code change**, because nothing about the lane split lives in the image. Revisit
if JVM patch churn becomes a real operational cost.

**Deployment shape that follows:** build one image tagged by commit SHA → register a new revision of both
task definitions → update `import-svc`, observe, then update `export-svc`. Rollback is pointing a service
at the previous revision: no data moves, so it is fast.

**Still open in this decision:** export lane vCPU — deferred, see DD1.
