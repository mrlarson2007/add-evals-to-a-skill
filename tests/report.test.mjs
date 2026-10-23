import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, renderReport } from '../scripts/render-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = (changes = {}) => ({
  case: 'R1', variant: 'current', repeat: 1, repeatCount: 1,
  runtime: 'claude', model: 'exact-model', resolvedModel: 'exact-model-v1',
  runtimeCliVersion: '1.2.3', harnessHash: 'harness-a', lockHash: 'lock-a',
  fixtureHash: 'fixture-a', promptHash: 'prompt-a', skillHash: 'current-skill',
  settings: { model: 'exact-model', working_dir: '/home/private/workspace',
    permission_mode: 'dontAsk', max_turns: 12 },
  startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:01:00Z',
  pass: true, outcomePass: true, grade: { pass: true, reason: 'Exact finding set; explanation correctness still requires human inspection' },
  unchanged: { pass: true }, checks: { attemptedWrites: { pass: true } },
  isolation: { verified: true }, observations: { activationEvidenceCount: 1 },
  executionStatus: 'completed', ...changes,
});
const summary = (results, changes = {}) => ({
  options: { runtime: 'claude', model: 'exact-model', repeat: 1 },
  results, node: 'v22.0.0', ...changes,
});

test('story-first bars separate expected output from overall verified outcomes', () => {
  const html = renderReport({ summaries: [summary([
    result(),
    result({ case: 'R2', pass: false, outcomePass: false,
      grade: { pass: false, reason: 'Missing, extra, or out-of-scope findings' } }),
    result({ case: 'R3', pass: null, profileStatus: 'unverified', isolation: { verified: false } }),
    result({ case: 'R4', pass: false, outcomePass: null, timedOut: true }),
    result({ case: 'R5', pass: false, outcomePass: null, error: '/home/secret/token=SUPER_SECRET' }),
    result({ case: 'R6', pass: null, outcomePass: null, dryRun: true }),
  ])] });
  assert.match(html, /Overall verified: <strong>1\/5<\/strong>/);
  assert.match(html, /Output outcome: <strong>2\/5<\/strong>/);
  for (const label of ['Verified success', 'Failed checks', 'Unverified', 'Timeout', 'Runtime error', 'Dry-run (not executed)', 'Unrun']) {
    assert.ok(html.includes(label), label);
  }
  assert.match(html, /Correct output alone does not establish overall verified success/);
  assert.match(html, /Missing, extra, or out-of-scope findings/);
  assert.doesNotMatch(html, /SUPER_SECRET|\/home\/private|\/home\/secret/);
  assert.ok(html.indexOf('id="overview"') < html.indexOf('id="matrix"'));
  for (let i = 1; i <= 7; i++) assert.ok(html.includes(`R${i}:`));
  assert.match(html, /href="#attempt-1"/);
});

test('dry-run and interrupted planned attempts never become successful executions', () => {
  const html = renderReport({ summaries: [summary([], {
    aggregation: { trials: [
      { case: 'R1', variant: 'current', repeat: 1, status: 'unrun', attempted: false },
      { case: 'R2', variant: 'current', repeat: 1, status: 'error', attempted: true },
    ] },
  })] });
  assert.match(html, /Overall verified: <strong>0\/1<\/strong>/);
  assert.match(html, /No recorded execution/);
  assert.match(html, /Runtime error/);
});

test('model slots show expected unrun profiles without synthetic results', () => {
  const parsed = parseArgs(['--input', '/project/summary.json', '--output', '/project/report.html',
    '--model-slot', 'Claude=claude-exact', '--model-slot', 'Copilot=copilot-exact']);
  assert.equal(parsed.modelSlots[0].runtime, 'claude');
  const html = renderReport({ modelSlots: parsed.modelSlots });
  assert.match(html, /Expected profile, unrun; repeat count unknown/);
  assert.equal((html.match(/Unrun · expected profile/g) ?? []).length, 14);
  assert.doesNotMatch(html, /href="#attempt-/);
  assert.match(html, /0\/0/);
  assert.throws(() => parseArgs(['--model-slot', 'Claude=', '--output', 'a']), /Label=EXACT_ID/);
});

test('matched profiles compare actual counts; model, fixture and provenance mismatches do not', () => {
  const a = result();
  const b = result({ variant: 'proposed', skillHash: 'proposed-skill',
    settings: { ...a.settings, working_dir: '/home/another/trial' } });
  const matched = renderReport({ summaries: [summary([a, b])] });
  assert.match(matched, /Matched 1 task\/repeat pairs only/);
  for (const changes of [
    { model: 'other-model' }, { resolvedModel: 'different-backend' },
    { fixtureHash: 'different-fixture' }, { promptHash: 'different-task' },
    { harnessHash: 'different-harness' }, { lockHash: 'different-lock' },
    { harnessHash: null }, { runtimeCliVersion: null },
    { settings: { ...a.settings, max_turns: 13 } },
    { repeat: 2 },
  ]) {
    const html = renderReport({ summaries: [summary([a, { ...b, ...changes }])] });
    assert.match(html, /Unpaired \/ descriptive only/, JSON.stringify(changes));
    assert.doesNotMatch(html, /Matched 1 task/);
  }
});

test('no-skill and distinct requested/resolved/settings profiles are never pooled', () => {
  const html = renderReport({ summaries: [summary([
    result(), result({ variant: 'no-skill', skillHash: null }),
    result({ case: 'R2', resolvedModel: 'other-resolved' }),
    result({ case: 'R3', settings: { max_turns: 99 } }),
  ])] });
  assert.equal((html.match(/<article class="card"><h3><a/g) ?? []).length, 4);
  assert.match(html, /not applicable \(no skill\)/);
  assert.match(html, /No current\/proposed pair supplied/);
});

test('escaped allowlisted fields cannot embed markup; raw prompts, paths, errors and arbitrary settings are omitted', () => {
  const attack = '<script>alert("unsafe")</script>';
  const html = renderReport({
    summaries: [summary([result({
      model: attack, error: '****** /home/private/auth.json',
      raw: 'RAW_TRACE', output: 'RAW_OUTPUT', prompt: 'RAW_PROMPT',
      grade: { pass: false, reason: 'RAW_GRADER_SECRET' },
      settings: { model: attack, api_key: 'RAW_SETTING_SECRET', working_dir: '/home/private/workspace' },
    })])],
    modelSlots: [{ runtime: 'codex', label: attack, model: 'expected' }],
  });
  assert.match(html, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|RAW_CREDENTIAL|RAW_TRACE|RAW_OUTPUT|RAW_PROMPT|RAW_GRADER_SECRET|RAW_SETTING_SECRET|\/home\/private/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b|https?:\/\//);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /scope="row"/);
});

test('authoring cases and independent negative controls stay outside review math', () => {
  const html = renderReport({
    summaries: [summary([result()])],
    authoring: [{
      report: { runtime: 'copilot', status: 'passed', model: 'author-model',
        validation: { cases: 20, probes: 100, promptfooProbes: 2 },
        canonical: { sha256: 'canonical-hash' }, error: 'AUTHORING_SECRET' },
      graderProbes: [
        { shouldPass: true, status: 0, verdict: { pass: true }, stdout: 'RAW_AUTHORING_TRACE' },
        { shouldPass: false, status: 0, verdict: { pass: false } },
        { shouldPass: false, status: 1, verdict: { pass: false } },
      ],
      promptfooProbes: [
        { shouldPass: true, status: 0, verdict: { pass: true } },
        { shouldPass: false, status: 0, verdict: { pass: false } },
      ],
    }],
  });
  assert.match(html, /Overall verified: <strong>1\/1<\/strong>/);
  assert.match(html, /Generated cases: 20; grader probes: 100/);
  assert.match(html, /1\/2 negative controls correctly rejected/);
  assert.match(html, /Separate authoring proof/);
  assert.doesNotMatch(html, /AUTHORING_SECRET|RAW_AUTHORING_TRACE|101\/101/);
  const missing = renderReport({ authoring: [{ runtime: 'copilot', status: 'passed', validation: { probes: 30 } }] });
  assert.match(missing, /negative-control evidence unknown/);
  assert.match(missing, /No review evidence supplied/);
});

test('CLI consumes repeated summary/authoring inputs and local independent probe files', async () => {
  const dir = path.join(root, `.report-test-${randomUUID()}`);
  await mkdir(dir);
  try {
    const input = path.join(dir, 'summary.json');
    const input2 = path.join(dir, 'second.json');
    const authoring = path.join(dir, 'report.json');
    const output = path.join(dir, 'report.html');
    await writeFile(input, JSON.stringify(summary([result()])));
    await writeFile(input2, JSON.stringify(summary([result({ model: 'second-model' })])));
    await writeFile(authoring, JSON.stringify({ runtime: 'copilot', status: 'passed', validation: { cases: 3, probes: 1 } }));
    await writeFile(path.join(dir, 'grader-probes.json'), JSON.stringify([
      { shouldPass: false, status: 0, verdict: { pass: false }, stderr: 'DO_NOT_EMBED' },
    ]));
    await main(['--input', input, '--input', input2, '--authoring', authoring, '--output', output,
      '--model-slot', 'Codex=expected-codex']);
    const html = await readFile(output, 'utf8');
    assert.match(html, /second-model/);
    assert.match(html, /1\/1 negative controls correctly rejected/);
    assert.match(html, /expected-codex/);
    assert.doesNotMatch(html, /DO_NOT_EMBED|grader-probes\.json|\.report-test-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
