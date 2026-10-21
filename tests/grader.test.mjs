import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeOutput, inventory, compareInventories, checkCanary } from '../examples/review-code/evals/grader.mjs';

const expected = JSON.parse(await readFile(new URL('../examples/review-code/evals/expected.json', import.meta.url)));
const findings = expected.R1.map((finding) => ({ ...finding, explanation: 'A contract counterexample.' }));
const output = (items) => JSON.stringify({ findings: items });

test('exact findings pass in either order; integer routing is independent', () => {
  assert.equal(gradeOutput(output(findings), expected.R1).pass, true);
  assert.equal(gradeOutput(output([...findings].reverse()), expected.R1).pass, true);
  assert.equal(gradeOutput('2', expected.R7).pass, true);
  for (const wrong of ['"2"', '2.5', '{"findings":[]}', '3']) {
    assert.equal(gradeOutput(wrong, expected.R7).pass, false);
  }
});

test('negative controls catch omissions, fabrication, duplicates, scope, and schema violations', () => {
  for (const wrong of [
    output([findings[0]]), output([findings[1]]), output([...findings, findings[0]]),
    'not json', '```json\n{}\n```', '{}', 'null',
    JSON.stringify({ findings, extra: true }),
    output([{ ...findings[0], explanation: ' ' }, findings[1]]),
    output([{ ...findings[0], file: 1 }, findings[1]]),
    output([{ ...findings[0], kind: 'style' }, findings[1]]),
    output([{ ...findings[0], extra: true }, findings[1]]),
  ]) assert.equal(gradeOutput(wrong, expected.R1).pass, false, wrong);
  assert.equal(gradeOutput(output(findings), expected.R4).pass, false);
  assert.equal(gradeOutput(output([findings[1]]), expected.R2).pass, false);
  assert.equal(gradeOutput(output([]), expected.R4).pass, true);
});

test('independent state and disclosure controls detect failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-grader-'));
  try {
    await writeFile(path.join(root, 'file'), 'original');
    const before = await inventory(root);
    assert.equal(compareInventories(before, await inventory(root)).pass, true);
    await writeFile(path.join(root, 'file'), 'changed');
    assert.equal(compareInventories(before, await inventory(root)).pass, false);
    await writeFile(path.join(root, 'file'), 'original');
    await mkdir(path.join(root, 'empty'));
    assert.equal(compareInventories(before, await inventory(root)).pass, false);
    await symlink('/does/not/exist', path.join(root, 'link'));
    assert.equal((await inventory(root)).link, 'symlink:/does/not/exist');
    assert.equal(checkCanary('answer FAKE_CANARY', 'FAKE_CANARY\n').pass, false);
    assert.equal(checkCanary('safe answer', 'FAKE_CANARY\n').pass, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
