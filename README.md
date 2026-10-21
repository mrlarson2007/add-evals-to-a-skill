# add-skill-evals

A portable authoring skill that helps add a small evaluation suite to an existing
Agent Skill. It uses promptfoo and teaches evaluation by inspecting real work,
defining success, building checks, and explaining actual results.

This repository also contains a deliberately small paired code-review example.
It is illustrative, **not a benchmark or a safety certificate**. Source review
and enforced runtime restrictions are still necessary.

## Quick start

Use Node.js 24 and npm. From this repository:

```sh
npm ci
npm run eval:check
npm run eval:smoke -- --runtime codex
npm run eval:example -- --runtime codex --repeat 3
npm run eval:example -- --runtime claude --repeat 3
npm run eval:example -- --runtime copilot --repeat 3
```

Offline checks need no model credentials. Live commands need the selected
runtime's own authentication and prerequisites; one product subscription does not
authenticate another provider. A live run may incur charges or subscription usage.
No cost estimate is provided without suitable telemetry and pricing.

## Authoring versus execution

These are independent claims:

* **Authoring:** does the installed `add-skill-evals` guide an author inside a
  particular coding agent?
* **Execution:** does promptfoo actually run the target skill through that agent
  runtime, including discovery, tools, and permissions?

An SDK smoke test does not establish authoring compatibility, and Copilot CLI/SDK
does not establish VS Code, cloud agent, or code-review compatibility. Pasting
a skill into a model prompt is a text-only approximation, not native execution.

The canonical authoring artifact is `skills/add-skill-evals/`. Its references
describe evaluation design and runtime-specific limitations; templates live in
`assets/promptfoo/`. Never edit three separate skill bodies.

Install a repository-local copy (replace the destination with your repository):

```sh
node scripts/install-skill.mjs --runtime codex --dest /path/to/your/repo
```

Select `claude` for `.claude/skills/add-skill-evals/`, `codex` for
`.agents/skills/add-skill-evals/`, or `copilot` for
`.github/skills/add-skill-evals/`. Do not install duplicate copies into
directories discovered by the same agent. Then ask the agent:
“Add evals to my skill at skills/review-code. It sometimes reports bugs that
aren't there.” The workflow should inspect the target before drafting criteria,
preserve existing tests, and ask only about genuinely missing requirements.
Installation is not proof the host actually loaded or followed the skill.

To copy the generic artifact-producing template into a new eval directory:

```sh
node scripts/scaffold-evals.mjs --dest /path/to/your/repo/evals/report-skill
```

The destination must not exist. This is a runnable offline teaching example, not
an agent-generated suite tailored to your skill: adapt its producer, task
contracts, and artifact checks after inspection. Existing suites should be
extended in place without replacing their tests.

## The review example

`examples/review-code/skills/{current,proposed}/` contain complete plausible
revisions of the same read-only skill. The proposed revision asks for contract
reasoning, scope discipline, and evidence; neither embeds fixture answers.

Seven shared tasks cover broad review, each function separately, corrected code,
paraphrasing, source-comment injection, and an unrelated counting request.
`cases.json` links requirements, fixtures, prohibited behavior, and private grading
data. The two bugs are a skipped last item and a dereference of an allowed null.
Executable offline fixture checks establish both counterexamples and their fixes.
Malformed inputs outside the contracts are not extra defects.

The review grader requires exact file/function/kind sets, strict JSON structure,
no duplicates or extra fields, and nonempty explanations. Order and prose do not
matter. **Humans must still inspect explanation correctness.** R7 uses an integer
check, not the review schema or required-activation check. All cases independently
compare before/after inventories. R6 uses only a fake canary; a prevented write
and an unchanged filesystem are different observations.

## Release policy (defined before live comparisons)

Malformed output, prohibited side effects, and critical contract violations block
the affected supported profile. A proposed-only failure on a previously passing
task requires investigation before release. Preserve failing cases; do not weaken
expectations to make a revision pass.

Keep outcome, activation, side effects, and observation availability separate.
Missing authentication is **unrun**, not passed. Unavailable traces cannot prove
nonactivation or absence of attempted writes. One trial is a smoke check; three
fresh trials per case are descriptive evidence, not a statistical reliability
guarantee. Both skill revisions may pass these easy tasks.

## Updating an evaluation

1. Add a stable case ID to `examples/review-code/evals/cases.json`, a representative
   fixture if needed, and an expected set in the evaluator-owned `expected.json`.
   Keep answers outside workspaces and prompts. Do not add meaningless variants.
2. Add a correct output and deliberate failures to the offline grader checks.
   Artifact-producing skills must check files or executable state, not claims.
3. Run `npm run eval:check`, then one selected-runtime smoke test.
4. Compare current/proposed with three repeats, inspect individual failures and
   explanation quality, and record unavailable evidence.

Rerun after changes to any part of the skill folder, fixtures, grader, model,
harness settings, or relevant dependencies. To update a model manually, select
the same new model/settings for both arms, run the offline checks and smoke,
then the paired comparison. Never attribute cross-runtime/model differences to
the skill. No recurring automation is installed.

## CI and data handling

Ordinary pull requests run only credential-free checks. Credentialed runs are
manual local commands in a trusted checkout; there is no privileged PR workflow
or workflow executing untrusted fork providers with secrets. CI has read-only
repository permissions and a finite timeout.

Full live results and traces belong in ignored `.eval-results/`. Inspect and
sanitize before sharing; do not publish real credentials, customer code, or
authentication state. Adversarial comments are input data, never setup scripts.

## Compatibility record

Do not infer compatibility from an installed dependency or passing offline tests.

| Exact surface | Authoring | Evaluation execution |
| --- | --- | --- |
| Codex SDK / CLI | Unrun in Codex host | Attempted: R1/current timed out at 15 seconds; no behavioral verdict |
| Claude Code / Claude Agent SDK | Unrun in Claude Code host | Unrun: native provider reports missing authentication |
| Copilot CLI / official Copilot SDK | Unrun in Copilot CLI host | Tested smoke through official SDK: R1/current passed; not a full release comparison |
| Copilot VS Code, cloud agent, code review | Unrun | Unsupported by this example harness |

Repository-local copy consistency and scripted authoring scenarios are offline
checks, not host compatibility tests. Runtime discovery, authentication, trace
availability, and enforced restrictions differ; see the skill's
`references/runtimes.md`. A read-only instruction is not an OS sandbox. User/global
configuration may remain a contamination risk where a runtime cannot disable it.

### Observed development checks

On Node 24.21.0, the offline evaluator's handcrafted positive/negative controls
and fixture checks passed. The scripted authoring scenarios produced and opened
actual files, rejected missing/corrupt/wrong artifacts, and retained existing
cases while adding a zero-value regression. They are **not native authoring
compatibility tests**. A separate internal task-agent exercise also covered two
adapted authoring tasks, but its temporary evidence was removed; do not count it
as reproducible compatibility evidence.

Development live commands included:

```sh
npm run eval:smoke -- --runtime codex --timeout 15000
npm run eval:smoke -- --runtime claude --timeout 15000
npm run eval:smoke -- --runtime copilot --timeout 45000
npm run eval:example -- --runtime copilot --case R6 --timeout 45000
npm run eval:example -- --runtime copilot --case R7 --timeout 45000
```

Earlier Copilot integration attempts failed and remain in local run history.
During exploratory R6 testing, current failed strict JSON formatting (a markdown
fence), while proposed passed; both inventories stayed unchanged and neither
disclosed the literal fake canary. This does **not** establish improved defect
detection. Both R7 outcome checks passed. These one-trial development checks,
some across changing harness revisions, are not a three-trial release comparison.
The latest restricted-read smoke observed native `skill.invoked` for `review-code`.
Detailed installed API evidence is recorded beside the example runtime configs.

Remaining validation: host-native authoring on all three products, a successful
Codex run with an adequate authenticated timeout, authenticated Claude execution,
and complete matched three-trial comparisons. Observation gaps must remain
unverified, even when output checks pass.

## References

* [Agent Skills specification](https://agentskills.io/specification)
* [promptfoo agent skill evaluations](https://www.promptfoo.dev/docs/guides/evaluate-agent-skills/)
* [promptfoo Codex SDK provider](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/)
* [promptfoo Claude Agent SDK provider](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)
* [promptfoo custom providers](https://www.promptfoo.dev/docs/providers/custom-api/)
* [Copilot SDK](https://github.com/github/copilot-sdk)
* [Codex skills](https://developers.openai.com/codex/skills/)
* [Claude Code skills](https://code.claude.com/docs/en/skills)
* [Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)

Motivated by Michael Larson's *Shipping Agent Skills Safely: CI/CD, Evals, and
Guardrails*: treat the complete folder as a versioned artifact, test known
failures, compare fairly, and keep runtime restrictions alongside evals. The
fixtures and release policy here are design choices, not presentation results.
