const cases = require('./cases.json');

module.exports = {
  description: 'Offline artifact-producing example; not a live skill evaluation',
  prompts: ['{{request}}'],
  providers: ['exec:node provider.mjs'],
  tests: cases.map((task) => ({
    description: task.id,
    vars: { request: JSON.stringify(task.request), caseId: task.id },
    assert: [{ type: 'javascript', value: 'file://grader.cjs' }],
  })),
};
