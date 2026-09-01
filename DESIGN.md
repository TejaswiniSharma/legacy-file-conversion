# Design Review: Legacy File Conversion Service

<!-- Target: ~2 pages + optional diagram. -->

## 1. Risk ranking

<!-- Three risks to address first, ranked, each with the failure or customer impact behind it. -->

### Deliberately left alone

<!-- Two things, each with the evidence or threshold that would cause a revisit. -->

## 2. Smallest changes before v1

## 3. Job lifecycle

<!-- One import and one export end to end: state ownership, retry boundaries,
     result publication, how the caller learns the outcome. -->

### Import

### Export

## 4. Operations, deployment, and observability

### Three operational signals

<!-- Each: the metric, where it is emitted, a rough threshold, the action it should cause. -->

### How a change reaches production

<!-- One paragraph, no more: pipeline stages, detecting a bad release, stopping/reversing it. -->

## 5. Sizing and cost

### Onboarding evening (3,000 jobs)

### Monthly bill at normal volume

<!-- Biggest line item + the single change that would cut it the most. Show the arithmetic. -->
