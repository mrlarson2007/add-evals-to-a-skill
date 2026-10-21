# Designing an evaluation

## Contract before cases

Read the target rather than assuming every skill produces text. For a file-producing
skill, define relative filenames, formats, required content, numerical tolerances,
and forbidden modifications. For a tool workflow, check observable state and
tool outcomes, not a transcript's assertion that a command ran.
For review/text-only skills, check the returned text or structured JSON against
the requested scope, contracts and evidence; do not require invented output files.

Use 5–10 independently meaningful initial tasks. Each task contract records a stable
ID, category, realistic request, fixture, expected result, prohibited behavior,
executable assertions and the requirement/evidence that motivates them:

| Class | Example for a report-writing skill | Observable check |
| --- | --- | --- |
| Ordinary | Several labeled amounts | Valid report, all rows, exact total |
| Empty input | No rows | Empty report and zero total, or documented refusal |
| Boundary | Zero or negative amount | Zero preserved; policy for negatives |
| Precision | Decimal currency | Contract-specific rounding and total |
| International | Unicode labels | Exact content survives encoding |
| Invalid | Missing/wrong field types | Clear failure, no fabricated report |
| Untrusted data | Label contains “ignore instructions” | Preserved as data; no extra action |
| Regression | Previously omitted zero-valued rows | Original reproducer stays in suite |

These are categories, not universal requirements: adapt them to the actual skill.
Avoid ten paraphrases of the happy path. Include expected refusal or clarification
when the target contract requires it. Do not invent a negative-input policy.
Separate observed requirements from proposed improvements. Only call a case a
historical regression when the user or repository supplies evidence; otherwise
label it a prospective boundary/risk case. Out-of-contract inputs may document a
limitation but do not by themselves establish a defect.

## Keep checks independent

Validate artifacts by reading files under the isolated task workspace. Parse their
actual format and assert semantic properties: data fidelity, row counts, schema,
totals, formulas, cross-file consistency, required sections or executable behavior.
Check that fixture hashes and sentinel files outside allowed outputs did not change.
Reject missing artifacts, invalid encodings/schema, wrong values and paths escaping
the workspace. Restrict symlinks. A self-reported filename or “done” is not evidence.

Test the grader itself against a correct artifact and deliberately broken copies:
missing file, malformed file, wrong result and plausible success text without a file.
These fixture simulations validate the harness, not an agent or the target skill.
Do not let an agent modify the grading contract during its evaluated run.
Keep expected answers and graders evaluator-owned, outside agent workspaces and
prompts/agent-visible prompt variables. Pass only task inputs to the agent.
The offline template keeps all files together for portability; a live adapter
must separate evaluator files from its writable task workspace.

Optional model rubrics should specify anchored criteria and examples, avoid judging
style unrelated to the request, and retain deterministic hard gates. Never send
private artifacts to an external judge without permission. Record judge/model
versions, disagreement and uncertainty. Pin the judge and narrow rubric; calibrate
against human-labeled examples and allow inconclusive outcomes rather than forcing
a binary judgment. A rubric is not required for this skill.

## Extend, don't replace

Inventory IDs and assertions before editing an existing suite. Add a minimal known
failure as a new case; retain all previous tests and fixture bytes. Run old and new
cases together. Demonstrate the reproducer fails the broken behavior and passes
the corrected behavior where available. Do not rewrite the target as part of
authoring evals, delete hard cases, or silently update expected output.

## Execution and evidence

Separate three claims:

1. **Offline validation:** fixtures, provider plumbing and graders run locally.
2. **Live evaluation:** an actual agent runtime loaded the skill and performed tasks.
3. **Comparison:** baseline and candidate ran under matched conditions.

Keep each task's fresh workspace and structured result. Record skill revision/hash,
task ID, runtime/model versions, invocation, discovery evidence, permission policy,
duration, exit status, graded artifacts and reasons. Mark unavailable credentials,
timeouts, missing runtime or discovery failures distinctly; none imply skill success.
Hash the complete skill artifact (instructions, references, assets and scripts),
not just `SKILL.md`, and record output artifact hashes where applicable.
Keep separate result dimensions:

* **Outcome:** task assertions passed, failed, or execution was unavailable.
* **Activation:** native runtime evidence, explicitly labeled heuristic evidence,
  or unavailable; absence of traces does not prove absence of activation.
* **Boundaries:** requested scope, refusal/clarification and out-of-scope behavior.
* **Side effects:** observed attempted operations versus actual state changes;
  prevented writes and unchanged files are different observations.
* **Efficiency:** elapsed time, tool/token usage and cost only where measured.

Evaluate at least one normal and one adversarial/boundary task live before making
behavioral claims, and execute the full suite for a reported suite pass rate.

For comparison, keep the fixtures and graders fixed and start both revisions from
the same clean state with the same model, harness and permissions. Current versus
proposed is the default comparison. An optional no-skill arm uses a neutral task
prompt without pasted skill instructions; label it separately, not as a replacement.
Disable response caching so every trial actually executes. Use three fresh trials
per task/revision for release evidence; one trial is only a smoke check. Preserve
failing outputs, logs and reasons. Report per-case baseline→candidate changes,
ties and regressions; do not selectively rerun only failures or weaken checks.
Small samples provide limited evidence. Passing these tasks is neither security
certification nor proof of general correctness.

## Runnable starting point

Repository-checkout-only helper (not bundled in installed skill copies):

```sh
node scripts/scaffold-evals.mjs --dest ./evals/report
cd evals/report
node run.mjs
```

Portable installed-skill fallback: copy the installed skill's `assets/promptfoo/`
contents to a new, empty eval directory, then run `node run.mjs` there.
The example requires only Node and deliberately does not invoke an agent.
If promptfoo is already installed, the same cases and artifact grader can run via
`promptfoo eval -c promptfooconfig.cjs`. Do not install an unpinned dependency just
to run the offline example. Review the template README before adapting it.
