import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { cleanupCodexArtifacts, createCodexIsolation, findCodexExecutable, probeCodexIsolation } from '../scripts/codex-isolation.mjs';
import { readIsolation } from '../scripts/runtime-isolation.mjs';
import { auditCodexTranscript, classifyCodexCommand, prepareCodexAudit } from '../scripts/codex-audit.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('Codex authentication or a configuration-only isolation claim never verifies a profile', () => {
  for (const response of [
    { output: 'correct' },
    { metadata: { harnessIsolation: { configured: true, verified: true } } },
    { metadata: { harnessIsolation: { kind: 'docker-native-codex', configured: true, nativeLaunches: 1 } } },
  ]) assert.equal(readIsolation('codex', response).verified, false);
});

test('Codex verdict contract requires every enforcement probe and a successful native exec', () => {
  const probe = Object.fromEntries([
    'verified', 'readDenied', 'writeDenied', 'hostWriteDenied', 'networkDenied',
    'networkNamespaceOnlyLoopback', 'relayReachable', 'relayDeniesOtherPaths',
  ].map((key) => [key, true]));
  const evidence = {
    kind: 'docker-native-codex', configured: true, freshHome: true, nativeLaunches: 1,
    filesystem: 'empty-root-explicit-readonly-mounts',
    network: 'none-with-model-only-unix-relay', probe,
  };
  const response = (value) => ({ metadata: { harnessIsolation: value } });
  assert.equal(readIsolation('codex', response(evidence)).verified, true, 'Synthetic verdict contract only; not live model evidence');
  for (const key of Object.keys(probe)) {
    assert.equal(readIsolation('codex', response({ ...evidence, probe: { ...probe, [key]: false } })).verified, false, key);
  }
  assert.equal(readIsolation('codex', response({ ...evidence, nativeLaunches: 0 })).verified, false);
  assert.equal(readIsolation('codex', { ...response(evidence), error: 'native runtime failed' }).verified, false);
});

test('Codex optional isolation fails closed on invalid paths or an unsupported endpoint', async () => {
  await assert.rejects(createCodexIsolation({ workspace: 'relative', artifactDir: root }), /must be absolute/);
  await assert.rejects(createCodexIsolation({ workspace: root, artifactDir: root }), /outside the workspace/);
});

test('Codex shell audit accepts only literal read-only commands, not arbitrary search or shell execution', () => {
  for (const command of [
    'cat -- source.js', "/bin/bash -lc 'cat source.js'", 'pwd', 'ls -la .',
    "sed -n '1,120p' source.js", "rg -n -e 'foo|bar' source.js", "grep -n -e 'touch' source.js",
  ]) assert.equal(classifyCodexCommand(command).readOnly, true, command);
  for (const command of [
    'unknown-script', 'node -e "fs.writeFileSync()"', 'cat source.js && touch file',
    'cat $(touch file)', 'cat `touch file`', 'cat $FILE', 'cat *.js',
    'rg --pre=unknown-script pattern .', 'rg --hostname-bin unknown-script pattern .',
    'find . -exec touch file ;', "sed -n '1p;w output' source.js",
    "bash -lc 'source .profile; cat source.js'", 'env cat source.js',
  ]) assert.equal(classifyCodexCommand(command).readOnly, false, command);
  for (const command of ['touch file', 'cat source.js > output', "/bin/bash -lc 'tee output'"]) {
    assert.equal(classifyCodexCommand(command).mutation, true, command);
  }
});

test('Codex exact skill-read audit can verify activation without upgrading unknown commands or missing traces', async () => {
  const trial = await mkdtemp(path.join(tmpdir(), 'codex-audit-'));
  const workspace = path.join(trial, 'workspace');
  const skill = path.join(workspace, '.agents/skills/review-code/SKILL.md');
  const contents = '# Review\nExact installed skill instructions.\n';
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, contents);
  try {
    const prepared = await prepareCodexAudit(workspace);
    const item = {
      type: 'command_execution', command: `/bin/bash -lc 'cat ${skill}'`,
      status: 'completed', exit_code: 0, aggregated_output: contents,
    };
    const response = (items, usage = { input_tokens: 10, output_tokens: 4 }) => ({
      raw: JSON.stringify({ items, usage }),
    });
    const audit = auditCodexTranscript(response([item]), prepared, true);
    assert.equal(audit.verifiedSkillRead, true, 'Synthetic native transcript contract, not a live task claim');
    assert.equal(audit.activationEvidenceKind, 'heuristic-skill-read');
    assert.equal(audit.nativeSkillInvocationObserved, false);
    assert.equal(audit.writeAttemptTraceAvailable, true);
    assert.equal(audit.activationTraceAvailable, true);
    assert.equal(audit.skillReadCount, 1);
    assert.equal(auditCodexTranscript(response([item]), prepared, false).writeAttemptTraceAvailable, false, 'Read-only classifications do not replace OS enforcement');
    assert.equal(auditCodexTranscript(response([item], null), prepared, true).activationTraceAvailable, false);
    assert.equal(auditCodexTranscript(response([{ ...item, status: 'in_progress', exit_code: null }]), prepared, true).activationTraceAvailable, false);
    assert.equal(auditCodexTranscript({}, prepared, true).activationTraceAvailable, false);
    assert.equal(auditCodexTranscript(response([{ ...item, aggregated_output: 'not the installed skill' }]), prepared, true).verifiedSkillRead, false);
    const failed = auditCodexTranscript(response([{ ...item, status: 'failed', exit_code: 1 }]), prepared, true);
    assert.equal(failed.skillReadCount, 0);
    assert.equal(failed.skillReadAttemptCount, 1);
    for (const command of [`sed -n '1,4p' ${skill}`, `rg -n Review ${skill}`, `grep -n Review ${skill}`]) {
      const attempted = auditCodexTranscript(response([{ ...item, command, status: 'failed', exit_code: 1 }]), prepared, true);
      assert.equal(attempted.skillReadAttemptCount, 1, command);
      assert.equal(attempted.verifiedSkillRead, false, 'Only single-file full-output cat reads verify consumption');
    }
    for (const command of ['rg Review .', 'grep -R Review .']) {
      const search = auditCodexTranscript(response([{ ...item, command }]), prepared, true);
      assert.equal(search.writeAttemptTraceAvailable, true);
      assert.equal(search.activationTraceAvailable, false, 'Unresolved recursive search scopes cannot prove nonactivation');
    }
    const unknown = auditCodexTranscript(response([item, { ...item, command: 'unknown-script' }]), prepared, true);
    assert.equal(unknown.verifiedSkillRead, false);
    assert.equal(unknown.writeAttemptTraceAvailable, false);
    assert.equal(auditCodexTranscript(response([item, { type: 'mcp_tool_call' }]), prepared, true).activationTraceAvailable, false);
    const attempted = auditCodexTranscript(response([{ ...item, command: 'touch source.js', status: 'failed', exit_code: 1 }]), prepared, true);
    assert.equal(attempted.writeAttemptCount, 1);
    assert.equal(attempted.writeAttemptTraceAvailable, false);
    await rm(path.join(workspace, '.agents'), { recursive: true });
    const baseline = await prepareCodexAudit(workspace);
    const negative = auditCodexTranscript(response([{ ...item, command: 'cat source.js', aggregated_output: 'source' }]), baseline, true);
    assert.equal(negative.skillInstalled, false);
    assert.equal(negative.skillReadCount, 0);
    assert.equal(negative.activationTraceAvailable, true);
    for (const command of [`sed -n '1,4p' ${skill}`, `rg Review ${skill}`, `grep Review ${skill}`]) {
      const missing = auditCodexTranscript(response([{ ...item, command, status: 'failed', exit_code: 1 }]), baseline, true);
      assert.equal(missing.skillReadAttemptCount, 1, `Missing baseline skill: ${command}`);
    }
    await symlink(path.join(workspace, 'source.js'), path.join(workspace, 'source-alias'));
    const aliases = await prepareCodexAudit(workspace);
    assert.equal(auditCodexTranscript(response([{ ...item, command: 'cat source-alias' }]), aliases, true).activationTraceAvailable, false);
  } finally { await rm(trial, { recursive: true, force: true }); }
});

test('Docker enforces evaluator read/write and network boundaries with a model-only relay', { timeout: 120000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('Enforced Codex profile requires Linux and Docker');
  try { await execute('docker', ['--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{.OSType}}'], { timeout: 10000 }); }
  catch { return t.skip('Docker daemon unavailable; no OS boundary or live Codex verification is claimed'); }
  const trial = await mkdtemp(path.join(tmpdir(), 'codex-os-'));
  const workspace = path.join(trial, 'workspace');
  const evaluator = path.join(trial, 'private-evaluator.json');
  const answers = path.join(trial, 'answers.json');
  const otherVariant = path.join(trial, 'other-variant', 'SKILL.md');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(otherVariant));
  await writeFile(path.join(workspace, 'source.js'), 'export const value = 1;\n');
  for (const filename of [evaluator, answers, otherVariant]) await writeFile(filename, 'hidden evaluator data');
  await symlink(evaluator, path.join(workspace, 'escape'));
  const credential = randomUUID();
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{"offlineModelFixture":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let boundary;
  try {
    boundary = await createCodexIsolation({
      workspace, artifactDir: trial, executable: '/bin/sh', apiKey: credential,
      modelEndpoint: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    });
    const probe = await probeCodexIsolation(boundary, evaluator);
    assert.equal(probe.verified, true, JSON.stringify(probe));
    const output = JSON.parse(await boundary.run(`
      import fs from 'node:fs';
      import http from 'node:http';
      import net from 'node:net';
      const files = ${JSON.stringify([evaluator, answers, otherVariant, path.join(workspace, 'escape'), process.env.HOME && path.join(process.env.HOME, '.codex/auth.json')].filter(Boolean))};
      const deniedReads = files.map(file => { try { fs.readFileSync(file); return false; } catch { return true; } });
      const source = fs.readFileSync(${JSON.stringify(path.join(workspace, 'source.js'))}, 'utf8');
      const fetchRelay = (url, method = 'POST') => new Promise((resolve, reject) => {
        const request = http.request({socketPath:'/relay/model.sock', method, path:url}, response => {
          let body = ''; response.on('data', part => body += part);
          response.on('end', () => resolve({status:response.statusCode, body}));
        }); request.on('error', reject); request.end('{}');
      });
      const model = await fetchRelay('/v1/responses');
      const blocked = await fetchRelay('/v1/files');
      const blockedQuery = await fetchRelay('/v1/responses?redirect=https://example.com');
      const hostUnreachable = await new Promise(resolve => {
        const socket = net.connect({host:'127.0.0.1', port:${upstream.address().port}});
        socket.on('connect', () => {socket.destroy(); resolve(false);});
        socket.on('error', () => resolve(true));
      });
      console.log(JSON.stringify({deniedReads, source, model, blocked, blockedQuery, hostUnreachable, env:process.env}));
    `));
    assert.ok(output.deniedReads.every(Boolean));
    assert.match(output.source, /export const value/);
    assert.deepEqual(output.model, { status: 200, body: '{"offlineModelFixture":true}' });
    assert.equal(output.blocked.status, 403);
    assert.equal(output.blockedQuery.status, 403);
    assert.equal(output.hostUnreachable, true);
    assert.ok(!JSON.stringify(output.env).includes(credential), 'The real API credential stays in the host relay');
    assert.deepEqual(requests, [{ method: 'POST', path: '/v1/responses', authorization: ['Bearer', credential].join(' ') }]);
    assert.equal(await readFile(evaluator, 'utf8'), 'hidden evaluator data');
    assert.equal(await readFile(path.join(workspace, 'source.js'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await boundary.evidence()).nativeLaunches, 0);
    assert.equal(readIsolation('codex', { metadata: { harnessIsolation: { ...await boundary.evidence(), probe } } }).verified, false,
      'Successful offline sandbox probes alone do not verify a live native Codex completion');
    await assert.rejects(createCodexIsolation({
      workspace, artifactDir: trial, executable: '/bin/sh', apiKey: credential,
      modelEndpoint: 'https://example.com/v1/files',
    }), /Model endpoint/);
    await assert.rejects(boundary.run('setInterval(() => {}, 1000)', { timeoutMs: 1000 }), /deadline exceeded/);
    await assert.rejects(execute('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', boundary.manifest.containerName]), /No such/);
  } finally {
    await boundary?.cleanup();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(trial, { recursive: true, force: true });
  }
});

test('Outer evaluator cleans daemon-owned containers and images after a worker process-group SIGKILL', { timeout: 30000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('Docker process-group cleanup requires Linux');
  try { await execute('docker', ['--host', 'unix:///var/run/docker.sock', 'info'], { timeout: 10000 }); }
  catch { return t.skip('Local Docker daemon unavailable; no SIGKILL cleanup evidence is claimed'); }
  const trial = await mkdtemp(path.join(tmpdir(), 'codex-kill-'));
  const workspace = path.join(trial, 'workspace');
  await mkdir(workspace, { recursive: true });
  const fakeCli = path.join(trial, 'offline-hanging-cli');
  await writeFile(fakeCli, "#!/bin/sh\nexec /runtime/node -e 'setInterval(() => {}, 1000)'\n", { mode: 0o700 });
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn, execFileSync} from 'node:child_process';
    import {createCodexIsolation} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/codex-isolation.mjs')).href)};
    const boundary = await createCodexIsolation({
      workspace:${JSON.stringify(workspace)}, artifactDir:${JSON.stringify(trial)},
      executable:${JSON.stringify(fakeCli)}, apiKey:'offline-placeholder'
    });
    spawn(boundary.wrapper, ['exec'], {stdio:'ignore'});
    for (let attempt=0; attempt<100; attempt++) {
      try {
        const running=execFileSync(boundary.manifest.docker,
          ['inspect','--format','{{.State.Running}}',boundary.manifest.containerName],
          {env:boundary.manifest.dockerEnv, stdio:['ignore','pipe','ignore'], timeout:1000}).toString().trim();
        if(running==='true') {console.log(JSON.stringify({name:boundary.manifest.containerName,owner:boundary.manifest.owner})); break;}
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let killed = false;
  try {
    const { name, owner } = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error(`Worker startup deadline: ${errors}`)), 15000);
      worker.stderr.on('data', (data) => { errors += data; });
      worker.stdout.on('data', (data) => {
        output += data;
        if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); }
      });
      worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${errors}`)); });
    });
    process.kill(-worker.pid, 'SIGKILL');
    killed = true;
    await new Promise((resolve) => worker.once('close', resolve));
    await cleanupCodexArtifacts(trial);
    await assert.rejects(execute('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', name]), /No such/);
    const { stdout: images } = await execute('docker', [
      '--host', 'unix:///var/run/docker.sock', 'image', 'ls', '--filter', `label=eval.codex.owner=${owner}`, '--quiet',
    ]);
    assert.equal(images.trim(), '', 'Killed-worker scratch images are also removed by their run label');
    assert.equal(await readFile(fakeCli, 'utf8'), "#!/bin/sh\nexec /runtime/node -e 'setInterval(() => {}, 1000)'\n");
  } finally {
    if (!killed) { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    await cleanupCodexArtifacts(trial);
    await rm(trial, { recursive: true, force: true });
  }
});

test('Installed native Codex CLI starts through the isolated executable override without claiming a live run', { timeout: 120000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('Codex Docker profile requires Linux');
  let executable;
  try {
    await execute('docker', ['--host', 'unix:///var/run/docker.sock', 'info'], { timeout: 10000 });
    executable = await findCodexExecutable();
  } catch { return t.skip('Docker or pinned native Codex CLI unavailable; no live Codex verification is claimed'); }
  const trial = await mkdtemp(path.join(tmpdir(), 'codex-cli-'));
  const workspace = path.join(trial, 'workspace');
  await mkdir(workspace, { recursive: true });
  let modelRequests = 0;
  const upstream = createServer((request, response) => {
    modelRequests++;
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'offline fixture refuses model execution', type: 'invalid_request_error' } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let boundary;
  try {
    boundary = await createCodexIsolation({
      workspace, artifactDir: trial, executable, apiKey: 'offline-placeholder',
      modelEndpoint: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    });
    const { stdout } = await execute(boundary.wrapper, ['--version'], { timeout: 30000 });
    assert.match(stdout, /codex-cli/);
    assert.equal((await boundary.evidence()).nativeLaunches, 0, 'Version output is not a model completion');
    await assert.rejects(execute(boundary.wrapper, ['exec', 'resume', 'old-session']), /fresh session/);
    const { Codex } = await import('@openai/codex-sdk');
    const schemas = path.join(path.dirname(boundary.wrapper), 'schemas');
    await mkdir(schemas, { mode: 0o700 });
    const config = {
      model_provider: 'isolated_openai',
      shell_environment_policy: {
        inherit: 'none', set: { PATH: '/runtime/bin:/bin', HOME: '/home/codex', TMPDIR: '/scratch', CODEX_HOME: '/home/codex' },
      },
      features: { shell_snapshot: false },
      model_providers: { isolated_openai: {
        name: 'Isolated OpenAI relay', base_url: 'http://127.0.0.1:43127/v1',
        wire_api: 'responses', env_key: 'CODEX_API_KEY', supports_websockets: false,
        request_max_retries: 0, stream_max_retries: 0,
      } },
    };
    const { loadApiProvider } = await import('promptfoo');
    const provider = await loadApiProvider('openai:codex-sdk', {
      options: { config: { codex_path_override: boundary.wrapper, cli_config: config } },
    });
    assert.equal(provider.config.codex_path_override, boundary.wrapper, 'The native promptfoo provider preserves the supported SDK executable override');
    const codex = new Codex({ codexPathOverride: boundary.wrapper, config, apiKey: 'isolated-relay' });
    const previousScratch = process.env.TMPDIR;
    process.env.TMPDIR = schemas;
    try {
      await assert.rejects(codex.startThread({
        workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'danger-full-access',
        approvalPolicy: 'never', model: 'gpt-5.4',
      }).run('Offline transport probe; no task execution.', {
        signal: AbortSignal.timeout(20000),
        outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false },
      }), /offline fixture refuses model execution/);
    } finally {
      if (previousScratch === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousScratch;
    }
    assert.ok(modelRequests > 0, 'Native SDK stdin and model requests cross only the restricted relay');
    assert.equal((await boundary.evidence()).nativeLaunches, 0, 'An offline API error must not verify a live native completion');
  } finally {
    await boundary?.cleanup();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(trial, { recursive: true, force: true });
  }
});
