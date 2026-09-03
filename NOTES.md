# Notes

## Assumptions

- **A1. No latency target.** Callers submit and poll. Nothing has a deadline. Revisit if a KPI is agreed,
  for example p95 import under 10 minutes.
- **A2. The onboarding burst has overnight to clear.** 3,000 jobs sized against an 8 to 12 hour window,
  not a peak rate.
- **A3. Results are consumed in-region, so egress is free.** Callers are internal ITpipes services. If
  packages get pulled over the internet instead, roughly 120 TB a month at about $0.09/GB is around
  $9,000 a month. That would double the bill and make egress the biggest line item. It is the largest
  uncertainty in the cost estimate.
- **A4. The 90 day retention covers job metadata, not result objects.** The brief only mentions metadata
  and says nothing about the S3 objects. DESIGN.md §6 assumes it covers objects anyway, which is the
  expensive reading. See the retention lever below.

## Remaining risks

- **No idempotency on submission.** Duplicate execution is prevented. Duplicate submission is not. A
  caller that retries `POST /jobs` after a lost response creates a second job doing identical work, which
  at export sizes wastes a package of 10 to 40 GB. Fix: a caller-supplied idempotency key, deduped with a
  conditional write rather than read-then-create.
- **No load shedding.** The system never rejects work, so sustained overload grows the queue without
  bound. Deliberate, for the reasons in DESIGN.md §2. Revisit if arrivals outpace the drain rate for more
  than a day.
- **Deploys and scale-in kill jobs mid-flight.** ECS allows at most 120 seconds between SIGTERM and
  SIGKILL, and an export runs for tens of minutes, so no release drains cleanly. Tolerable because
  orphaned conversions can never publish, but every deploy still wastes in-flight work and produces
  exit 137s. Fix: task scale-in protection plus a worker loop that can hear the signal.
- **The worker does not emit metrics yet.** The failure-rate alert in DESIGN.md §5 needs counters
  published on every terminal state. Specified, not built.

## Cost levers not yet applied

S3 storage for export packages is 96% of the monthly bill (DESIGN.md §6).

| Lever | Change | Monthly | Cut |
|---|---|---|---|
| Baseline | 90 days in S3 Standard | $8,280 | |
| 1. Storage class | Move to Glacier Instant Retrieval after about 7 days, still millisecond access | ~$2,000 | 76% |
| 2. Retention | Expire packages about 7 days after creation | ~$640 | **92%** |

- Lever 2 needs A4 confirmed: was the 90 day rule ever meant to cover 40 GB binaries? This is the
  highest-value question in the submission and it needs no code.
- Lever 1 applies either way and stacks with lever 2. Packages are read once shortly after they are
  created and then sit untouched, which is exactly what Glacier Instant Retrieval is priced for.

## Design detail (behind DESIGN.md §1 and §2)

### Packing several jobs onto one task: considered and rejected

Running about 8 jobs on one large task is roughly 10% cheaper per unit of work, because the per-task
overhead is paid once instead of eight times. Rejected for three reasons.

- **The sizes do not line up.** Fargate sells 1, 2, 4, 8 or 16 vCPU. Aiming for 10 concurrent jobs forces
  the 16 vCPU tier and its 32 GB floor, so you pay for six idle cores and 11 GB nobody uses. That lands
  about 35% worse than scaling out.
- **Blast radius multiplies.** An OOM kills the whole task, so one bad job becomes eight orphaned
  conversions and eight redeliveries. That is exactly the condition the fence exists to survive.
- **It does nothing for imports.** The converter runs in-process and Node runs JavaScript on one thread,
  so eight concurrent calls serialise while eight cores sit idle. Making it real would mean moving
  conversions into worker threads, which changes the thing we were told not to reimplement.

Saving 10% of the compute line, itself small next to S3, is not worth a tenfold blast radius.

### Why the risks rank the way they do

- **Ranked by immediacy, not severity.** The two orderings differ here, so it is worth saying which one
  was used.
- **Risks 1 and 2 are arithmetic.** A 40 GB package cannot go on a 20 GB disk, and 20 GB of demand cannot
  run in 4 GB of memory. Both fail on day one, every time. Both are also loud, so the first test run
  catches them.
- **Risk 3 needs a race, so it is less certain.** But it is silent, and that is what makes it worst:
  nothing in the proposal would notice, and a customer finds it weeks later. Third on immediacy, first on
  severity.
- **Risk 2 is the engine for Risk 3.** Every OOM kill leaves an unreaped subprocess and triggers a
  redelivery, which is how two attempts end up alive at once. A blocked event loop also cannot extend a
  visibility timeout, so healthy work gets redelivered too. Fixing the sizing removes most of the
  conditions for corruption but not the corruption itself, which is why both are fixed.

## Lifecycle details (behind the DESIGN.md §4 diagrams)

**The principle underneath all of it.** Duplicate work cannot be prevented. Duplicate publication can. An
orphaned conversion outlives the worker that started it, on a machine that may no longer exist, where no
signal can reach it. So the system lets it run and guarantees it can never publish. Duplicate work is
wasteful. Duplicate publishing is what corrupts data, and only that has to be impossible.

**Where ownership sits**

| Boundary | Owner |
|---|---|
| Job state | DynamoDB, the only source of truth |
| Work distribution and retries | SQS, never the state of record |
| Result bytes | S3, one file per attempt, never overwritten |
| Which attempt counts | The single conditional update |

- **Only one write needs fencing:** the conditional update that sets `outputKey` and `succeeded` if the
  writer still owns the job. S3 needs no protection, because no two attempts share a filename.
- **Safe ordering falls out for free.** The attempt file exists before the status changes, so the only
  possible window is "result ready, job still says running". The dangerous direction, "job says succeeded
  but the file is missing", cannot happen.
- **Retries come from SQS redelivery,** not from application bookkeeping. A worker that cannot finish
  simply does not delete the message. Job timeouts sit below the redelivery window (15 minutes against 20
  on imports, 90 against 100 on exports), so a retry never starts while an attempt is legitimately still
  running. The gap covers killing the subprocess and writing the final status.
- **Exit 2 is permanent, exit 137 is transient.** An invalid database will not convert on the fourth
  attempt any more than the first, so the job fails straight away with the reason recorded. Treating both
  the same way either wastes three attempts or permanently fails a job that would have worked.
- **Imports get no heartbeat.** A heartbeat is code that runs periodically, and a conversion that blocks
  the Node thread never lets it run. The timer just sits queued until the job has already finished. So the
  lease alone handles recovery on imports, set to the longest a job could take. This works whether or not
  the library yields to the event loop, which makes it the safer choice. A heartbeat that silently never
  fires would be worse than none. Fast detection buys little anyway: a dead worker stalls its own job, not
  the fleet, and under A1 nobody is waiting.
- **Killing is not enough, the subprocess must be reaped.** A timed-out JVM keeps running unless its owner
  terminates it and confirms it is gone. It holds memory and disk, and at one job per task it idles the
  whole task. It can also still finish and write its package, which is why publication is fenced rather
  than trusted.
- **Orphans cost more on exports.** An abandoned import attempt strands at most 500 MB. An abandoned
  export attempt strands up to 40 GB, on the line that is already 96% of the bill. The lifecycle rule that
  clears unreferenced attempt prefixes matters much more here.

## Part 2: what changed in the worker

Three fixes, each the code version of a decision in DESIGN.md §4.

1. **Fenced publication.** Claiming a job is one atomic compare-and-swap, so of two deliveries arriving
   together only one starts a conversion. Each attempt writes to its own key, and a single fenced write
   decides which attempt counts. A slow attempt that returns after a newer one has published loses that
   write and leaves its file unreferenced.
2. **Kill and reap on timeout.** A timed-out subprocess is terminated and confirmed gone before any
   retry-or-fail decision.
3. **Exit-code classification.** Exit 2 fails the job immediately without spending retries. Everything
   else, including exit 137, is treated as transient.

### Interface changes, and why

- **`JobStore.put` removed, replaced by `compareAndSwap`.** A read followed by an unconditional write is
  check-then-act, which is the defect itself. Leaving `put` on the interface would leave the same footgun
  for the next person. Now every write has to state what it expects to be true, which maps straight onto
  a DynamoDB conditional expression.
- **`RunningConversion.completion` returns a number instead of void.** Classification needs the exit code.
  An invalid input file is an expected outcome, not an exceptional one, so it belongs in the return value
  rather than in a thrown error.
- **`Job` gains `owner`.** Correctness comes from `attempt` acting as the fencing token. `owner` is there
  for legibility and debugging.
- **`handle()` gains a `WorkerConfig`.** Replaces the hardcoded 30 second timeout, which would have killed
  every real job of either kind, and the hardcoded retry limit. This is also what lets one codebase serve
  both lanes.
- **No `leaseExpiresAt`, even though DESIGN.md §4 says "unowned or lease expired".** In this handler the
  SQS visibility timeout is the lease. It sits above the job timeout, so a redelivered message already
  means the previous attempt overran. A worker reading `(running, N)` and swapping to `(running, N+1)` is
  exactly the take-over the design describes, and it fences the previous attempt out of publishing. A
  separate expiry timestamp would add surface without adding safety.

### Verification

Seven tests, run with `npm test`. Five were confirmed to fail against the original logic by temporarily
restoring it behind the new interfaces and running the suite again: duplicate conversions, stale
overwrite, shared output keys, missing kill, and exit 2 retries all reproduce. The two that pass either
way, transient retry and terminal-state ack, guard behaviour the original already had right.

### Not fixed in the worker, and why

- **Retry backoff and jitter.** Not in the starter, and not needed to demonstrate these fixes. SQS
  redelivery timing would carry it.
- **Lease renewal and heartbeat.** Imports get none by design. The export heartbeat belongs to the poll
  loop.
- **The poll loop itself.** Out of scope per the brief.
- **`Clock.timeout` leaves a timer pending** when the conversion wins the race. `Promise.race` attaches a
  handler so nothing goes unhandled, but the timer survives. Harmless per job, wasteful at volume. A
  cancellable timeout is the fix.
- **Submission idempotency keys.** See Remaining risks.

## Where I stopped

Part 1 is complete. Part 2 has the three fixes above with tests. Still open:

- **DESIGN.md §4 open items:** whether `failed` is terminal (and whether exit 2 and exhausted retries
  should share that state), concrete lease durations per lane, and webhook handling.
- **Measurements M1 to M5 in WORKING.md are unrun.** Four of the six numbers behind the task sizing are
  judgment rather than fact, and one test run each would settle them.
- **DD1:** export lane vCPU, deferred pending M3.
- **Worker metrics.** See Remaining risks.

With more time, in order: confirm A4 with a product owner, since it is worth about 92% of the monthly
bill; run M1 to M5; then emit the metrics §5 depends on.

## How I used AI

I used Claude Code throughout, but for different things at different stages.

- **Explaining mechanics I had not used directly.** ECS Fargate, the difference between a task definition
  and a task, SQS visibility timeouts and how they interact with retries. I asked for pros and cons and
  picked from them.
- **Drawing the diagrams.** I gave rough pointers for what each flowchart and state diagram should show
  and had it produce them, then corrected the details.
- **Planning and writing the code.** Once the design was settled, I had it write a plan of action for the
  worker changes based on my design, and then make those changes and the tests.
- **Checking my reasoning.** Where it disagreed I made it show the arithmetic rather than take its word.

**What I decided myself.** Two queues instead of one. One repository and image with two task definitions.
One job per task. The fencing model for publication. The three ranked risks and the three things left
alone. Which of the four cost levers to pursue.

**What I corrected.**

- It started drafting document sections before I had decided what went in them. I stopped it twice and
  told it to ask questions instead.
- Its first NOTES.md draft was long prose. I asked for pointers and moved the detail into WORKING.md.
- It suggested doing Part 2 before Part 1. I pushed back, because the worker changes encode design
  decisions that Part 1 has to settle first, and it agreed.
- It proposed 2 vCPU for the export task, then found its own arithmetic made that 53% more expensive for
  single-threaded work and revised to 1 vCPU. I recorded it as DD1 rather than letting it change quietly.

**What it caught that I had missed.** That I had carried "10 messages concurrently" into my own design
summary after we had ruled it out. And that my fix for the stale-write problem, read the status then
write, was the same check-then-act race in a different place.

**External material.** I read a published article on the long-running-task pattern and had Claude compare
it against this design. Most of it confirmed decisions already made. It surfaced one real gap: I had
prevented duplicate execution but not duplicate submission, which is now in Remaining risks.
