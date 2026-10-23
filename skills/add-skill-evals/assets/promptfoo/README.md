# Offline artifact example

This is a deterministic report-writing stand-in, **not** an agent, a target-skill
evaluation, or evidence that a runtime discovered a skill. Requires Node 20+ only.

```sh
node run.mjs
```

Seven cases cover normal, empty, zero, decimal, Unicode, malformed and untrusted
input. The provider writes a real `report.json` in a fresh `.runs/` directory.
The grader opens that file and checks schema, row fidelity and totals against
independent case expectations. A transcript claiming success cannot pass.
Results and artifacts remain under `.runs/`; do not commit them.
Expected answers are looked up by case ID, never placed in prompt variables.
For live adapters, keep this evaluator-owned directory outside agent workspaces
and pass only task requests/fixtures to the runtime.

If promptfoo is already available:

```sh
promptfoo eval -c promptfooconfig.cjs --no-cache
```

The config uses the documented [custom script provider](https://www.promptfoo.dev/docs/providers/custom-script/):
promptfoo passes the rendered prompt as the first argument; stdout is the response.
The [JavaScript assertion](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)
receives `(output, context)` and returns `{ pass, score, reason }`.
Run commands from this directory. `--no-cache` matters: cached text is not a
newly generated artifact. No model or API key is needed for this example.

## Adapt to a real skill

1. Read its contract; replace `cases.json` with 5–10 relevant tasks and fixtures.
2. Replace `provider.mjs` with your existing runtime adapter, executing each task
   in a fresh isolated workspace. Return only a machine-readable artifact location
   and execution status; retain logs separately. Do not let output choose arbitrary
   filesystem paths for the grader.
3. Replace report-specific checks in `grader.cjs` with independent checks of the
   target artifacts, including permitted paths and unchanged input/sentinel hashes.
   Preserve checks already present when extending an existing suite.
4. Exercise good and deliberately corrupt artifacts offline, then run real agent
   tasks with explicit budgets/permissions. Record those as separate results.
5. Compare baseline and candidate using the same cases and graders; do not
   substitute this deterministic producer for either live runtime.

The template grader treats artifacts as untrusted, but is not a process sandbox.
Live runtime isolation and host security must be provided by the caller.
