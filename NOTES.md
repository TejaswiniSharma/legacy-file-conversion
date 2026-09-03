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

## Where I stopped

<!-- What I did not fix and why; what I would do next with more time. -->

## How I used AI

<!-- What I asked it to do, what I accepted, what I rejected or corrected. -->
