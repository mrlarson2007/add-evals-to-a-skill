import test from 'node:test';
import assert from 'node:assert/strict';
import { planModels } from '../scripts/plan-models.mjs';

const selected = ['--claude', 'claude-selected', '--openai', 'gpt-selected', '--gemini', 'gemini-selected'];

test('three explicit profiles plan 126 paired trials without running models', () => {
  const plan = planModels(selected);
  assert.equal(plan.executesModels, false);
  assert.equal(plan.plannedProviderInvocations, 126);
  assert.equal(plan.callsPerModel, 42);
  assert.equal(plan.profiles.length, 3);
  assert.match(plan.availability, /Unverified/);
  assert.ok(plan.profiles.every((profile) => profile.command.includes('--runtime copilot')));
});

test('model planner shares runner repeat, variant, case and deadline semantics', () => {
  assert.equal(planModels([...selected, '--no-skill']).plannedProviderInvocations, 189);
  const plan = planModels([...selected, '--case', 'R6', '--variant', 'proposed', '--repeat', '1', '--timeout', '30000']);
  assert.equal(plan.plannedProviderInvocations, 3);
  assert.match(plan.profiles[0].command, /--variant proposed --timeout 30000 --case R6/);
});

test('model selection never silently chooses IDs or accepts shell expressions', () => {
  for (const args of [
    [], ['--claude', 'a'], [...selected, '--claude', 'other'],
    [...selected, '--repeat', '0'], [...selected, '--case', 'R8'],
    ['--claude', 'a; echo unsafe', '--openai', 'b', '--gemini', 'c'],
    ['--claude', 'same', '--openai', 'same', '--gemini', 'other'],
    [...selected, '--execute'],
  ]) assert.throws(() => planModels(args));
});
