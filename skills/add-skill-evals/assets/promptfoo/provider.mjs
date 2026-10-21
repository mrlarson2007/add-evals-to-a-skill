import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Offline stand-in only. Replace this producer with the target runtime adapter.
const root = resolve('.runs');
mkdirSync(root, { recursive: true });
const runDir = mkdtempSync(join(root, 'task-'));
let request;
try {
  request = JSON.parse(process.argv[2]);
} catch {
  request = null;
}
const valid = request && Array.isArray(request.rows) && request.rows.every(
  (row) => row && typeof row.label === 'string' &&
    typeof row.amount === 'number' && Number.isFinite(row.amount),
);
if (!valid) {
  process.stdout.write(JSON.stringify({ runDir, error: 'invalid-input' }));
} else {
  const report = {
    rows: request.rows,
    total: request.rows.reduce((sum, row) => sum + row.amount, 0),
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ runDir }));
}
