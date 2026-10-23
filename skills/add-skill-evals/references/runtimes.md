# Runtime discovery and live runs

Keep one canonical source at `skills/add-skill-evals/`. Installation copies its
bytes without changing frontmatter or instructions. Use only standard `name` and
`description` frontmatter; permission grants belong in the runtime invocation,
not in this portable skill.

## Project-local discovery

| Runtime | Installer location under `--dest` | Official reference |
| --- | --- | --- |
| Codex | `.agents/skills/add-skill-evals/` | [Agent skills](https://developers.openai.com/codex/skills) |
| Claude Code | `.claude/skills/add-skill-evals/` | [Extend Claude with skills](https://code.claude.com/docs/en/skills) |
| Copilot CLI | `.github/skills/add-skill-evals/` | [Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) |

The [Agent Skills standard](https://agentskills.io/specification) and
[Anthropic's official examples](https://github.com/anthropics/skills#creating-a-basic-skill)
describe the shared `SKILL.md` structure. Copilot's documentation explicitly lists
`.github/skills`, `.claude/skills` and `.agents/skills` as project locations.
The installer deliberately refuses another installation in any of these locations:
some runtimes discover several, so duplicate copies can mask the source being tested.
An existing installation is accepted only when every file matches canonical bytes.

Repository-checkout-only installer (not included in the installed skill directory):

```sh
node scripts/install-skill.mjs --runtime codex --dest ./path-to-existing-repo
# Choose claude OR copilot instead, not all three in the same repository.
```

Without this repository's helper, copy the complete canonical skill directory
into exactly one selected project location above, preserving every byte; compare
the full directory inventory and file hashes before using it.

`--dest` is an explicit existing repository root (a `.git` directory or worktree
file is required). The installer rejects home directories and symlinked install
paths. It never installs to personal skill directories, overwrites a differing
copy, or alters the target skill under evaluation.

## Verify, don't infer

Documentation URLs and CLI flags change. Before a live run, inspect the installed
CLI's `--version` and `--help`, follow its current official documentation, and record
the exact version and supported noninteractive invocation in the run manifest.
Do not copy another runtime's flags or bypass sandbox/permission checks.

Use a fresh isolated repository/session with only the selected project skill
installation. Check ancestor repositories and runtime settings for inherited
skills, personal skills, plugins, instructions or tool grants; copying into a new
folder alone is not isolation. Disable or record inherited configuration using
documented runtime controls. Never delete or edit the user's personal configuration.

First request explicit use of `add-skill-evals` for a small authoring task. Capture
runtime discovery/tool evidence pointing at the installed `SKILL.md` and its
resources; a model saying “I used the skill” is not sufficient. Then evaluate the
target skill's output tasks in separate clean workspaces. Testing whether this
authoring skill writes a suite and testing whether the target succeeds are
different experiments.

Choose an allowlisted writable workspace; keep graders outside agent-writable
paths; bound time, tokens and cost. Deny network, secret access and destructive
operations unless explicitly required and authorized. Retain logs and artifacts
but redact secrets before sharing. Report absent credentials/runtime/discovery as
blocked or not run. Offline template runs cannot establish runtime discovery or
substitute for real agent authoring.

For comparisons, pin runtime, model, target revision, tasks, graders and permissions;
only the skill revision being compared changes. Include failures and uncertainty.

## Promptfoo execution profiles

Authoring installation above does not establish execution compatibility. Inspect
the installed promptfoo version and current provider documentation before emitting
configuration. The repository example initially pins promptfoo 0.124.1 and uses:

| Runtime under test | Execution integration | Authentication and limits |
| --- | --- | --- |
| Codex SDK | `openai:codex-sdk`, `working_dir`, read-only sandbox, no approvals or fixture-driven network | Follow Codex CLI/SDK authentication; do not assume Anthropic or GitHub credentials apply. Skill-read evidence can be heuristic. Read-only does not confine filesystem reads. |
| Claude Agent SDK | `anthropic:claude-agent-sdk`, `working_dir`, project settings, selected skills, read-only tools | The pinned promptfoo provider requires its documented Anthropic/Bedrock/Vertex authentication path; a Claude subscription alone is not assumed sufficient. Preapproved tools bypass permission callbacks: enforce path restrictions using mandatory hooks or an external sandbox. |
| Copilot CLI/SDK | Official SDK through a promptfoo JavaScript provider when no suitable native integration exists | Use Copilot's documented CLI/SDK login. Never substitute GitHub Models. Explicit skill directories and scoped permission callbacks are required; record actual native events only. |

Provider references:
[Codex](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/),
[Claude](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/),
[custom JavaScript](https://www.promptfoo.dev/docs/providers/custom-api/),
[Copilot SDK](https://github.com/github/copilot-sdk).
The repository's paired example demonstrates the concrete integrations; the
installed authoring skill must adapt them to the target's output and permissions,
not assume that this read-only review profile fits a file-producing skill.

Use strict structured output where the selected provider supports it, followed
by independent validation. Set finite per-trial deadlines, clean up runtime child
processes, disable live response caching, and run serially unless workspaces are
truly independent. Show the planned calls before execution. Do not invent
sampling, cost, trace, or resolved-model fields the provider does not expose.

A text-only model prompt containing a skill is an approximation, not a native
discovery/tools/permissions test. Record authoring and execution as independently
tested, failed, unrun, or unsupported, with exact surfaces and versions. Copilot
CLI/SDK evidence does not establish VS Code, cloud agent, or code-review behavior.
