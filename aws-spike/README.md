# aws-spike

**Not part of the submission.** The submission is `DESIGN.md`, `NOTES.md`, and the worker plus tests in
`src/`. This folder is what I built afterwards to check my own claims against real AWS rather than
trusting them.

`OBSERVATIONS.md` in this folder is the write-up: what I ran, what happened, and the four things I only
learned by running it.

## What it proves

The worker in `../src/worker.ts` is imported directly here, not copied, so this cannot drift from the
submitted code.

| Claim in DESIGN.md | Checked by |
|---|---|
| Two deliveries cannot both claim a job | `scripts/race-claim.ts`, against real DynamoDB |
| A stale attempt cannot overwrite a published result | `scripts/race-publish.ts` |
| Retries come from not deleting the message; exhausted ones reach the DLQ | `scripts/redelivery.ts` |
| The whole lifecycle works on Fargate | `src/poll-loop.ts` in a container |
| Queue depth drives capacity from zero and back | the scaling policies in `scripts/create-alarms.sh` |

## What is a stand-in

- **The converters.** The real ones are a TypeScript library and a vendor JVM binary, neither of which I
  have. `src/fake-converter.ts` sleeps and then exits with a code chosen by the input filename:
  `ok.mdb` exits 0, `corrupt.mdb` exits 2, `oom.mdb` exits 137, `slow.mdb` never finishes.
- **Ingest.** `scripts/submit-job.ts` stands in for API Gateway and Lambda: it writes the job row, then
  enqueues. That order matters, and it is the order the design specifies.
- **Result bytes.** Nothing is written to S3. The fencing is about *which attempt is allowed to publish*,
  which is decided in DynamoDB, so S3 is not needed to test it.
- **Timeouts.** Defaults are the design's ceilings (15 and 90 minutes). `JOB_TIMEOUT_MS` shortens them so
  a hung conversion can be watched inside a demo.

## Running it

Requires AWS credentials and Docker. Costs pennies; `scripts/teardown.sh` removes everything.

```
npm install                          # AWS SDK clients, in this folder only
./scripts/setup-queues.sh            # two queues, two DLQs, correct visibility timeouts
./scripts/setup-iam.sh               # the execution role and the task role
./scripts/create-alarms.sh           # the three signals from DESIGN.md section 5
```

The table is created separately:

```
aws dynamodb create-table --table-name itpipes-jobs \
  --attribute-definitions AttributeName=jobId,AttributeType=S \
  --key-schema AttributeName=jobId,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

Then the two race checks, which need no container:

```
node --experimental-strip-types scripts/race-claim.ts
node --experimental-strip-types scripts/race-publish.ts
node --experimental-strip-types scripts/redelivery.ts
```

Locally, end to end against real AWS:

```
node --experimental-strip-types scripts/submit-job.ts ok
JOB_TIMEOUT_MS=5000 POLL_SECONDS=30 node --experimental-strip-types src/poll-loop.ts import
```

On Fargate:

```
./scripts/deploy.sh                  # build, push, register, run one task
```

Then tear it down:

```
./scripts/teardown.sh
```

## Notes on the code here

**No account id is committed.** `task-def-import.json` and `iam/worker-policy.json` are templates using
`${AWS_ACCOUNT_ID}` and `${IMAGE_TAG}`; the scripts substitute real values at run time from
`sts get-caller-identity` and the current commit. Networking ids are derived from the default VPC rather
than stored, so this runs in any account.

**Images are tagged by commit, not `latest`.** With a moving tag, two task-definition revisions can
resolve to different images over time, and a rollback stops being reproducible.

**`src/poll-loop.ts` is the piece the exercise left out.** It receives one message at a time, which is the
concurrency decision in DESIGN.md section 1, and handles `SIGTERM` by finishing the job in flight before
exiting. That graceful shutdown only works here because the fake converter yields; the real in-process
import converter would block the thread and never see the signal. That limitation is real and is recorded
in `NOTES.md`.
