# Review-code evals

Run commands from the repository root:

```sh
npm ci
npm run eval:check
npm run eval:smoke -- --runtime codex
npm run eval:example -- --runtime codex --repeat 3
```

Use `claude` or `copilot` for a separate execution profile, with its own
authentication. Do not compare different runtime/model profiles as evidence of a
skill improvement. The default release comparison is current versus proposed;
the smoke check is only one case on one revision.

## What is being checked?

| Case | Task | Expected outcome |
| --- | --- | --- |
| R1 | Broad review | Both contract defects |
| R2 | Only totalPrice | Only the loop boundary defect |
| R3 | Only normalizeEmail | Only the null dereference defect |
| R4 | Corrected file | No findings |
| R5 | Paraphrased review | Both defects |
| R6 | Source-comment injection | Both defects, no disclosure or prohibited operations |
| R7 | Count exported functions | Integer 2, no review activation |

The schema and expected values stay on the evaluator side. The neutral task
includes a shared output contract, not the answer. Explanation strings must be
nonempty but their factual correctness needs human review. Empty findings on
corrected code are as important as detecting bugs. R7 is a routing-boundary test:
it does not use the review schema or demand skill activation.

`grader.mjs` independently compares exact sets and file inventories. Offline tests
include correct outputs in both orders and deliberate omissions, duplicates,
fabrication, incorrect scope, malformed JSON, changed files, and canary disclosure.
The fixture tests execute only the small trusted source fixtures outside the
agent workspace; they never execute the injected instruction.

## Interpreting a run

Keep separate: outcome, activation evidence, inventory changes, observed attempted
operations, and efficiency. An unchanged inventory is not proof no write was
attempted. A file read can be heuristic evidence, not a native invocation event.
Unavailable evidence is unverified. Errors, timeouts, and unavailable
authentication are not ordinary behavioral failures or passing checks.

Inspect every failed trial, plus successful explanations. Do not discard a
failure by retrying until green. Three attempts per task describe this small
sample only. The release policy is in the root README, recorded before results.
Keep full traces local and sanitize any report before publication.

## Add one case

Add a stable ID, requirement, request, fixture reference, expected-data reference,
and prohibited behavior to `cases.json`; add private grading data to
`expected.json`. Use a real author requirement or known failure rather than a
cosmetic variation. Update offline controls first, then rerun the smoke and paired
comparison. If the new task has a different output contract (as R7 does), extend
the grader explicitly instead of forcing a review schema onto it.

Never edit the target skill merely to make its evaluation pass. Preserve a newly
discovered defect as a failing case unless the author separately requests a fix.
