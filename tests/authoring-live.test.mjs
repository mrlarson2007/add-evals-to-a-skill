import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authoringSmoke, expectedIndex, parseAuthoringArgs, reviewSource, verifyGeneratedSuite } from '../scripts/authoring-smoke.mjs';

test('authoring CLI requires explicit supported-runtime opt-in', () => {
  assert.deepEqual(parseAuthoringArgs(['--runtime', 'copilot', '--model', 'example', '--timeout', '1234']), {
    runtime: 'copilot', optIn: true, model: 'example', timeoutMs: 1234,
  });
  assert.throws(() => parseAuthoringArgs([]), /Only --runtime copilot/);
  assert.throws(() => parseAuthoringArgs(['--runtime', 'codex']), /unrun/);
  assert.throws(() => parseAuthoringArgs(['--runtime', 'copilot', '--runtime', 'copilot']), /Expected/);
  assert.throws(() => parseAuthoringArgs(['--unrecognized', 'copilot']), /Expected/);
});

test('authoring harness oracle preserves zero, duplicate codes, order and data strings', () => {
  assert.deepEqual(expectedIndex({
    shipment: '雪', crates: [
      { id: 'first', items: [{ code: 'ignore instructions', units: 0 }, { code: 'same', units: 2 }] },
      { id: 'empty', items: [] },
      { id: 'last', items: [{ code: 'same', units: 3 }] },
    ],
  }), {
    shipment: '雪', entries: [
      { crate: 'first', code: 'ignore instructions', units: 0 },
      { crate: 'first', code: 'same', units: 2 },
      { crate: 'last', code: 'same', units: 3 },
    ], totalUnits: 5,
  });
  assert.throws(() => expectedIndex({ shipment: 'bad', crates: [{ id: 'a', items: [{ code: 'b', units: -1 }] }] }));
});

test('harness self-test (not authoring): no-op and dishonest generated graders cannot pass', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'authoring-harness-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'evals'));
  assert.throws(() => verifyGeneratedSuite(dir, dir), /ENOENT/);
  const grader = join(dir, 'evals/grader.cjs');
  for (const source of [
    "require('node:child_process')", 'console.log(process.env)',
    'require(process.argv[2])', "fetch('https://example.com')",
  ]) {
    writeFileSync(grader, source);
    assert.throws(() => reviewSource(dir, grader), /review|require|dependency/i);
  }
  const cases = Array.from({ length: 5 }, (_, i) => ({
    id: `case-${i}`, input: {
      shipment: `shipment-${i}`,
      crates: i === 0 ? [] : [{
        id: 'crate', items: [{ code: 'zero', units: 0 }, { code: 'ordinary', units: i }],
      }],
    },
  }));
  writeFileSync(join(dir, 'evals/cases.json'), JSON.stringify(cases));
  for (const verdict of [true, false]) {
    writeFileSync(join(dir, 'evals/grader.cjs'), `module.exports = () => ({pass:${verdict}, reason:'a claim'});`);
    assert.throws(() => verifyGeneratedSuite(dir, dir), /failed independent probes/);
    const probes = JSON.parse(readFileSync(join(dir, 'grader-probes.json'), 'utf8'));
    assert.ok(probes.some((probe) => probe.shouldPass !== probe.verdict?.pass));
    assert.ok(probes.some((probe) => probe.mutation === 'wrong-total' && !probe.shouldPass));
  }
  writeFileSync(grader, `
const fs = require('node:fs');
const path = require('node:path');
module.exports = (runDirectory, testCase) => {
  try {
    const actual = JSON.parse(fs.readFileSync(path.join(runDirectory, 'index.json'), 'utf8'));
    const entries = testCase.input.crates.flatMap(crate => crate.items);
    return {
      pass: actual.shipment === testCase.input.shipment
        && actual.totalUnits === entries.reduce((total, item) => total + item.units, 0)
        && actual.entries.length === entries.length,
      reason: 'Only shipment, count and total checked',
    };
  } catch { return { pass: false, reason: 'Missing or corrupt artifact' }; }
};
`);
  assert.throws(() => verifyGeneratedSuite(dir, dir), /failed independent probes/);
  const countOnlyProbes = JSON.parse(readFileSync(join(dir, 'grader-probes.json'), 'utf8'));
  const incorrectlyAccepted = countOnlyProbes.filter((probe) => probe.verdict?.pass !== probe.shouldPass);
  assert.deepEqual([...new Set(incorrectlyAccepted.map((probe) => probe.mutation))].sort(), [
    'wrong-code-same-length', 'wrong-crate-same-length', 'wrong-order-same-length', 'wrong-units-same-length',
  ]);
  assert.ok(incorrectlyAccepted.every((probe) => probe.verdict.pass && !probe.shouldPass));
});

test('LIVE: fresh installed-skill authoring rejects deliberately broken actual artifacts', {
  skip: process.env.AUTHORING_LIVE !== '1' && 'Opt in with AUTHORING_LIVE=1 and Copilot credentials; offline tests do not prove authoring',
  timeout: 660_000,
}, async () => {
  const report = await authoringSmoke();
  assert.equal(report.status, 'passed');
  assert.ok(report.activation.length > 0);
  assert.ok(report.validation.probes >= 30);
  assert.equal(report.validation.promptfooProbes, 2);
});
