import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeResponse, parseArgs, providerFor } from '../scripts/run-example.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('runtime parser defaults to paired variants, supports smoke, and rejects invalid inputs', () => {
  assert.deepEqual(parseArgs([]).variants, ['current', 'proposed']);
  assert.deepEqual(parseArgs(['--no-skill']).variants, ['current', 'proposed', 'no-skill']);
  const smoke = parseArgs(['--smoke', '--repeat', '3', '--runtime', 'claude']);
  assert.equal(smoke.repeat, 1);
  assert.equal(smoke.case, 'R1');
  assert.deepEqual(smoke.variants, ['current']);
  for (const args of [
    ['--runtime', 'unknown'], ['--repeat', '0'], ['--repeat', '1.5'],
    ['--timeout', 'NaN'], ['--variant', '../../elsewhere'], ['--case'], ['--wat'],
  ]) assert.throws(() => parseArgs(args));
});

test('provider profiles select native SDKs or the official Copilot SDK adapter', () => {
  const workspace = path.resolve(root, '..', 'runtime-contract-workspace');
  const artifact = path.join(workspace, '.agents/skills/review-code');
  const runDir = path.join(root, '.eval-results/contract');
  const options = { timeout: 1234, model: 'explicit-model' };
  const codex = providerFor('codex', workspace, artifact, options, runDir);
  assert.equal(codex.id, 'openai:codex-sdk');
  assert.equal(codex.config.sandbox_mode, 'read-only');
  assert.equal(codex.config.approval_policy, 'never');
  assert.equal(codex.config.network_access_enabled, false);
  assert.equal(codex.config.enable_streaming, true);
  const claude = providerFor('claude', workspace, artifact, options, runDir);
  assert.equal(claude.id, 'anthropic:claude-agent-sdk');
  assert.deepEqual(claude.config.setting_sources, ['project']);
  assert.equal(claude.config.permission_mode, 'dontAsk');
  assert.deepEqual(claude.config.skills, ['review-code']);
  assert(claude.config.custom_allowed_tools.includes('Skill'));
  assert(claude.config.disallowed_tools.includes('Bash'));
  const noSkillClaude = providerFor('claude', workspace, null, options, runDir);
  assert.deepEqual(noSkillClaude.config.skills, []);
  assert(!noSkillClaude.config.custom_allowed_tools.includes('Skill'));
  const copilot = providerFor('copilot', workspace, artifact, options, runDir);
  assert.equal(copilot.id, path.join(root, 'scripts/copilot-provider.mjs'));
  assert.deepEqual(copilot.config.skill_directories, [path.dirname(artifact)]);
  assert.equal(copilot.config.timeout_ms, 1234);
  for (const provider of [codex, claude, copilot]) {
    assert.equal(provider.config.working_dir, workspace);
    assert.equal(provider.config.model, 'explicit-model');
    assert(!('expected' in provider.config));
  }
});

test('trace observations distinguish discovery, invocation, and explicit mutation attempts', () => {
  const unknown = observeResponse({ metadata: {
    events: [{ type: 'session.skills_loaded', data: { skills: ['review-code'] } }],
  } });
  assert.equal(unknown.activation, 'unknown');
  assert.equal(unknown.writeAttemptCount, 0);
  const observed = observeResponse({
    raw: JSON.stringify({ items: [{ type: 'file_change' }] }),
    metadata: {
      skillCalls: [{ name: 'review-code' }],
      toolCalls: [{ name: 'Write' }, { name: 'Read' }],
      events: [
        { type: 'skill.invoked', data: { name: 'review-code' } },
        { type: 'harness.permission', request: { kind: 'write' } },
      ],
    },
  });
  assert.equal(observed.activation, 'observed tool invocation');
  assert.equal(observed.activationEvidenceCount, 2);
  assert.equal(observed.writeAttemptCount, 3);
  assert.equal(observed.attemptedWrites, 'observed');
  assert.equal(observeResponse({ raw: 'opaque trace' }).activation, 'unknown');
});

for (const runtime of ['codex', 'claude', 'copilot']) {
  test(`${runtime} dry-run copies full artifacts, keeps grading private, and removes isolated workspace`, async () => {
    const { stdout } = await execute(process.execPath, [
      path.join(root, 'scripts/run-example.mjs'), '--smoke', '--dry-run', '--runtime', runtime,
    ], { cwd: root });
    assert.match(stdout, /DRY RUN \(not executed\)/);
    const relative = stdout.match(/Local artifacts: (.+)/)?.[1];
    assert(relative);
    const runDir = path.resolve(root, relative);
    assert(runDir.startsWith(path.join(root, '.eval-results', path.sep)));
    try {
      const caseDir = path.join(runDir, 'R1-current-1');
      const input = JSON.parse(await readFile(path.join(caseDir, 'input.json'), 'utf8'));
      const before = JSON.parse(await readFile(path.join(caseDir, 'before.json'), 'utf8'));
      const after = JSON.parse(await readFile(path.join(caseDir, 'after.json'), 'utf8'));
      const result = JSON.parse(await readFile(path.join(caseDir, 'result.json'), 'utf8'));
      const discovery = runtime === 'claude' ? '.claude' : '.agents';
      assert.match(before[`${discovery}/skills/review-code/SKILL.md`], /^[a-f0-9]{64}$/);
      assert.equal(before[`${discovery}/skills/review-code/`], 'directory');
      assert.match(before['src/helpers.js'], /^[a-f0-9]{64}$/);
      assert.deepEqual(before, after);
      assert.equal(result.dryRun, true);
      assert.equal(result.pass, null);
      assert.equal(result.grade, null);
      assert.equal(result.error, null);
      assert.equal(result.unchanged.pass, true);
      assert.deepEqual(Object.keys(input).sort(), ['prompt', 'provider', 'workspace']);
      assert.match(input.prompt, /Review src\/helpers\.js/);
      assert(!Object.hasOwn(input, 'expected'));
      assert(!Object.hasOwn(input, 'vars'));
      assert(!input.workspace.startsWith(root));
      await assert.rejects(access(input.workspace), { code: 'ENOENT' });
      await assert.rejects(access(path.dirname(input.workspace)), { code: 'ENOENT' });
      await assert.rejects(access(path.join(caseDir, 'response.json')), { code: 'ENOENT' });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
}
