import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const canonical = join(root, 'skills/add-skill-evals');
const sourceCases = JSON.parse(readFileSync(join(canonical, 'assets/promptfoo/cases.json')));
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'add-skill-evals-authoring-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function command(script, args = [], cwd = root) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd, encoding: 'utf8', timeout: 20_000,
  });
}

function scaffold(destination) {
  const result = command('scripts/scaffold-evals.mjs', ['--dest', destination]);
  assert.equal(result.status, 0, result.stderr);
}

function makeRepository(dir) {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

function tree(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = join(prefix, entry.name);
    return entry.isDirectory() ? tree(dir, name) : [name];
  }).sort();
}

// Scripted fixture simulations of authoring workflows, NOT live agent authoring.
test('authoring simulation: create an artifact suite for a file-producing skill', (t) => {
  const dir = workspace(t);
  const target = join(dir, 'SKILL.md');
  const original = '# Report skill\nWrite report.json preserving labels, amounts and total.\n';
  writeFileSync(target, original);
  const evalDir = join(dir, 'evals');
  scaffold(evalDir);
  const local = spawnSync(process.execPath, ['run.mjs'], { cwd: evalDir, encoding: 'utf8' });
  assert.equal(local.status, 0, local.stderr);
  assert.equal((local.stdout.match(/^PASS /gm) || []).length, 7);
  assert.equal(readFileSync(target, 'utf8'), original);
  const results = JSON.parse(readFileSync(join(evalDir, '.runs/results.json')));
  assert.equal(results.kind, 'offline-example');
  const first = JSON.parse(results.results[0].output);
  assert.ok(existsSync(join(first.runDir, 'report.json')));
  const grade = require(join(evalDir, 'grader.cjs'));
  const context = { vars: { caseId: sourceCases[0].id } };
  const cwd = process.cwd();
  process.chdir(evalDir);
  try {
    assert.equal(grade(results.results[0].output, context).pass, true);
    assert.equal(grade('I wrote a perfect report.json', context).pass, false);
    writeFileSync(join(first.runDir, 'report.json'), '{"rows":[],"total":999}');
    assert.equal(grade(results.results[0].output, context).pass, false);
    writeFileSync(join(first.runDir, 'report.json'), '{broken');
    assert.equal(grade(results.results[0].output, context).pass, false);
    rmSync(join(first.runDir, 'report.json'));
    assert.equal(grade(results.results[0].output, context).pass, false);
  } finally {
    process.chdir(cwd);
  }
});

test('authoring simulation: extend existing suite with known failure without replacing tests', (t) => {
  const dir = workspace(t);
  const evalDir = join(dir, 'evals');
  scaffold(evalDir);
  const oldCases = sourceCases.filter((task) => task.id !== 'zero-preserved');
  const casesPath = join(evalDir, 'cases.json');
  writeFileSync(casesPath, JSON.stringify(oldCases, null, 2));
  const graderPath = join(evalDir, 'grader.cjs');
  const originalGrader = readFileSync(graderPath);
  const target = join(dir, 'target-SKILL.md');
  writeFileSync(target, '# Existing target skill\nDo not change during eval authoring.\n');
  const originalTarget = readFileSync(target);
  const regression = sourceCases.find((task) => task.id === 'zero-preserved');
  writeFileSync(casesPath, JSON.stringify([...oldCases, regression], null, 2));
  const finalCases = JSON.parse(readFileSync(casesPath));
  assert.deepEqual(finalCases.slice(0, oldCases.length), oldCases);
  assert.ok(readFileSync(graderPath).equals(originalGrader));
  assert.ok(readFileSync(target).equals(originalTarget));

  const runs = join(evalDir, '.runs');
  const broken = join(runs, 'broken-zero-case');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'report.json'), JSON.stringify({
    rows: regression.expected.rows.filter((row) => row.amount !== 0),
    total: 7,
  }));
  const grade = require(graderPath);
  const cwd = process.cwd();
  process.chdir(evalDir);
  try {
    const result = grade(JSON.stringify({ runDir: broken }), { vars: { caseId: regression.id } });
    assert.equal(result.pass, false, 'Known omitted-zero failure must reproduce');
  } finally {
    process.chdir(cwd);
  }
  const run = spawnSync(process.execPath, ['run.mjs'], { cwd: evalDir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((run.stdout.match(/^PASS /gm) || []).length, 7);
  assert.ok(readFileSync(graderPath).equals(originalGrader));
  assert.ok(readFileSync(target).equals(originalTarget));
});

test('install copies and verifies all canonical bytes for each runtime', (t) => {
  const dir = workspace(t);
  for (const [runtime, location] of [
    ['codex', '.agents/skills'], ['claude', '.claude/skills'], ['copilot', '.github/skills'],
  ]) {
    const repo = join(dir, runtime);
    makeRepository(repo);
    const args = ['--runtime', runtime, '--dest', repo];
    const run = command('scripts/install-skill.mjs', args);
    assert.equal(run.status, 0, run.stderr);
    const installed = join(repo, location, 'add-skill-evals');
    assert.deepEqual(tree(installed), tree(canonical));
    for (const file of tree(canonical)) {
      assert.ok(readFileSync(join(installed, file)).equals(readFileSync(join(canonical, file))), file);
    }
    assert.equal(command('scripts/install-skill.mjs', args).status, 0);
    writeFileSync(join(installed, 'SKILL.md'), 'modified');
    assert.notEqual(command('scripts/install-skill.mjs', args).status, 0);
    assert.equal(readFileSync(join(installed, 'SKILL.md'), 'utf8'), 'modified');
  }
});

test('install and scaffold reject ambiguous, conflicting and unsafe destinations', (t) => {
  const dir = workspace(t);
  makeRepository(dir);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'codex']).status, 0);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'other', '--dest', dir]).status, 0);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'toString', '--dest', dir]).status, 0);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'codex', '--dest', canonical]).status, 0);
  assert.equal(command('scripts/install-skill.mjs', ['--runtime', 'codex', '--dest', dir]).status, 0);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'claude', '--dest', dir]).status, 0);
  const evalDir = join(dir, 'evals');
  scaffold(evalDir);
  const before = readFileSync(join(evalDir, 'cases.json'));
  assert.notEqual(command('scripts/scaffold-evals.mjs', ['--dest', evalDir]).status, 0);
  assert.ok(readFileSync(join(evalDir, 'cases.json')).equals(before));
  const linked = join(dir, 'linked');
  symlinkSync(evalDir, linked);
  assert.notEqual(command('scripts/scaffold-evals.mjs', ['--dest', join(linked, 'nested')]).status, 0);
  const alias = join(dir, 'repo-alias');
  symlinkSync(dir, alias);
  assert.notEqual(command('scripts/install-skill.mjs', ['--runtime', 'codex', '--dest', alias]).status, 0);
  assert.equal(existsSync(join(evalDir, 'nested')), false);
  assert.equal(resolve(dir), dir);
});

test('authoring CLIs explain their explicit destinations without making changes', () => {
  const install = command('scripts/install-skill.mjs', ['--help']);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /--runtime codex\|claude\|copilot --dest \/absolute\/repo/);
  assert.match(install.stdout, /Copilot: \.github\/skills/);
  const scaffold = command('scripts/scaffold-evals.mjs', ['--help']);
  assert.equal(scaffold.status, 0, scaffold.stderr);
  assert.match(scaffold.stdout, /--dest \.\/evals\/new-suite/);
  assert.match(scaffold.stdout, /does not invoke an agent/);
});
