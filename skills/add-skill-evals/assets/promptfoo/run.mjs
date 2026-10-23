import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import grade from './grader.cjs';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const ids = new Set();
const results = cases.map((task) => {
  if (!task.id || ids.has(task.id)) throw new Error(`Missing or duplicate case ID: ${task.id}`);
  ids.add(task.id);
  const run = spawnSync(process.execPath, ['provider.mjs', JSON.stringify(task.request)], {
    encoding: 'utf8', timeout: 10_000,
  });
  const result = run.error || run.status !== 0
    ? { pass: false, score: 0, reason: `Provider failure: ${run.error?.message || run.stderr || run.status}` }
    : grade(run.stdout, { vars: { caseId: task.id } });
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${task.id}: ${result.reason}`);
  return { id: task.id, ...result, output: run.stdout };
});
mkdirSync('.runs', { recursive: true });
writeFileSync('.runs/results.json', JSON.stringify({ kind: 'offline-example', results }, null, 2));
process.exitCode = results.every((result) => result.pass) ? 0 : 1;
