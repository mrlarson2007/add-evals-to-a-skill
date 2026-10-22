import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertNoSymlinks, installSkill } from './install-skill.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const canonical = join(root, 'skills/add-skill-evals');
const fixture = join(root, 'tests/fixtures/authoring/crate-index');

export function hashTree(directory) {
  const entries = [];
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), name);
      else if (entry.isFile()) entries.push({
        path: name, sha256: createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex'),
      });
      else throw new Error(`Nonregular artifact: ${name}`);
    }
  }
  visit(directory);
  return {
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    files: entries,
  };
}

export function expectedIndex(input) {
  if (!input || typeof input.shipment !== 'string' || !Array.isArray(input.crates)) {
    throw new Error('Case input must match the target shipment contract');
  }
  const entries = input.crates.flatMap((crate) => {
    if (typeof crate.id !== 'string' || !Array.isArray(crate.items)) throw new Error('Invalid crate');
    return crate.items.map((item) => {
      if (typeof item.code !== 'string' || !Number.isSafeInteger(item.units) || item.units < 0) {
        throw new Error('Invalid item');
      }
      return { crate: crate.id, code: item.code, units: item.units };
    });
  });
  return { shipment: input.shipment, entries, totalUnits: entries.reduce((n, item) => n + item.units, 0) };
}

function confined(workspace, name, writing = false) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Use workspace-relative paths');
  const target = resolve(workspace, name);
  const rel = relative(workspace, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path escapes workspace');
  let current = workspace;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlinks forbidden');
  }
  if (writing && rel !== 'evals' && !rel.startsWith('evals/')) throw new Error('Only evals/ is writable');
  return target;
}

// No shell, inherited credentials, child processes, native addons, or out-of-workspace filesystem access.
function runNode(workspace, args, timeout = 20_000, readOnly = false) {
  return spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${workspace}`,
    ...(readOnly ? [] : [`--allow-fs-write=${join(workspace, 'evals')}`]),
    ...args,
  ], {
    cwd: workspace, env: { PATH: dirname(process.execPath) }, encoding: 'utf8',
    timeout, maxBuffer: 1024 * 1024,
  });
}

// Conservative source gate, not a substitute for an OS sandbox. Unrecognized code fails closed.
export function reviewSource(workspace, script, seen = new Set()) {
  const source = readFileSync(script, 'utf8');
  if (seen.has(script)) return [];
  seen.add(script);
  const forbidden = /\b(?:import|eval|Function|fetch|WebSocket|globalThis|global)\b|\.constructor\b|\bmodule\s*\.\s*require\b|\brequire\b(?!\s*\()|\bprocess\s*(?:\[|\.\s*(?!cwd\b|argv\b|exit\b|exitCode\b))/;
  if (forbidden.test(source)) throw new Error(`Source review requires manual investigation: ${script}`);
  const dependencies = [];
  for (const match of source.matchAll(/\brequire\s*\(([^)]*)\)/g)) {
    const literal = match[1].trim().match(/^(['"])([^'"]+)\1$/);
    if (!literal) throw new Error(`Dynamic require is not permitted: ${script}`);
    const name = literal[2];
    if (['fs', 'fs/promises', 'path', 'util', 'assert', 'assert/strict', 'os'].some((builtin) => name === builtin || name === `node:${builtin}`)) continue;
    if (!name.startsWith('./') || !/\.(?:cjs|json)$/.test(name)) throw new Error(`Unapproved dependency ${name}`);
    const dependency = resolve(dirname(script), name);
    confined(workspace, relative(workspace, dependency), true);
    if (name.endsWith('.cjs')) dependencies.push(...reviewSource(workspace, dependency, seen));
  }
  return [{
    path: relative(workspace, script),
    sha256: createHash('sha256').update(source).digest('hex'),
    source,
    policy: 'Literal reviewed local CJS and allowlisted builtin imports only; no dynamic code/network/process-environment APIs. Node permission model remains the filesystem/child-process boundary.',
  }, ...dependencies];
}

export function verifyGeneratedSuite(workspace, evidenceDir) {
  const deadline = Date.now() + 60_000;
  const evals = join(workspace, 'evals');
  const review = reviewSource(workspace, join(evals, 'grader.cjs'));
  writeFileSync(join(evidenceDir, 'grader-source-review.json'), JSON.stringify(review, null, 2));
  const cases = JSON.parse(readFileSync(join(evals, 'cases.json'), 'utf8'));
  if (!Array.isArray(cases) || cases.length < 5 || cases.length > 10
      || new Set(cases.map((task) => task.id)).size !== cases.length
      || cases.some((task) => typeof task.id !== 'string' || !task.id)) {
    throw new Error('Expected 5–10 uniquely named target-specific cases');
  }
  const expected = cases.map((task) => expectedIndex(task.input));
  if (new Set(cases.map((task) => JSON.stringify(task.input))).size !== cases.length
      || !expected.some((output) => output.entries.some((entry) => entry.units === 0))
      || !expected.some((output) => output.entries.length === 0)
      || !expected.some((output) => output.entries.length >= 2)) {
    throw new Error('Suite must cover empty inventory, zero units, and multiple entries');
  }
  // The harness runner is independent of the author's implementation and final prose.
  const checker = join(evals, '.authoring-check.cjs');
  writeFileSync(checker, `
const grade = require('./grader.cjs');
const fs = require('node:fs');
const task = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
Promise.resolve(grade(process.argv[3], task)).then(result => {
  if (!result || typeof result.pass !== 'boolean') throw Error('Expected {pass:boolean}');
  console.log('AUTHORING_VERDICT:' + JSON.stringify(result));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
`);
  const outcomes = [];
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    const caseFile = join(evals, `.authoring-case-${i}.json`);
    writeFileSync(caseFile, JSON.stringify(cases[i]));
    const good = expected[i];
    const mutations = [
      ['good', good, true],
      ['wrong-total', { ...good, totalUnits: good.totalUnits + 1 }, false],
      ['wrong-shipment', { ...good, shipment: `${good.shipment}-wrong` }, false],
      ['wrong-entries', { ...good, entries: [...good.entries, { crate: 'invented', code: 'extra', units: 0 }] }, false],
      ['corrupt', '{broken', false],
      ['missing', undefined, false],
    ];
    if (good.entries.length) {
      for (const field of ['crate', 'code', 'units']) {
        const entries = good.entries.map((entry) => ({ ...entry }));
        entries[0][field] = field === 'units' ? entries[0].units + 1 : `${entries[0][field]}-wrong`;
        mutations.push([`wrong-${field}-same-length`, { ...good, entries }, false]);
      }
      const distinct = good.entries.findIndex((entry) => JSON.stringify(entry) !== JSON.stringify(good.entries[0]));
      if (distinct !== -1) {
        const entries = [...good.entries];
        [entries[0], entries[distinct]] = [entries[distinct], entries[0]];
        mutations.push(['wrong-order-same-length', { ...good, entries }, false]);
      }
    }
    if (good.entries.some((entry) => entry.units === 0)) {
      mutations.push(['dropped-zero', { ...good, entries: good.entries.filter((entry) => entry.units !== 0) }, false]);
    }
    for (const [mutation, artifact, shouldPass] of mutations) {
      const runDir = join(evals, '.authoring-probes', `${i}-${mutation}`);
      mkdirSync(runDir, { recursive: true });
      if (artifact !== undefined) writeFileSync(join(runDir, 'index.json'),
        typeof artifact === 'string' ? artifact : JSON.stringify(artifact));
      writeFileSync(join(runDir, 'shipment.json'), JSON.stringify(cases[i].input));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Independent grader probes exceeded the 60 second verification budget');
      const result = runNode(workspace, [checker, caseFile, runDir], Math.min(20_000, remaining), true);
      const verdicts = result.stdout?.split('\n').filter((line) => line.startsWith('AUTHORING_VERDICT:')) ?? [];
      let verdict;
      try { verdict = JSON.parse(verdicts.at(-1)?.slice('AUTHORING_VERDICT:'.length)); } catch { /* Recorded below. */ }
      const record = {
        caseId: cases[i].id, mutation, shouldPass, verdict, status: result.status,
        transcriptClaim: 'Success: index.json is perfectly correct (not supplied as artifact evidence).',
        stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
      };
      outcomes.push(record);
      writeFileSync(join(evidenceDir, 'grader-probes.json'), JSON.stringify(outcomes, null, 2));
      if (result.status !== 0 || verdict?.pass !== shouldPass) {
        failures.push(`${cases[i].id}/${mutation}`);
      }
    }
  }
  if (failures.length) throw new Error(`Generated grader failed independent probes: ${failures.join(', ')}; see grader-probes.json`);
  const config = JSON.parse(readFileSync(join(evals, 'promptfooconfig.json'), 'utf8'));
  const assertions = [...(config.defaultTest?.assert ?? []), ...(config.tests ?? []).flatMap((task) => task.assert ?? [])];
  const assertion = assertions.find((item) => item.type === 'javascript' && item.value?.startsWith('file://'));
  if (!assertion) throw new Error('Generated Promptfoo config must include a JavaScript file assertion');
  const assertionPath = confined(workspace, relative(workspace, resolve(evals, assertion.value.slice(7))), true);
  writeFileSync(join(evidenceDir, 'promptfoo-source-review.json'), JSON.stringify(reviewSource(workspace, assertionPath), null, 2));
  const promptfooChecker = join(evals, '.authoring-promptfoo-check.cjs');
  writeFileSync(promptfooChecker, `
const fs = require('node:fs');
const { assertions, TestSuiteConfigSchema } = require(${JSON.stringify(join(root, 'node_modules/promptfoo/dist/src/index.cjs'))});
TestSuiteConfigSchema.parse(JSON.parse(fs.readFileSync('./evals/promptfooconfig.json', 'utf8')));
const testCase = JSON.parse(fs.readFileSync('./evals/.authoring-case-0.json', 'utf8'));
assertions.runAssertion({
  assertion: ${JSON.stringify({ ...assertion, value: `file://${assertionPath}` })},
  test: { vars: { runDirectory: process.argv[2], testCase } },
  providerResponse: { output: process.argv[2] }
}).then(result => console.log('AUTHORING_PROMPTFOO:' + JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
`);
  const promptfoo = [];
  for (const [mutation, shouldPass] of [['good', true], ['wrong-total', false]]) {
    const result = spawnSync(process.execPath, [
      '--permission', `--allow-fs-read=${workspace}`, `--allow-fs-read=${join(root, 'node_modules')}`,
      `--allow-fs-write=${join(evals, '.promptfoo')}`,
      promptfooChecker, join(evals, '.authoring-probes', `0-${mutation}`),
    ], {
      cwd: workspace, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
      env: {
        PATH: dirname(process.execPath), HOME: join(evals, '.promptfoo'),
        PROMPTFOO_CONFIG_DIR: join(evals, '.promptfoo'), PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1', LOG_LEVEL: 'error',
      },
    });
    const line = result.stdout?.split('\n').find((item) => item.startsWith('AUTHORING_PROMPTFOO:'));
    let verdict;
    try { verdict = JSON.parse(line?.slice('AUTHORING_PROMPTFOO:'.length)); } catch { /* Raw output retained below. */ }
    promptfoo.push({ mutation, shouldPass, verdict, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    writeFileSync(join(evidenceDir, 'promptfoo-probes.json'), JSON.stringify(promptfoo, null, 2));
  }
  if (promptfoo.some((probe) => probe.status !== 0 || probe.verdict?.pass !== probe.shouldPass)) {
    throw new Error('Generated Promptfoo file assertion failed independent good/broken artifact probes; see promptfoo-probes.json');
  }
  return { cases: cases.length, probes: outcomes.length, promptfooProbes: promptfoo.length };
}

export function parseAuthoringArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--runtime', '--model', '--timeout'].includes(flag) || !argv[i + 1]
        || argv[i + 1].startsWith('--') || Object.hasOwn(values, flag)) {
      throw new Error('Expected --runtime copilot [--model ID] [--timeout MS]');
    }
    values[flag] = argv[i + 1];
  }
  if (values['--runtime'] !== 'copilot') throw new Error('Only --runtime copilot is supported; other authoring runtimes are unrun');
  return {
    runtime: 'copilot', optIn: true,
    ...(values['--model'] ? { model: values['--model'] } : {}),
    ...(values['--timeout'] ? { timeoutMs: Number(values['--timeout']) } : {}),
  };
}

export async function authoringSmoke(options = {}) {
  if (options.runtime !== undefined && options.runtime !== 'copilot') throw new Error('Only Copilot authoring is implemented; other runtimes are unrun');
  if (!options.optIn && process.env.AUTHORING_LIVE !== '1') {
    throw new Error('Opt in with --runtime copilot or AUTHORING_LIVE=1; this consumes credentialed Copilot requests');
  }
  const timeout = Number(options.timeoutMs ?? process.env.AUTHORING_TIMEOUT_MS ?? 300_000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000) throw new Error('Timeout must be 1000–600000 ms');
  const model = options.model ?? process.env.AUTHORING_MODEL;
  const results = join(root, '.eval-results');
  mkdirSync(results, { recursive: true });
  const run = mkdtempSync(join(results, 'authoring-'));
  const authorRoot = mkdtempSync(join(tmpdir(), 'skill-authoring-'));
  assertNoSymlinks(authorRoot);
  const workspace = join(authorRoot, 'workspace');
  const state = join(authorRoot, 'sdk-state');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const init = spawnSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', workspace], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (init.status !== 0) throw new Error(`Cannot initialize disposable target repository: ${init.stderr}`);
  cpSync(fixture, join(workspace, 'target'), { recursive: true });
  const installed = installSkill('copilot', workspace);
  const skillHash = hashTree(canonical);
  const targetHash = hashTree(join(workspace, 'target'));
  const report = {
    kind: 'live-fresh-agent-authoring', runtime: 'copilot', status: 'unverified', run, workspace, state,
    canonical: skillHash, installed: hashTree(installed), target: targetHash,
    model: model ?? 'runtime-default', timeoutMs: timeout,
    modelSelection: model ? 'Explicit model requested' : 'Official SDK/runtime chooses its default; observed model IDs are recorded separately',
    limitation: 'Tool boundary plus Node permission model, not an OS/network sandbox. No shell or production credentials exposed to generated code. This tests authoring, not live target execution or a causal ablation.',
  };
  const record = (event) => appendFileSync(join(run, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  const persist = () => writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
  const deadline = Date.now() + timeout;
  const timeBound = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Authoring session deadline exceeded')), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  persist();
  console.log(`Authoring evidence: ${run}`);
  let client;
  let session;
  const events = [];
  try {
    const { CopilotClient, ToolSet, defineTool } = await import('@github/copilot-sdk');
    report.versions = {
      node: process.version,
      sdk: JSON.parse(readFileSync(join(root, 'node_modules/@github/copilot-sdk/package.json'), 'utf8')).version,
    };
    const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
    const string = { type: 'string' };
    const tools = [
      defineTool('workspace_read', {
        skipPermission: true,
        description: 'Read a UTF-8 file inside the authoring workspace.',
        parameters: schema({ path: string }, ['path']),
        handler: ({ path }) => readFileSync(confined(workspace, path), 'utf8'),
      }),
      defineTool('workspace_list', {
        skipPermission: true,
        description: 'List a directory inside the authoring workspace.',
        parameters: schema({ path: string }, ['path']),
        handler: ({ path }) => readdirSync(confined(workspace, path), { withFileTypes: true })
          .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n'),
      }),
      defineTool('workspace_write', {
        skipPermission: true,
        description: 'Write a UTF-8 file under evals/; target and installed skill are read-only.',
        parameters: schema({ path: string, content: string }, ['path', 'content']),
        handler: ({ path, content }) => {
          const destination = confined(workspace, path, true);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, content);
          return `Wrote ${path}`;
        },
      }),
      defineTool('workspace_node', {
        skipPermission: true,
        description: 'Run a Node script under evals/ (or syntax-check it), without a shell. Builtin modules only; no child processes. 20 second limit.',
        parameters: schema({ path: string, check: { type: 'boolean' } }, ['path']),
        handler: ({ path, check }) => {
          const script = confined(workspace, path, true);
          if (!check) record({ type: 'harness.source-review', files: reviewSource(workspace, script) });
          const result = runNode(workspace, [...(check ? ['--check'] : []), script]);
          return JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
        },
      }),
    ];
    client = new CopilotClient({
      workingDirectory: workspace, baseDirectory: state, logLevel: 'error',
      ...(process.env.COPILOT_SDK_AUTH_TOKEN ? { gitHubToken: process.env.COPILOT_SDK_AUTH_TOKEN } : {}),
    });
    session = await timeBound(client.createSession({
      ...(model ? { model } : {}),
      workingDirectory: workspace, configDirectory: state, enableConfigDiscovery: false,
      skillDirectories: [join(workspace, '.github/skills')], tools,
      availableTools: tools.reduce((set, tool) => set.addCustom(tool.name), new ToolSet().addBuiltIn('skill')),
      onPermissionRequest: async (request) => {
        record({ type: 'harness.permission', request, result: 'reject' });
        return { kind: 'reject', feedback: 'Use the scoped workspace tools only.' };
      },
    }));
    report.sessionId = session.sessionId;
    session.on((event) => { events.push(event); record(event); });
    const prompt = `Add evals for target/SKILL.md using the installed add-skill-evals skill. Leave target and installed files unchanged. Work unattended using only the scoped workspace tools and builtin Node modules; no network or live target-agent calls are authorized.
The host integration interface is evals/cases.json, a JSON array of {id,input} where input is the full shipment.json object, and evals/grader.cjs exporting an async or sync function (runDirectory, testCase) returning {pass:boolean,reason:string}. Also deliver runnable evals/promptfooconfig.json using the offline echo provider and a JavaScript file assertion delegating to that same grader, with test vars runDirectory and testCase as the artifact-directory/task interface. All generated scripts and local validation files must stay under evals/. Deliver runnable commands and an evidence summary.`;
    writeFileSync(join(run, 'prompt.txt'), prompt);
    const response = await timeBound(session.sendAndWait({ prompt }, Math.max(1, deadline - Date.now())));
    writeFileSync(join(run, 'response.txt'), response?.data?.content ?? '');
    await session.disconnect();
    session = undefined;
    await client.stop();
    client = undefined;
    record({ type: 'harness.author-runtime-stopped', timestamp: new Date().toISOString() });
    report.activation = events.filter((event) => event.type === 'skill.invoked');
    const nativeContext = events.find((event) => event.type === 'session.start')?.data?.context;
    if (nativeContext?.cwd !== workspace || nativeContext?.gitRoot !== workspace) {
      throw new Error('Native runtime did not confirm the independent author workspace and Git root');
    }
    report.workspaceContext = nativeContext;
    const skillBody = readFileSync(join(installed, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, '');
    if (!report.activation.some((event) => event.data?.name === 'add-skill-evals'
        && event.data.path === join(installed, 'SKILL.md') && event.data.content === skillBody)) {
      throw new Error('No independent native activation event with exact installed canonical skill body and path');
    }
    if (hashTree(installed).sha256 !== skillHash.sha256
        || hashTree(join(workspace, 'target')).sha256 !== targetHash.sha256) throw new Error('Protected files changed');
    report.generated = hashTree(join(workspace, 'evals'));
    cpSync(join(workspace, 'evals'), join(run, 'generated-evals'), { recursive: true });
    report.validation = verifyGeneratedSuite(workspace, run);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    report.observedModels = [...new Set(events.filter((event) => event.type === 'session.model_change').map((event) => event.data?.newModel))];
    report.runtimeVersions = [...new Set(events.filter((event) => event.type === 'session.start').map((event) => event.data?.copilotVersion))];
    persist();
    if (session) await session.disconnect().catch((error) => record({ type: 'harness.disconnect-error', error: String(error) }));
    if (client) await client.stop().catch((error) => record({ type: 'harness.stop-error', error: String(error) }));
    try {
      cpSync(workspace, join(run, 'workspace-snapshot'), { recursive: true });
    } finally {
      rmSync(authorRoot, { recursive: true, force: true });
    }
  }
  return report;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: npm run eval:authoring -- --runtime copilot [--model ID] [--timeout MS]\n' +
      'Explicit opt-in: consumes credentialed requests via the official Copilot SDK. Other runtimes are unrun.\n' +
      'Default model: SDK/runtime selection; observed model and SDK/CLI versions plus full skill-tree hashes are recorded.\n' +
      'Timeout: 300000 ms by default, 1000–600000 ms allowed; independent probes have a separate 60000 ms budget.\n' +
      'Raw suites, source reviews, native activation events and independent file probes remain in ignored .eval-results/.\n' +
      'Agent workspaces and SDK state use a fresh OS temporary directory outside the repository; workspace snapshots are retained with evidence.\n' +
      'This is an authoring proof, not live target execution, a causal ablation, or ordinary offline CI.');
  } else {
    Promise.resolve().then(() => authoringSmoke(parseAuthoringArgs(process.argv.slice(2))))
      .then((report) => console.log(JSON.stringify({ status: report.status, ...report.validation, run: report.run })))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
