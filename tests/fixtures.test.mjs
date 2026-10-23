import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function load(variant) {
  const source = await readFile(new URL(`../examples/review-code/fixtures/${variant}/src/helpers.js`, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('buggy fixture has exactly the two demonstrated contract counterexamples', async () => {
  const buggy = await load('buggy');
  assert.equal(buggy.totalPrice([]), 0);
  assert.equal(buggy.totalPrice([{ price: 7 }]), 0);
  assert.equal(buggy.totalPrice([{ price: 2 }, { price: 7 }]), 2);
  assert.throws(() => buggy.normalizeEmail(null), TypeError);
  assert.equal(buggy.normalizeEmail({ email: ' A@B.COM ' }), 'a@b.com');
});

test('corrected fixture satisfies allowed-input checks', async () => {
  const corrected = await load('corrected');
  assert.equal(corrected.totalPrice([]), 0);
  assert.equal(corrected.totalPrice([{ price: 7 }]), 7);
  assert.equal(corrected.totalPrice([{ price: 2 }, { price: -7 }, { price: 0.5 }]), -4.5);
  assert.equal(corrected.normalizeEmail(null), null);
  assert.equal(corrected.normalizeEmail({ email: ' A@B.COM ' }), 'a@b.com');
  assert.equal(corrected.normalizeEmail({ email: '' }), '');
});

test('seven distinct cases resolve private expected data and fixture references', async () => {
  const base = new URL('../examples/review-code/', import.meta.url);
  const cases = JSON.parse(await readFile(new URL('evals/cases.json', base)));
  const expected = JSON.parse(await readFile(new URL('evals/expected.json', base)));
  assert.equal(cases.length, 7);
  assert.equal(new Set(cases.map((item) => item.id)).size, 7);
  for (const item of cases) {
    for (const field of ['id', 'category', 'request', 'fixture', 'expected', 'assertions', 'prohibited', 'requirement']) {
      assert.ok(item[field], `${item.id}: ${field}`);
    }
    assert.notEqual(expected[item.expected], undefined);
    await readFile(new URL(`fixtures/${item.fixture}/src/helpers.js`, base));
    assert.equal(item.request.includes('review-code'), false);
  }
  assert.equal(cases.filter((item) => item.category === 'review').length, 6);
  assert.equal(cases[6].category, 'routing-boundary');
});
