const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const cases = require('./cases.json');

module.exports = function grade(output, context) {
  const fail = (reason) => ({ pass: false, score: 0, reason });
  try {
    const result = typeof output === 'string' ? JSON.parse(output) : output;
    const expected = cases.find((task) => task.id === context.vars.caseId)?.expected;
    if (!expected) return fail('Unknown case ID');
    const root = path.resolve('.runs');
    const runDir = path.resolve(result.runDir);
    const relative = path.relative(root, runDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        relative.includes(path.sep)) return fail('Artifact directory must be a direct child of .runs');
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(runDir).isSymbolicLink() ||
        fs.realpathSync(runDir) !== runDir) return fail('Symlinked artifact paths are forbidden');
    const files = fs.readdirSync(runDir).sort();
    if (expected.error) {
      if (result.error !== expected.error || files.length !== 0) {
        return fail('Expected controlled error and no fabricated artifacts');
      }
    } else {
      if (result.error || !isDeepStrictEqual(files, ['report.json'])) {
        return fail('Expected exactly report.json and no execution error');
      }
      const file = path.join(runDir, 'report.json');
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
        return fail('Report must be a regular file');
      }
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isDeepStrictEqual(Object.keys(report).sort(), ['rows', 'total']) ||
          !isDeepStrictEqual(report.rows, expected.rows) ||
          typeof report.total !== 'number' || !Number.isFinite(report.total) ||
          Math.abs(report.total - expected.total) > 1e-9) {
        return fail('Report schema, row fidelity, or total differs from the contract');
      }
    }
    return { pass: true, score: 1, reason: 'Actual artifacts satisfy the case contract' };
  } catch (error) {
    return fail(`Cannot validate artifacts: ${error.message}`);
  }
};
