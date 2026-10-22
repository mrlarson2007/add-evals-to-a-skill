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

Useful options:

```sh
npm run eval:example -- --runtime copilot --dry-run
npm run eval:smoke -- --runtime copilot --case R6 --variant proposed
npm run eval:example -- --runtime copilot --repeat 3 --no-skill --model YOUR_MODEL_ID
```

Dry runs prepare files/configuration without model calls. Smoke uses exactly one
case and the first selected variant (current by default). A normal seven-case,
current/proposed comparison with three repeats plans 42 provider invocations;
`--no-skill` adds 21. Each agent trial may make multiple underlying model calls.
`--variant current,proposed` selects arms explicitly. Runs are serial,
cache-free, and bounded by `--timeout` milliseconds per trial. For a release
comparison, select an explicit runtime-supported `--model` for both arms; an
unobserved runtime default cannot establish a fixed resolved model.

Every `no-skill` trial also requires observable nonactivation, not just a correct
answer: an inherited `review-code` invocation or invocation attempt fails the
baseline, and missing activation evidence leaves it unverified. This applies to
all cases, not only the unrelated routing task.

Each live trial uses promptfoo's evaluator and file assertion, retaining
`promptfooconfig.json`, `promptfoo-report.json`, independent inventories, and a
result in ignored `.eval-results/`. Summaries show raw successes/attempts and
individual failures, errors, timeouts, and unavailable observations. `FAIL` exits
1; missing required evidence is `UNVERIFIED` (exit 2), not a pass. Dry runs are
never executions. Inspect outcome and profile status separately.

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

### Test the authoring experience

The five scripted authoring/install tests are template and utility checks, not
tests of an agent following the skill. A separate opt-in test starts a fresh
Copilot SDK session against an unfamiliar nested shipment-index skill:

```sh
npm run eval:authoring -- --runtime copilot --model claude-sonnet-5.5 --timeout 300000
```

This is a credentialed, potentially billable command; it is never enabled by
ordinary offline CI. It installs the canonical authoring skill, verifies native
activation with the exact installed content, and gives the agent only the target
contract and scoped workspace tools. The target and installed skill remain
unchanged. After stopping the author session, independent probes run its generated
artifact grader against correct files and wrong totals, wrong identity/content,
missing/malformed files, and dropped zero-unit entries. A success message alone
cannot pass. The same generated grader is exercised through promptfoo.

Raw discovery events, skill hashes, generated suites, source reviews, failures,
and independent probe results stay local in ignored `.eval-results/authoring-*`.
A passing run supplies evidence about one installed-skill authoring scenario on Copilot CLI/SDK, not target
execution, other hosts, or a causal guarantee that the model needed the skill.
Default offline tests skip the credentialed scenario explicitly; to run it via
the test runner, set `AUTHORING_LIVE=1`.

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
| Copilot CLI / official Copilot SDK | Tested in the scoped-tool SDK profile: fresh installed-skill authoring on an unfamiliar shipment-index target | Tested through official SDK: passing and malformed-output smoke attempts preserved; not release-verified |
| Copilot VS Code, cloud agent, code review | Unrun | Unsupported by this example harness |

Repository-local copy consistency and scripted authoring scenarios are offline
checks, not host compatibility tests. Runtime discovery, authentication, trace
availability, and enforced restrictions differ; see the skill's
`references/runtimes.md`. A read-only instruction is not an OS sandbox. User/global
configuration may remain a contamination risk where a runtime cannot disable it.
The development dependency profile is promptfoo 0.124.1, Codex SDK 0.163.0,
Claude Agent SDK 0.3.307, and Copilot SDK 1.0.25. The lockfile pins transitive
dependencies; per-run metadata must distinguish SDK versions from observed CLI
versions and leave unexposed values unknown.
The observed execution environment is Linux. Skill copies avoid symlinks for
Windows portability; Windows runtime/process-tree cleanup has not been verified.
The Windows timeout branch kills only the worker, not its descendants; do not
rely on it for bounded automated runs.
Codex's read-only sandbox does not by itself confine reads to the fixture.
External answer access or inherited configuration would invalidate a comparison;
do not treat that native profile as release-verified without a separate enforced
read boundary. Temporary directories prevent accidental discovery, not deliberate
filesystem traversal.

An optional **Linux, local-Docker** profile supplies a real filesystem/network
boundary instead of relying on that sandbox:

```sh
EVAL_CODEX_ISOLATION=docker npm run eval:smoke -- --runtime codex --model gpt-5.4 --timeout 180000
```

It requires the pinned native Codex executable, a running local Docker daemon,
and `OPENAI_API_KEY` or `CODEX_API_KEY` supplied through your normal secret
environment configuration. It does not mount personal CLI login state. The
profile imports an empty local image (no pull), mounts only the read-only fixture,
runtime binaries/libraries, and a restricted model relay, and uses a fresh HOME.
The container has no external network; the relay forwards only the fixed model
responses endpoint, keeping the real API key outside the agent.

Enforcement probes must deny evaluator/answer reads, fixture/host writes, and
arbitrary networking before native execution. Missing prerequisites or failed
probes fail closed; ordinary Codex authentication alone cannot verify isolation.
The CLI's inner sandbox is replaced by the outer read-only container boundary,
not disabled without a replacement. Outcome, heuristic activation, attempted
operations, and missing observations remain separate scoring requirements.
Codex activation evidence stays **heuristic**, never a native invocation event.
A complete native trace containing only narrowly recognized literal read commands,
including a successful full skill-file read matching the installed content hash,
can satisfy the observable profile checks. Unknown commands, scripts, compound
shell expressions, or incomplete traces remain unverified; a read-only filesystem
alone does not prove that no write was attempted.

Claude's worker configures mandatory path-checking `PreToolUse` hooks and audits
reported tool coverage; these controls have offline contract checks but still
need authenticated native validation.

### Observed development checks

On Node 24.21.0, all 29 offline checks passed, including handcrafted
positive/negative controls, fixture checks, and read-boundary contracts. A clean
copy also completed `npm ci` and offline validation (using an explicitly recorded
temporary-directory override). The scripted authoring scenarios produced and opened
actual files, rejected missing/corrupt/wrong artifacts, and retained existing
cases while adding a zero-value regression. They are **not native authoring
compatibility tests**.

The focused follow-up exercised actual fresh-agent authoring through Copilot
SDK 1.0.25 / CLI 1.0.102 requesting `claude-sonnet-5.5`. A passing outside-checkout run
authored eight target-specific cases: 49 independent good/broken-file probes
passed, followed by two real promptfoo file-assertion probes (good accepted,
wrong total rejected). Native activation included the exact installed skill
body; target and installed artifact hashes remained unchanged. Generated grader
source was inspected: it opens the actual JSON files and checks ordered entries,
zero preservation, exact fields, and totals rather than transcript claims.
Earlier failed attempts remain in local evidence. This is one explicit-invocation
authoring scenario, not a causal ablation or a general compatibility guarantee.
The tested run used standalone sibling storage; the command now defaults to
an OS-temporary workspace outside the checkout and retains a workspace snapshot
with its evidence before cleanup.

Development live commands included:

```sh
npm run eval:smoke -- --runtime codex --timeout 15000
npm run eval:smoke -- --runtime claude --timeout 15000
npm run eval:smoke -- --runtime copilot --timeout 45000
npm run eval:example -- --runtime copilot --case R6 --timeout 45000
npm run eval:example -- --runtime copilot --case R7 --timeout 45000
```

Earlier Copilot integration attempts failed and remain in local run history.
Later smoke attempts also include markdown-fenced output rejected by the strict
JSON contract; a previous passing smoke does not erase these behavioral failures.
During exploratory R6 testing, current failed strict JSON formatting (a markdown
fence), while proposed passed; both inventories stayed unchanged and neither
disclosed the literal fake canary. This does **not** establish improved defect
detection. Both R7 outcome checks passed. These one-trial development checks,
some across changing harness revisions, are not a three-trial release comparison.
The latest restricted-read smoke observed native `skill.invoked` for `review-code`.
Its exposed runtime metadata identified Copilot CLI 1.0.102 and resolved model
`claude-sonnet-5.5`; this does not retroactively establish model matching in older
exploratory runs.
Manual inspection of a successful R1 response confirmed both explanations:
the loop omits the final item (including a singleton), and a permitted null user
throws instead of returning null. This inspection covers that response only.
Detailed installed API evidence is recorded beside the example runtime configs.

Remaining validation: native authoring on Codex and Claude, a successful
Codex run with an adequate authenticated timeout, authenticated Claude execution,
and complete matched three-trial comparisons. Observation gaps must remain
unverified, even when output checks pass.

Security validation: changed files passed secret scanning; CodeQL found no
JavaScript or Actions alerts. The automated review binary was unavailable, so
that tool's empty review is not evidence of a completed review. Dependency audit
results are recorded with the provider API evidence; a clean CodeQL scan does not
clear dependency advisories. `npm audit` reports three high-severity affected
packages through promptfoo → jks-js → node-forge (GHSA-86w9-cpqp-85rv).
The current node-forge release has no fix. These profiles do not use JKS
verification, but the dependency risk is unresolved; do not claim a clean audit.

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
