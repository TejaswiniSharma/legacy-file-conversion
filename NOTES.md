# Notes

## Assumptions

- **A1 — No completion-latency target.** Callers submit and poll; no deadline on a job. Revisit if a KPI
  (e.g. p95 import under 10 min) is agreed.
- **A2 — The onboarding burst has overnight to clear.** ~3,000 jobs sized against an 8–12h window, not a
  peak rate.
- **A3 — Results are consumed same-region, so egress is free.** Callers are internal ITpipes services.
  If packages are instead pulled over the internet, ~120 TB/month at ~$0.09/GB is roughly $9,000/month —
  doubling the bill and displacing storage as the top line item. This is the single largest uncertainty
  in the cost estimate; nothing else moves the total as much.
- **A4 — The 90-day retention in the brief covers job metadata, not result objects.** The brief says
  "Job metadata is retained for 90 days" and is silent on the S3 objects. The estimate in DESIGN.md §6
  assumes it *does* apply to objects, which is the pessimistic reading — see the retention lever below.

## Remaining risks

- **No submission-level idempotency.** Duplicate *execution* of a job is prevented (conditional claim +
  attempt-scoped result keys), but duplicate *submission* is not: a caller that retries `POST /jobs` after
  a lost response creates a second job doing identical work — a wasted 10–40 GB package at export sizes.
  Fix is a caller-supplied idempotency key deduped with a conditional write, not read-then-create.
- **No load shedding.** The system never rejects work, so an arrival rate sustained above fleet capacity
  grows the queue without bound. Deliberate: callers are batch services, onboarding submits ~3,000 jobs on
  purpose, and A1 sets no deadline — absorbing bursts is the intended behaviour. Revisit if arrivals exceed
  drain rate for more than a day, or once a latency KPI exists. (Also stated in DESIGN.md §2 as a
  deliberate non-goal.)
- **Deploys and scale-in kill jobs mid-flight.** ECS allows at most 120 s between SIGTERM and SIGKILL, and
  an export runs tens of minutes — so no release can drain gracefully. Tolerable because the design
  survives orphaned conversions safely (they can never publish), but every deploy still wastes in-flight
  work and manufactures exit-137s. Fix would be task scale-in protection plus a responsive worker loop.
- **Failures are not classified in the current worker.** Exit 2 (invalid database, permanent) and exit 137
  (killed, transient) are treated identically, so three attempts are spent on files that can never convert
  and the caller waits 3× longer for news available in the first two seconds. Designed in DESIGN.md §4;
  not yet implemented in code.

## Cost levers not yet applied

S3 storage for export packages is 96% of the monthly bill (DESIGN.md §6). Two levers, and the larger one
is a product question rather than an engineering one.

| Lever | Change | Monthly | Cut |
|---|---|---|---|
| Baseline | 90 days in S3 Standard | $8,280 | — |
| **1. Storage class** | Lifecycle to Glacier Instant Retrieval after ~7 days — still millisecond access | ~$2,000 | 76% |
| **2. Retention** | Expire packages ~7 days after creation | ~$640 | **92%** |

Lever 2 depends on confirming A4 — whether the 90-day rule was ever meant to cover 40 GB binaries.
Confirming it is the highest-value question in this submission and needs no code.

Lever 1 applies regardless and composes with lever 2: whatever retention is agreed, packages are read
once shortly after creation and then sit untouched, which is precisely the access pattern Glacier Instant
Retrieval is priced for.

## Lifecycle details (the reasoning behind the DESIGN.md §4 diagrams)

**The principle underneath all of it.** Duplicate work cannot be prevented; duplicate publication can. An
orphaned conversion outlives the worker that started it, on a machine that may no longer exist, where no
signal can reach it. So rather than fight that, the system lets it run and guarantees it can never
publish. Duplicate work is wasteful. Duplicate publishing is what corrupts data, and only that has to be
impossible.

**Where ownership sits**

| Boundary | Owner |
|---|---|
| Job state | DynamoDB — the only source of truth |
| Work distribution and retries | SQS — never the state of record |
| Result bytes | S3, one file per attempt, never overwritten |
| Deciding which attempt counts | The single conditional update |

Exactly one write in the system needs fencing: the conditional update that sets `outputKey` and
`succeeded` only if the writer still owns the job. S3 needs no protection at all, because no two attempts
ever share a filename. The safe ordering falls out for free — the attempt file exists before the status
changes, so the only possible window is "result ready, job still says running". The dangerous direction,
"job says succeeded but the file is missing", cannot happen.

**Retry boundary.** Retries come from SQS redelivery, not from application bookkeeping: a worker that
cannot finish simply does not delete the message. Job timeouts are set below the redelivery window — a
~15 minute ceiling against a ~20 minute visibility timeout on imports, ~90 against ~100 on exports — so a
retry never starts while an attempt is legitimately still running. The gap covers killing and reaping the
subprocess and writing the final status. Messages that run out of attempts land in the lane's DLQ.

**Failure classification.** Exit 2 (invalid database) is permanent, so the job fails immediately with the
reason recorded and no retries spent — the answer will not change. Exit 137 (SIGKILL, usually OOM) is
transient and gets retried. Treating them the same way would either waste three attempts on a file that
can never convert, or permanently fail a job that would have worked on the next run.

**No heartbeat on the import lane.** A heartbeat is code that runs periodically, and a conversion that
blocks the Node thread never lets it run — the timer sits queued and only fires once the job has already
finished. So on imports the lease alone handles recovery: it is set to the longest a job could take, and a
dead worker's job becomes claimable when it expires. This works whether or not the library yields to the
event loop, which is what makes it the safer choice; a heartbeat that silently never fires would be worse
than none at all. Fast detection buys little anyway, since a dead worker stalls only its own job rather
than the fleet, and under A1 nobody is waiting.

**Killing is not enough — the subprocess must be reaped.** A timed-out JVM keeps running unless its owner
terminates it and confirms it is gone. It holds memory and scratch disk, and at one job per task it idles
the whole task until the handler returns. It can also still finish and write its package, which is
precisely why publication is fenced rather than trusted: the design tolerates the orphan instead of
depending on killing it successfully.

**Orphans cost more on the export lane.** An abandoned import attempt strands at most 500 MB. An abandoned
export attempt strands up to 40 GB, on the storage line that is already 96% of the bill. The lifecycle
rule that deletes unreferenced attempt prefixes matters much more for exports than for imports.

## Part 2 — what changed in the worker

Three fixes, all of them the code expression of decisions in DESIGN.md §4.

1. **Fenced publication.** Claiming a job is now one atomic compare-and-swap, so of two deliveries
   arriving together only one starts a conversion. Each attempt converts into its own key
   (`jobs/{id}/attempts/{n}/result.json`) and a single fenced write decides which attempt counts. A slow
   attempt returning after a newer one has published loses that write and leaves its file unreferenced.
2. **Kill and reap on timeout.** A timed-out subprocess is terminated and confirmed gone before any
   retry-or-fail decision.
3. **Exit-code classification.** Exit 2 (invalid database) fails the job immediately without spending
   retries; everything else, exit 137 included, is transient and retried through SQS redelivery.

### Interface changes, and why

- **`JobStore.put` removed, replaced by `compareAndSwap`.** A read followed by an unconditional write is
  check-then-act, which is the defect itself. Leaving `put` on the interface would leave the footgun for
  the next person; removing it means every write must state what it expects to be true. Maps directly to
  a DynamoDB conditional expression.
- **`RunningConversion.completion`: `Promise<void>` → `Promise<number>`.** Classification needs the exit
  code. An invalid input file is an expected outcome rather than an exceptional one, so it belongs in the
  return value, not in a thrown error.
- **`Job` gains `owner`.** Correctness comes from `attempt` acting as the fencing token; `owner` is for
  legibility and debugging.
- **`handle()` gains a `WorkerConfig`.** Replaces the hardcoded 30-second timeout — which would have
  killed every real job of either kind — and the hardcoded retry limit. This parameter is what lets one
  codebase serve both lanes.

**No `leaseExpiresAt`, despite DESIGN.md §4 showing "unowned or lease expired".** In this handler the SQS
visibility timeout *is* the lease: it is set above the job timeout, so a redelivered message already
means the previous attempt overran. A worker reading `(running, N)` and swapping to `(running, N+1)` is
exactly the take-over the design describes, and it fences the previous attempt out of publishing. A
separate expiry timestamp would add surface without adding safety.

### Verification

Seven tests, run with `npm test`. Five of them were confirmed to fail against the original logic by
temporarily restoring it behind the new interfaces and re-running the suite: duplicate conversions,
stale overwrite, shared output keys, missing kill, and exit-2 retries all reproduce. The two that pass
either way — transient retry and terminal-state ack — are regression guards for behaviour the original
already had right.

### Not fixed in the worker, and why

- **Retry backoff and jitter.** Not present in the starter and not needed to demonstrate these fixes.
  SQS redelivery timing would carry it.
- **Lease renewal / heartbeat.** Imports get none by design (DESIGN.md §4); the export heartbeat belongs
  to the poll loop.
- **The poll loop itself.** Explicitly out of scope per the brief.
- **`Clock.timeout` leaves a timer pending** when the conversion wins the race. `Promise.race` attaches a
  handler so there is no unhandled rejection, but the timer survives. Harmless per job, wasteful at
  volume; a cancellable timeout is the fix.
- **Submission idempotency keys** — see Remaining risks above.

## Where I stopped

Part 1 is complete; Part 2 has the three fixes above with tests. Still open:

- **DESIGN.md §4 open items** — whether `failed` is terminal (and whether exit 2 and exhausted retries
  should share that state), concrete lease durations per lane, and webhook handling.
- **Measurements M1–M5 in WORKING.md** are unrun. Four of the six numbers behind the task sizing are
  judgment rather than fact, and one test run each would settle them.
- **DD1** — export lane vCPU, deferred pending M3.
- **Section 5's custom metrics** are specified but not emitted by the worker; the failure-rate signal
  needs the worker to publish counters on terminal states.

With more time, in order: confirm A4 with a product owner (it is worth ~92% of the monthly bill), run
M1–M5, then emit the metrics §5 depends on.

## How I used AI

Claude Code throughout, deliberately as an interlocutor rather than an author. I asked it to explain
mechanics I had not worked with directly (ECS Fargate, task definitions versus tasks, SQS visibility
semantics), to lay out options with trade-offs, and to check my reasoning — and I made the decisions.

**What I accepted.** The argument that a single queue cannot serve both lanes, because one visibility
timeout cannot cover a 15-minute and a 90-minute job. The concurrency analysis showing the proposal's
"10 messages" was SQS's batch limit rather than a sizing decision. The reframe that duplicate *work*
cannot be prevented but duplicate *publication* can, which is the spine of the state machine. The cost
arithmetic showing storage is 96% of the bill.

**What I rejected or corrected.**

- It twice began drafting document sections before I had decided their content; I stopped it and had it
  ask questions instead. The design decisions in DESIGN.md are mine.
- Its first NOTES.md draft was long-form prose. I asked for terse pointers and moved the reasoning to
  WORKING.md, then later moved the cost levers out of DESIGN.md into NOTES.md.
- It proposed doing Part 2 before Part 1. I pushed back — the worker repair encodes design decisions
  (timeouts, retry ownership, store semantics) that Part 1 has to settle first — and it agreed the
  dependency ran that way.
- It corrected itself on export sizing: it had proposed 2 vCPU, then showed the cost arithmetic made it
  53% more expensive for single-threaded work and revised to 1 vCPU. Recorded as DD1 rather than silently
  changed.

**Where it caught things I had missed.** It flagged that I had carried "10 messages concurrently" forward
into my own design summary after we had already ruled it out, and that my proposed fix for the stale-write
problem — read the job status, then write — was the same check-then-act race in a different place.

**External material.** I read a published article on the long-running-task pattern and had Claude compare
it against this design. Most of it confirmed choices already made; it surfaced one genuine gap, that I had
prevented duplicate *execution* but not duplicate *submission*, which is recorded above as a remaining
risk.

**Verification rather than assertion.** For the claim that the new tests would have failed before the
change, I had it restore the original logic behind the new interfaces and re-run the suite, rather than
taking the claim on trust. Five of seven failed, as expected.
