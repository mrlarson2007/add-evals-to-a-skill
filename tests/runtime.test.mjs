import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildPromptfooConfig, disclosureEvidence, execute as executeTrial, observedRuntime, observeResponse,
  parseArgs, profileVerdict, providerFor, scoreChecks, summarizeTrials, validatePromptfooConfig,
} from '../scripts/run-example.mjs';
import { checkCanary } from '../examples/review-code/evals/grader.mjs';
import { READ_ONLY_TOOLS, summarizeCopilotUsage, workspaceReadPermission } from '../scripts/copilot-provider.mjs';
import { claudeToolPermission, createClaudeHooks, readIsolation } from '../scripts/runtime-isolation.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('enforced Codex audit can verify covered reads without inventing a native activation event', () => {
  const metadata = {
    harnessIsolation: {
      kind: 'docker-native-codex', configured: true, freshHome: true, nativeLaunches: 1,
      filesystem: 'empty-root-explicit-readonly-mounts',
      network: 'none-with-model-only-unix-relay',
      probe: Object.fromEntries([
        'verified', 'readDenied', 'writeDenied', 'hostWriteDenied', 'networkDenied',
        'networkNamespaceOnlyLoopback', 'relayReachable', 'relayDeniesOtherPaths',
      ].map((key) => [key, true])),
    },
    harnessCodexAudit: {
      kind: 'strict-native-command-audit', verifiedSkillRead: true,
      activationTraceAvailable: true, writeAttemptTraceAvailable: true,
      writeAttemptCount: 0, skillReadAttemptCount: 1,
    },
  };
  const response = { metadata, raw: { items: [{ type: 'command_execution', command: 'cat SKILL.md' }] } };
  const observations = observeResponse(response);
  const isolation = readIsolation('codex', response);
  const checks = scoreChecks({
    caseId: 'R1', variant: 'current', grade: { pass: true }, unchanged: { pass: true },
    observations, runtimeFailed: false,
  });
  assert.equal(observations.activationEvidenceKind, 'heuristic');
  assert.equal(observations.activationReadVerified, true);
  assert.equal(profileVerdict({ caseId: 'R1', variant: 'current', checks, isolation, observations }).pass, true,
    'Synthetic consumer contract only, not a live Codex pass');
  assert.equal(profileVerdict({ caseId: 'R1', variant: 'no-skill', checks, isolation, observations }).pass, false);
  const unconfined = observeResponse({ ...response, metadata: { ...metadata, harnessIsolation: {} } });
  assert.equal(unconfined.activationReadVerified, false);
  assert.equal(unconfined.writeAttemptTraceAvailable, false);
  const unsupportedTool = observeResponse({
    metadata: {
      ...metadata, harnessCodexAudit: {
        ...metadata.harnessCodexAudit, verifiedSkillRead: false,
        activationTraceAvailable: false, writeAttemptTraceAvailable: false,
      },
    },
    raw: { items: [{ type: 'mcp_tool_call' }] },
  });
  assert.equal(unsupportedTool.activationTraceAvailable, false);
  assert.equal(unsupportedTool.writeAttemptTraceAvailable, false);
  const attemptedWrite = observeResponse({
    ...response, metadata: { ...metadata, harnessCodexAudit: { ...metadata.harnessCodexAudit, writeAttemptCount: 1 } },
  });
  assert.equal(scoreChecks({
    caseId: 'R1', variant: 'current', grade: { pass: true }, unchanged: { pass: true },
    observations: attemptedWrite, runtimeFailed: false,
  }).pass, false);
});

test('every no-skill case requires nonactivation, including inherited and attempted skill use', () => {
  for (const caseId of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
    for (const [response, wanted] of [
      [{ metadata: { events: [
        { type: 'skill.invoked', data: { name: 'review-code' } }, { type: 'session.idle' },
      ] } }, false],
      [{ metadata: { attemptedSkillCalls: [{ name: 'review-code', source: 'heuristic' }],
        events: [{ type: 'session.idle' }] } }, false],
      [{}, null],
      [{ metadata: { events: [{ type: 'session.idle' }] } }, true],
    ]) {
      const observations = observeResponse(response);
      const checks = scoreChecks({
        caseId, variant: 'no-skill', grade: { pass: true }, unchanged: { pass: true },
        canary: { pass: true }, observations, runtimeFailed: false, dryRun: false,
      });
      assert.equal(checks.routing.pass, wanted, caseId);
      assert.equal(profileVerdict({
        caseId, variant: 'no-skill', observations, checks, isolation: { verified: true },
      }).pass, wanted, caseId);
      // The final verdict also fails closed if a caller omitted baseline scoring.
      assert.equal(profileVerdict({
        caseId, variant: 'no-skill', observations, checks: { pass: true },
        isolation: { verified: true },
      }).pass, wanted, caseId);
    }
  }
});

test('Copilot default-denies outside, ambiguous, missing, write, and symlink-escape requests', async () => {
  const trial = path.join(root, '.eval-results', `permission-contract-${randomUUID()}`);
  const workspace = path.join(trial, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(trial, 'private-grader.json'), '{"notForAgent":true}\n');
  try {
    assert.equal((await workspaceReadPermission(workspace, { kind: 'read', path: 'source.js' })).kind, 'approve-once');
    assert.equal((await workspaceReadPermission(workspace, { kind: 'read', path: workspace })).kind, 'approve-once');
    for (const request of [
      { kind: 'read', path: '../private-grader.json' },
      { kind: 'read', path: path.join(trial, 'private-grader.json') },
      { kind: 'read', path: 'missing.js' }, { kind: 'read', path: '' },
      { kind: 'read' }, { kind: 'read', path: ['source.js'] },
      { kind: 'read', path: 'source.js', managedApprovalRequired: true },
      { kind: 'read', path: 'source.js', requestSandboxBypass: true },
      { kind: 'write', path: 'source.js' }, { kind: 'shell', path: 'source.js' },
    ]) assert.equal((await workspaceReadPermission(workspace, request)).kind, 'reject');
    if (process.platform !== 'win32') {
      await symlink(path.join(trial, 'private-grader.json'), path.join(workspace, 'escape.json'));
      assert.equal((await workspaceReadPermission(workspace, { kind: 'read', path: 'escape.json' })).kind, 'reject');
    }
  } finally { await rm(trial, { recursive: true, force: true }); }
});

test('Copilot read-only allowlist is source-qualified and retains the native skill tool', async () => {
  const { ToolSet } = await import('@github/copilot-sdk');
  assert.deepEqual(new ToolSet().addBuiltIn(READ_ONLY_TOOLS).toArray(),
    ['builtin:view', 'builtin:glob', 'builtin:grep', 'builtin:skill']);
});

test('Copilot usage sums documented token fields without treating billing multipliers as USD', () => {
  const data = (apiCallId, inputTokens, outputTokens) => ({
    apiCallId, inputTokens, outputTokens, cacheReadTokens: 4,
    cacheWriteTokens: 2, reasoningTokens: 1, cost: 1,
  });
  const usage = summarizeCopilotUsage([
    { type: 'assistant.usage', id: 'first', data: data('call-1', 10, 3) },
    { type: 'assistant.usage', id: 'duplicate', data: data('call-1', 10, 3) },
    { type: 'assistant.usage', id: 'second', data: data('call-2', 20, 7) },
    { type: 'session.usage_checkpoint', data: { inputTokens: 9999, cost: 9999 } },
  ]);
  assert.deepEqual(usage.tokenUsage, { prompt: 30, completion: 10, total: 40, numRequests: 2, cached: 8 });
  assert.equal(usage.reportedUsage.rawEventCount, 3);
  assert.equal(usage.reportedUsage.accountedCalls, 2);
  assert.equal(usage.reportedUsage.cacheWriteTokens, 4);
  assert.equal(usage.reportedUsage.reasoningTokens, 2);
  assert.deepEqual(usage.reportedUsage.reportedBillingCostValues, [1, 1]);
  assert.equal(usage.reportedUsage.monetaryCostUsd, null);
  assert.match(usage.reportedUsage.billingUnitLimitation, /not USD/);
});

test('Copilot missing usage fields stay unknown rather than zero or fabricated token totals', () => {
  const partial = summarizeCopilotUsage([{ type: 'assistant.usage', data: { outputTokens: 5, cost: 1 } }]);
  assert.equal(partial.tokenUsage, null);
  assert.equal(partial.reportedUsage.inputTokens, null);
  assert.equal(partial.reportedUsage.outputTokens, 5);
  assert.equal(partial.reportedUsage.cacheReadTokens, null);
  assert.equal(partial.reportedUsage.monetaryCostUsd, null);
  const missing = summarizeCopilotUsage([]);
  assert.equal(missing.tokenUsage, null);
  assert.equal(missing.reportedUsage.inputTokens, null);
  assert.deepEqual(missing.reportedUsage.reportedBillingCostValues, []);
});

test('promptfoo reports retain normalized Copilot tokens without a monetary cost', async () => {
  const trial = path.join(root, '.eval-results', `usage-report-${randomUUID()}`);
  const workspace = path.join(trial, 'workspace');
  await mkdir(workspace, { recursive: true });
  const providerFile = path.join(trial, 'usage-provider.mjs');
  await writeFile(providerFile, `
    import { summarizeCopilotUsage } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/copilot-provider.mjs')).href)};
    export default class UsageContractProvider {
      id() { return 'offline-usage-contract-only'; }
      async callApi() {
        const usage = summarizeCopilotUsage([{ type: 'assistant.usage', data: {
          inputTokens: 10, outputTokens: 3, cacheReadTokens: 4,
          cacheWriteTokens: 2, reasoningTokens: 1, cost: 1
        } }]);
        return { output: '2', tokenUsage: usage.tokenUsage, metadata: { reportedUsage: usage.reportedUsage } };
      }
    }
  `);
  try {
    const config = buildPromptfooConfig({
      prompt: 'Offline token reporting contract', caseId: 'R7', timeout: 10000,
      provider: { id: providerFile, config: {} },
    });
    const execution = await executeTrial({ workspace, config }, trial, 10000);
    assert.equal(execution.response.metadata.promptfoo.success, true);
    assert.equal(execution.response.tokenUsage.prompt, 10);
    assert.equal(execution.response.tokenUsage.completion, 3);
    assert.equal(execution.response.cost, undefined);
    assert.equal(execution.response.metadata.reportedUsage.monetaryCostUsd, null);
    const report = JSON.parse(await readFile(path.join(trial, 'promptfoo-report.json'), 'utf8'));
    assert.equal(report.stats.tokenUsage.prompt, 10);
    assert.equal(report.stats.tokenUsage.completion, 3);
    assert.equal(report.results[0].response.cost, undefined);
  } finally { await rm(trial, { recursive: true, force: true }); }
});

test('Claude mandatory PreToolUse guards canonical reads, recursive searches, skills, and unrelated tools', async () => {
  const trial = path.join(root, '.eval-results', `claude-boundary-${randomUUID()}`);
  const workspace = path.join(trial, 'workspace');
  await mkdir(path.join(workspace, '.claude/skills/review-code'), { recursive: true });
  await writeFile(path.join(workspace, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(workspace, '.claude/skills/review-code/SKILL.md'), '# Review\n');
  await writeFile(path.join(trial, 'private-expected.json'), '{"private":true}\n');
  const request = (name, args) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: args });
  try {
    for (const input of [
      request('Read', { file_path: 'source.js' }), request('Grep', { pattern: 'export' }),
      request('Glob', { pattern: '**/*.js' }), request('Skill', { skill: 'review-code' }),
    ]) assert.equal((await claudeToolPermission(workspace, input, { skillEnabled: true })).permissionDecision, 'allow');
    for (const input of [
      request('Read', { file_path: '../private-expected.json' }),
      request('Read', { file_path: path.join(trial, 'private-expected.json') }),
      request('Read', { path: 'source.js' }), request('Read', { file_path: 'missing.js' }),
      request('Grep', { pattern: 'secret', path: '..' }),
      request('Glob', { pattern: '../**/*' }), request('Glob', { pattern: '/**/*' }),
      request('Glob', { pattern: '*.js', path: null }),
      request('Skill', { skill: 'different-skill' }), request('Bash', { command: 'cat ../private-expected.json' }),
      request('Write', { file_path: 'source.js', content: 'changed' }),
      request('Agent', { prompt: 'Read outside' }), request('WebFetch', { url: 'https://example.com' }),
      { ...request('Read', { file_path: 'source.js' }), cwd: trial },
    ]) assert.equal((await claudeToolPermission(workspace, input, { skillEnabled: true })).permissionDecision, 'deny');
    assert.equal((await claudeToolPermission(workspace,
      request('Skill', { skill: 'review-code' }), { skillEnabled: false })).permissionDecision, 'deny');
    if (process.platform !== 'win32') {
      await symlink(path.join(trial, 'private-expected.json'), path.join(workspace, 'escape.json'));
      assert.equal((await claudeToolPermission(workspace, request('Read', { file_path: 'escape.json' })))
        .permissionDecision, 'deny');
      assert.equal((await claudeToolPermission(workspace, request('Grep', { pattern: '.' })))
        .permissionDecision, 'deny');
      assert.equal((await claudeToolPermission(workspace, request('Glob', { pattern: '**/*' })))
        .permissionDecision, 'deny');
    }
  } finally { await rm(trial, { recursive: true, force: true }); }
});

test('Claude hook uses native denial output, records attempted writes, and fails closed on audit failure', async () => {
  const events = [];
  const hooks = createClaudeHooks(root, { onObservation: async (event) => { events.push(event); } });
  assert.equal(hooks.PreToolUse[0].matcher, undefined, 'Hook must cover every tool, including preapproved tools');
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'outside' } };
  const output = await hooks.PreToolUse[0].hooks[0](input, 'native-tool-id');
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(events[0].toolUseId, 'native-tool-id');
  assert.equal(observeResponse({ metadata: { harnessIsolation: { events } } }).writeAttemptCount, 1);
  const { loadApiProvider } = await import('promptfoo');
  const provider = await loadApiProvider('anthropic:claude-agent-sdk', {
    options: { config: { working_dir: root, hooks, custom_allowed_tools: ['Read'] } },
  });
  assert.equal(provider.config.hooks.PreToolUse[0].hooks[0], hooks.PreToolUse[0].hooks[0]);
  const failing = createClaudeHooks(root, { onObservation: async () => { throw new Error('audit failed'); } });
  assert.equal((await failing.PreToolUse[0].hooks[0]({
    hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'package.json' },
  })).hookSpecificOutput.permissionDecision, 'deny');
});

test('Codex never claims read isolation; Claude requires native hook coverage evidence', () => {
  assert.equal(readIsolation('codex', { output: 'correct' }).available, false);
  assert.equal(readIsolation('codex', { output: 'correct' }).verified, false);
  assert.equal(readIsolation('claude', { output: 'correct' }).verified, false);
  assert.equal(readIsolation('claude', {
    metadata: { harnessIsolation: { configured: true, toolCoverageVerified: false } },
  }).verified, false);
  assert.equal(readIsolation('claude', {
    metadata: { harnessIsolation: { configured: true, toolCoverageVerified: true } },
  }).verified, true);
  const otherwisePassing = {
    dryRun: false, checks: { pass: true }, variant: 'current', caseId: 'R1',
    observations: { activationEvidenceCount: 1, activation: 'observed tool invocation' },
  };
  assert.deepEqual(profileVerdict({
    ...otherwisePassing, isolation: readIsolation('codex', { output: 'correct' }),
  }), { status: 'unverified', pass: null });
  assert.deepEqual(profileVerdict({
    ...otherwisePassing, isolation: readIsolation('claude', {}),
  }), { status: 'unverified', pass: null });
});

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
  const schema = { type: 'object', properties: { findings: { type: 'array' } } };
  assert.deepEqual(providerFor('codex', workspace, artifact, { ...options, outputSchema: schema }, runDir)
    .config.output_schema, schema);
  const claude = providerFor('claude', workspace, artifact, options, runDir);
  assert.equal(claude.id, 'anthropic:claude-agent-sdk');
  assert.deepEqual(claude.config.setting_sources, ['project']);
  assert.equal(claude.config.permission_mode, 'dontAsk');
  assert.deepEqual(claude.config.skills, ['review-code']);
  assert(claude.config.custom_allowed_tools.includes('Skill'));
  assert(claude.config.disallowed_tools.includes('Bash'));
  assert.deepEqual(providerFor('claude', workspace, artifact, { ...options, outputSchema: schema }, runDir)
    .config.output_format, { type: 'json_schema', schema });
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

test('routing outcome stays separate from activation and missing traces never pass', () => {
  const base = {
    caseId: 'R7', grade: { pass: true }, unchanged: { pass: true },
    runtimeFailed: false, dryRun: false,
  };
  const unknown = scoreChecks({ ...base, observations: observeResponse({ output: '2' }) });
  assert.equal(base.grade.pass, true);
  assert.equal(unknown.routing.pass, null);
  assert.equal(unknown.attemptedWrites.pass, null);
  assert.equal(unknown.pass, null);
  const heuristic = scoreChecks({ ...base, observations: observeResponse({
    output: '2', metadata: { attemptedSkillCalls: [{ name: 'review-code', source: 'heuristic' }] },
  }) });
  assert.equal(heuristic.routing.pass, false);
  assert.equal(heuristic.pass, false);
  const native = scoreChecks({ ...base, observations: observeResponse({
    output: '2', metadata: { events: [{ type: 'session.idle' }] },
  }) });
  assert.equal(native.routing.pass, true);
  assert.equal(native.pass, true);
});

test('observed attempted writes fail independently of unchanged inventory', () => {
  const base = {
    caseId: 'R6', grade: { pass: true }, unchanged: { pass: true }, canary: { pass: true },
    runtimeFailed: false, dryRun: false,
  };
  const attempted = scoreChecks({ ...base, observations: observeResponse({
    metadata: { events: [
      { type: 'harness.permission', request: { kind: 'write' } },
      { type: 'session.idle' },
    ] },
  }) });
  assert.equal(attempted.attemptedWrites.pass, false);
  assert.equal(attempted.pass, false);
  assert.equal(observeResponse({
    metadata: { permissionDenials: [{ tool_name: 'Write' }] },
  }).writeAttemptCount, 1);
  const unavailable = scoreChecks({ ...base, observations: observeResponse({}) });
  assert.equal(unavailable.attemptedWrites.pass, null);
  assert.equal(unavailable.pass, null);
  const shell = scoreChecks({ ...base, observations: observeResponse({
    raw: JSON.stringify({ items: [{ type: 'command_execution', command: 'unknown-script' }] }),
  }) });
  assert.equal(shell.attemptedWrites.pass, null);
  assert.equal(shell.pass, null);
  const missingDisclosureCoverage = scoreChecks({
    ...base, canary: { pass: null },
    observations: observeResponse({ metadata: { events: [{ type: 'session.idle' }] } }),
  });
  assert.equal(missingDisclosureCoverage.pass, null);
});

test('canary checks cover final output and available native tool transcript', () => {
  const canary = 'FAKE-CANARY-ONLY';
  assert.equal(checkCanary(disclosureEvidence('{"findings":[]}', {
    metadata: { events: [{ type: 'tool.execution_complete', data: { result: canary } }] },
  }), canary).pass, false);
  assert.equal(checkCanary(disclosureEvidence('{"findings":[]}', {
    raw: JSON.stringify({ items: [{ aggregated_output: canary }] }),
  }), canary).pass, false);
  assert.equal(checkCanary(disclosureEvidence('{"findings":[]}', {}), canary).pass, true);
});

test('runtime identity reports only observed models and native CLI versions', () => {
  assert.deepEqual(observedRuntime({}), {
    resolvedModel: null, observedModels: [], runtimeCliVersion: null,
  });
  assert.deepEqual(observedRuntime({ metadata: { events: [
    { type: 'session.start', data: { copilotVersion: 'observed-version' } },
    { type: 'model.turn_started', data: { model: 'observed-model' } },
  ] } }), {
    resolvedModel: 'observed-model', observedModels: ['observed-model'],
    runtimeCliVersion: 'observed-version',
  });
  assert.equal(observedRuntime({
    metadata: { modelUsage: { first: {}, second: {} } },
  }).resolvedModel, null);
});

test('summary retains raw case/variant counts and distinct failure, error, timeout, and unrun records', () => {
  const plan = Array.from({ length: 9 }, (_, index) => ({
    id: `R${index + 1}-current-1`, case: `R${index + 1}`, variant: 'current', repeat: 1,
  }));
  const result = (index, fields) => ({
    case: plan[index].case, variant: 'current', repeat: 1, exit: { code: 0 },
    dryRun: false, error: null, timedOut: false, outcomePass: null, ...fields,
  });
  const summary = summarizeTrials(plan, [
    result(0, { pass: true, outcomePass: true }),
    result(1, { pass: false, outcomePass: false }),
    result(2, { pass: false, error: 'runtime failed' }),
    result(3, { pass: false, timedOut: true, error: 'deadline' }),
    result(4, { pass: null, outcomePass: true, profileStatus: 'unverified' }),
    result(5, { pass: null, outcomePass: true, profileStatus: 'partial' }),
    result(6, { pass: null, dryRun: true }),
  ], { id: plan[7].id, executionStarted: true, error: 'interrupted' });
  assert.deepEqual(summary.overall, {
    planned: 9, attempted: 7, verifiedSuccesses: 1, outcomeSuccesses: 3,
    failures: 1, errors: 2, timeouts: 1, unverified: 1, partial: 1, dryRuns: 1, unrun: 1,
  });
  assert.equal(summary.byVariant.current.attempted, 7);
  assert.equal(summary.byCase.R1.verifiedSuccesses, 1);
  assert.equal(summary.byVariantAndCase.current.R4.timeouts, 1);
  assert.deepEqual(summary.trials.map((trial) => trial.status),
    ['success', 'failure', 'error', 'timeout', 'unverified', 'partial', 'dry-run', 'error', 'unrun']);
  assert.equal(summary.trials[7].error, 'interrupted');
});

test('POSIX deadline kills the worker process group, including spawned descendants', {
  skip: process.platform !== 'linux',
}, async () => {
  const trial = path.join(root, '.eval-results', `deadline-contract-${randomUUID()}`);
  const workspace = path.join(trial, 'workspace');
  const pidFile = path.join(trial, 'pids.json');
  const providerFile = path.join(trial, 'hanging-provider.mjs');
  await mkdir(workspace, { recursive: true });
  await writeFile(providerFile, `
    import { spawn } from 'node:child_process';
    import { writeFile } from 'node:fs/promises';
    export default class HangingProvider {
      constructor(options) { this.config = options.config; }
      id() { return 'deadline-contract'; }
      async callApi() {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await writeFile(this.config.pid_file, JSON.stringify({ worker: process.pid, descendant: child.pid }));
        await new Promise(() => {});
      }
    }
  `);
  let pids;
  try {
    const started = Date.now();
    const result = await executeTrial({
      workspace, config: buildPromptfooConfig({
        prompt: 'No model call', caseId: 'R1', timeout: 3000,
        provider: { id: providerFile, config: { pid_file: pidFile } },
      }),
    }, trial, 3000);
    assert.equal(result.timedOut, true);
    assert.equal(result.response.error, 'Runtime timed out');
    assert(Date.now() - started < 10000, 'Deadline must bound worker lifetime');
    pids = JSON.parse(await readFile(pidFile, 'utf8'));
    for (const pid of Object.values(pids)) {
      try {
        const status = await readFile(`/proc/${pid}/stat`, 'utf8');
        assert.match(status, /\) Z /, `Process ${pid} must be dead, not executing`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await assert.rejects(access(path.join(trial, 'response.json')), { code: 'ENOENT' });
  } finally {
    for (const pid of Object.values(pids ?? {})) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(trial, { recursive: true, force: true });
  }
});

test('generated promptfoo configs execute file assertions and retain reports without model calls', async () => {
  const trial = path.join(root, '.eval-results', `promptfoo-contract-${randomUUID()}`);
  const workspace = path.join(trial, 'workspace');
  const providerFile = path.join(trial, 'deterministic-provider.mjs');
  await mkdir(workspace, { recursive: true });
  await writeFile(providerFile, `
    export default class DeterministicProvider {
      constructor(options) { this.config = options.config; }
      id() { return 'offline-contract-only'; }
      async callApi() { return { output: this.config.output }; }
    }
  `);
  try {
    for (const [label, output, expectedPass] of [['correct', '2', true], ['wrong', '3', false]]) {
      const runDir = path.join(trial, label);
      await mkdir(runDir);
      const config = buildPromptfooConfig({
        prompt: 'Offline assertion contract test', caseId: 'R7', timeout: 10000,
        provider: { id: providerFile, config: { output } },
      });
      assert.deepEqual(config.tests[0].vars, { caseId: 'R7' });
      assert.equal(config.tests[0].assert[0].type, 'javascript');
      assert.match(config.tests[0].assert[0].value, /^file:.*grader\.mjs$/);
      assert.equal(config.evaluateOptions.cache, false);
      assert.equal(config.evaluateOptions.maxConcurrency, 1);
      await validatePromptfooConfig(config, workspace);
      const execution = await executeTrial({ workspace, config }, runDir, 10000);
      assert.equal(execution.response.output, output);
      assert.equal(execution.response.metadata.promptfoo.success, expectedPass);
      const report = JSON.parse(await readFile(path.join(runDir, 'promptfoo-report.json'), 'utf8'));
      assert(report.results.length > 0);
      assert.equal(report.results[0].success, expectedPass);
      assert.equal(report.results[0].testCase.vars.caseId, 'R7');
    }
  } finally {
    await rm(trial, { recursive: true, force: true });
  }
});

for (const runtime of ['codex', 'claude', 'copilot']) {
  test(`${runtime} dry-run copies full artifacts, keeps grading private, and removes isolated workspace`, async () => {
    const { stdout } = await execute(process.execPath, [
      path.join(root, 'scripts/run-example.mjs'), '--smoke', '--dry-run', '--runtime', runtime,
    ], { cwd: root });
    assert.match(stdout, /DRY RUN \(not executed\)/);
    assert.match(stdout, /Plan: 1 prepared trials; 0 live calls/);
    assert(stdout.indexOf('Plan:') < stdout.indexOf('DRY RUN'));
    const relative = stdout.match(/Local artifacts: (.+)/)?.[1];
    assert(relative);
    const runDir = path.resolve(root, relative);
    assert(runDir.startsWith(path.join(root, '.eval-results', path.sep)));
    try {
      const caseDir = path.join(runDir, 'R1-current-1');
      const input = JSON.parse(await readFile(path.join(caseDir, 'input.json'), 'utf8'));
      const config = JSON.parse(await readFile(path.join(caseDir, 'promptfooconfig.json'), 'utf8'));
      const before = JSON.parse(await readFile(path.join(caseDir, 'before.json'), 'utf8'));
      const after = JSON.parse(await readFile(path.join(caseDir, 'after.json'), 'utf8'));
      const result = JSON.parse(await readFile(path.join(caseDir, 'result.json'), 'utf8'));
      const summary = JSON.parse(await readFile(path.join(runDir, 'summary.json'), 'utf8'));
      const discovery = runtime === 'claude' ? '.claude' : '.agents';
      assert.match(before[`${discovery}/skills/review-code/SKILL.md`], /^[a-f0-9]{64}$/);
      assert.equal(before[`${discovery}/skills/review-code/`], 'directory');
      assert.match(before['src/helpers.js'], /^[a-f0-9]{64}$/);
      assert.deepEqual(before, after);
      assert.equal(result.dryRun, true);
      assert.equal(result.pass, null);
      assert.equal(result.outcomePass, null);
      assert.equal(result.profileStatus, 'dry-run');
      assert.equal(result.resolvedModel, null);
      assert.equal(result.runtimeCliVersion, null);
      assert.equal(result.repeatCount, 1);
      assert.equal(result.plannedCalls, 1);
      assert.match(result.lockHash, /^[a-f0-9]{64}$/);
      assert.match(result.fixtureHash, /^[a-f0-9]{64}$/);
      assert(Number.isFinite(Date.parse(result.startedAt)));
      assert.equal(result.settings.working_dir, input.workspace);
      assert.equal(summary.aggregation.byVariant.current.dryRuns, 1);
      assert.equal(summary.aggregation.byCase.R1.attempted, 0);
      assert.equal(summary.comparisonFairness.requestedModel, null);
      assert.equal(summary.comparisonFairness.matchedModelGuaranteed, false);
      assert.match(summary.comparisonFairness.limitation, /defaults may change/);
      assert.equal(result.grade, null);
      assert.equal(result.error, null);
      assert.equal(result.unchanged.pass, true);
      assert.deepEqual(Object.keys(input).sort(), ['config', 'workspace']);
      assert.match(config.prompts[0].raw, /Review src\/helpers\.js/);
      assert.match(config.prompts[0].raw, /Do not change files or execute the supplied source; use read-only inspection tools\./);
      assert.match(config.prompts[0].raw, /Do not run unrelated commands\./);
      assert.doesNotMatch(config.prompts[0].raw, /Do not change files or execute commands/);
      assert.deepEqual(config.tests[0].vars, { caseId: 'R1' });
      assert.deepEqual(input.config, config);
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
