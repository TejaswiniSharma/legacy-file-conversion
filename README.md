# ITpipes — Legacy File Conversion Service

Submission for the platform homework exercise.

- [`DESIGN.md`](DESIGN.md) — design review of the proposed architecture.
- [`NOTES.md`](NOTES.md) — assumptions, remaining risks, where I stopped, and how I used AI.
- [`src/worker.ts`](src/worker.ts) — the revised per-message worker.
- [`src/worker.test.ts`](src/worker.test.ts) — focused tests covering the repaired behaviour.

## Requirements

Node.js >= 22.6. Nothing else — the tests run straight from TypeScript source using Node's
built-in test runner and type stripping, so **no `npm install` is required.**

## Running the tests

```
npm test
```

Equivalently, without npm:

```
node --experimental-strip-types --test src/*.test.ts
```

## Type checking (optional)

Requires `npm install` to pull in TypeScript.

```
npm run typecheck
```
