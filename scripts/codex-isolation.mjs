import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import https from 'node:https';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startContainer } from './codex-container.mjs';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const dockerEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DOCKER_HOST: 'unix:///var/run/docker.sock',
};
const ownerFor = (directory) => createHash('sha256').update(directory).digest('hex');

// The outer evaluator must call this after killing a worker: daemon-owned
// containers do not belong to the worker's POSIX process group.
export async function cleanupCodexArtifacts(artifactDir) {
  if (!path.isAbsolute(artifactDir)) throw new Error('Codex cleanup requires an absolute artifact directory');
  const directory = await realpath(artifactDir);
  const states = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^codex-boundary-[0-9a-f-]{36}$/.test(entry.name));
  if (states.length === 0) return;
  const records = [];
  for (const entry of states) {
    const state = path.join(directory, entry.name);
    let record;
    try { record = JSON.parse(await readFile(path.join(state, 'resources.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await rm(state, { recursive: true, force: true });
      continue;
    }
    if (record.owner !== ownerFor(directory) || !/^[0-9a-f-]{36}$/.test(record.nonce)) {
      throw new Error('Refusing cleanup of unrecognized Codex resource ownership metadata');
    }
    records.push({ ...record, state });
  }
  if (records.length === 0) return;
  const { stdout: docker } = await execute('/usr/bin/which', ['docker'], { env: dockerEnv });
  const run = (args) => execute(docker.trim(), args, { env: dockerEnv, timeout: 10000 });
  for (const record of records) {
    const filters = ['--filter', `label=eval.codex.owner=${record.owner}`, '--filter', `label=eval.codex.boundary=${record.nonce}`];
    const { stdout: containers } = await run(['ps', '--all', ...filters, '--format', '{{.ID}}']);
    const containerIds = containers.trim().split('\n').filter(Boolean);
    if (containerIds.length) {
      try { await run(['rm', '-f', ...containerIds]); }
      catch (error) {
        const remaining = await run(['ps', '--all', ...filters, '--format', '{{.ID}}']);
        if (remaining.stdout.trim()) throw error;
      }
    }
    const { stdout: images } = await run(['image', 'ls', ...filters, '--quiet']);
    const imageIds = [...new Set(images.trim().split('\n').filter(Boolean))];
    if (imageIds.length) await run(['image', 'rm', ...imageIds]);
    await rm(record.state, { recursive: true, force: true });
  }
}

async function binaryMounts(binary, target) {
  const source = await realpath(binary);
  const { stdout } = await execute('/usr/bin/ldd', [source], { env: dockerEnv });
  const libraries = [...stdout.matchAll(/(?:=>\s+|^\s*)(\/[^\s(]+)/gm)].map((match) => match[1]);
  return [
    { source, target },
    ...await Promise.all(libraries.map(async (library) => ({ source: await realpath(library), target: library }))),
  ];
}

async function checkWorkspace(directory) {
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const stat = await lstat(entry);
    if (stat.isDirectory()) await checkWorkspace(entry);
    else if (!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Isolated fixtures must not contain sockets, devices, pipes, or hard-linked files');
    }
  }
}

export async function findCodexExecutable() {
  const sdk = path.join(here, '../node_modules/@openai');
  const packages = await readdir(sdk);
  const platform = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  for (const name of ['codex', ...packages.filter((name) => name.startsWith('codex-linux-'))]) {
    for (const suffix of ['bin/codex', 'codex/codex']) {
      const candidate = path.join(sdk, name, 'vendor', platform, suffix);
      try { return await realpath(candidate); } catch { /* Try the native optional package layout. */ }
    }
  }
  throw new Error('Native Codex executable not found; install the pinned Codex CLI before opting into isolation');
}

// Opt in with EVAL_CODEX_ISOLATION=docker and an API key. Requires a local Linux
// Docker daemon and the pinned native CLI; no image pull or personal HOME mount.
export async function createCodexIsolation({
  workspace, artifactDir, executable, apiKey, modelEndpoint = 'https://api.openai.com/v1/responses',
} = {}) {
  if (process.platform !== 'linux') throw new Error('Codex Docker isolation requires Linux');
  if (!path.isAbsolute(workspace ?? '') || !path.isAbsolute(artifactDir ?? '')) {
    throw new Error('Isolation workspace and artifact paths must be absolute');
  }
  const root = await realpath(workspace);
  const artifacts = await realpath(artifactDir);
  const relative = path.relative(root, artifacts);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
    throw new Error('Isolation artifacts must be outside the workspace');
  }
  await checkWorkspace(root);
  try {
    await lstat(path.join(root, '.codex'));
    throw new Error('Isolated fixtures may install .agents skills, but must not supply .codex runtime configuration');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const endpoint = new URL(modelEndpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/v1/responses'
    || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'))) {
    throw new Error('Model endpoint must be HTTPS /v1/responses (HTTP loopback is permitted for offline tests)');
  }
  if (!apiKey) throw new Error('Docker Codex isolation requires an explicit API key; personal login state is never mounted');
  const { stdout: docker } = await execute('/usr/bin/which', ['docker'], { env: dockerEnv });
  await execute(docker.trim(), ['info', '--format', '{{.OSType}}'], { env: dockerEnv, timeout: 10000 });
  const state = path.join(artifacts, `codex-boundary-${randomUUID()}`);
  await mkdir(state, { mode: 0o700 });
  const relayDir = path.join(state, 'relay');
  await mkdir(relayDir, { mode: 0o700 });
  let image;
  let server;
  let manifest;
  const owner = ownerFor(artifacts);
  const nonce = randomUUID();
  const containerName = `eval-codex-${randomUUID()}`;
  let cleanupPromise;
  const onTermination = () => { void cleanup().finally(() => process.exit(143)); };
  const cleanup = () => cleanupPromise ??= (async () => {
    process.removeListener('SIGTERM', onTermination);
    process.removeListener('SIGINT', onTermination);
    if (manifest) {
      try { await execute(manifest.docker, ['rm', '-f', manifest.containerName], { env: dockerEnv, timeout: 10000 }); } catch { /* Image cleanup below detects remaining containers. */ }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (image) await execute(docker.trim(), ['image', 'rm', image], { env: dockerEnv, timeout: 10000 });
    await rm(state, { recursive: true, force: true });
  })();
  process.once('SIGTERM', onTermination);
  process.once('SIGINT', onTermination);
  try {
    await writeFile(path.join(state, 'resources.json'), JSON.stringify({ owner, nonce, containerName }), { mode: 0o600 });
    // An empty, locally imported image has no inherited files, accounts, or entrypoint.
    image = execFileSync(docker.trim(), ['import',
      '--change', `LABEL eval.codex.boundary=${nonce}`,
      '--change', `LABEL eval.codex.owner=${owner}`, '-'], {
      input: Buffer.alloc(10240), encoding: 'utf8', env: dockerEnv, timeout: 30000,
    }).trim();
    const mounts = [
      ...await binaryMounts(process.execPath, '/runtime/node'),
      { source: await realpath(executable), target: '/runtime/codex' },
      { source: path.join(here, 'codex-inside.mjs'), target: '/runtime/inside.mjs' },
      { source: root, target: root },
      { source: relayDir, target: '/relay' },
    ];
    for (const tool of ['/bin/sh', '/bin/bash', '/bin/cat', '/bin/ls', '/usr/bin/grep', '/usr/bin/find']) {
      mounts.push(...await binaryMounts(tool, tool));
    }
    for (const [source, target] of [
      [path.join(path.dirname(executable), '../codex-path/rg'), '/runtime/bin/rg'],
      [path.join(path.dirname(executable), 'codex-code-mode-host'), '/runtime/codex-code-mode-host'],
    ]) {
      try { mounts.push({ source: await realpath(source), target }); } catch { /* Optional CLI companion. */ }
    }
    // Codex distributes a static binary, but alternate installations may use shared libraries.
    try { mounts.push(...(await binaryMounts(executable, '/runtime/codex')).slice(1)); } catch { /* Static executable. */ }
    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/__boundary-health') {
        response.end('isolated-model-relay'); return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(403); response.end('Model relay permits only POST /v1/responses'); return;
      }
      const upstream = (endpoint.protocol === 'https:' ? https.request : undefined);
      const options = {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: ['Bearer', apiKey].join(' ') },
        timeout: 180000,
      };
      const forward = (requestFunction) => {
        const outgoing = requestFunction(endpoint, options, (incoming) => {
          response.writeHead(incoming.statusCode, { 'content-type': incoming.headers['content-type'] ?? 'application/json' });
          incoming.pipe(response);
        });
        server.on('connect', (_request, socket) => {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        });
        outgoing.on('timeout', () => outgoing.destroy());
        outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        request.pipe(outgoing);
        response.on('close', () => outgoing.destroy());
      };
      if (upstream) forward(upstream);
      else import('node:http').then(({ request: send }) => forward(send));
    });
    const directory = await open(relayDir, 'r');
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Linux sun_path is short; the directory fd avoids truncating deep artifact paths.
        server.listen(`/proc/self/fd/${directory.fd}/model.sock`, resolve);
      });
    } finally { await directory.close(); }
    manifest = {
      docker: docker.trim(), dockerEnv, image, uid: process.getuid(), gid: process.getgid(),
      workspace: root, owner, nonce, containerName,
      mounts: [...new Map(mounts.map((mount) => [mount.target, mount])).values()],
      events: path.join(state, 'launches.jsonl'),
    };
    if (manifest.mounts.some(({ source, target }) => /[,\r\n]/.test(source + target))) {
      throw new Error('Docker bind paths must not contain mount delimiters');
    }
    const manifestPath = path.join(state, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const wrapper = path.join(state, 'codex');
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(here, 'codex-launcher.mjs'))} ${quote(manifestPath)} "$@"\n`, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const run = (code, { timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
        reject(new Error('Codex probe deadline must be finite and at most 30000ms')); return;
      }
      const child = startContainer(manifest, '/runtime/node', ['--input-type=module', '-e', code]);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        execute(manifest.docker, ['rm', '-f', manifest.containerName], { env: dockerEnv, timeout: 10000 })
          .then(() => reject(new Error('Codex isolation probe deadline exceeded')), reject);
      }, timeoutMs);
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (status) => {
        clearTimeout(timer);
        if (!timedOut) status === 0 ? resolve(stdout) : reject(new Error(`Isolation probe failed (${status}): ${stderr}`));
      });
      child.stdin.end();
    });
    return {
      wrapper, run, cleanup, manifest,
      async evidence() {
        let events = [];
        try { events = (await readFile(manifest.events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); } catch { /* No successful native launch evidence. */ }
        return {
          kind: 'docker-native-codex', configured: true, network: 'none-with-model-only-unix-relay',
          filesystem: 'empty-root-explicit-readonly-mounts', freshHome: true,
          nativeLaunches: events.filter((event) => event.nonce === manifest.nonce && event.kind === 'docker-codex-exit' && event.code === 0 && event.nativeExec === true).length,
        };
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function probeCodexIsolation(boundary, forbiddenPath) {
  await readFile(forbiddenPath);
  const result = JSON.parse(await boundary.run(`
    import fs from 'node:fs';
    import net from 'node:net';
    import http from 'node:http';
    import os from 'node:os';
    const denied = (operation) => { try { operation(); return false; } catch { return true; } };
    const readDenied = denied(() => fs.readFileSync(${JSON.stringify(forbiddenPath)}));
    const writeDenied = denied(() => fs.writeFileSync(${JSON.stringify(path.join(boundary.manifest.workspace, '.isolation-write-probe'))}, 'must-not-write'));
    const hostWriteDenied = denied(() => fs.writeFileSync(${JSON.stringify(forbiddenPath)}, 'must-not-write'));
    const networkDenied = await new Promise(resolve => {
      const socket = net.connect({host: '1.1.1.1', port: 443});
      socket.setTimeout(1500, () => {socket.destroy(); resolve(true);});
      socket.on('connect', () => {socket.destroy(); resolve(false);});
      socket.on('error', () => resolve(true));
    });
    const networkNamespaceOnlyLoopback = Object.values(os.networkInterfaces()).flat().every(address => address.internal);
    const relay = (method, url) => new Promise((resolve, reject) => {
      const req = http.request({socketPath:'/relay/model.sock', method, path:url}, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    const relayReachable = await relay('GET', '/__boundary-health') === 200;
    const relayDeniesOtherPaths = await relay('POST', '/v1/files') === 403
      && await relay('GET', '/v1/responses') === 403;
    console.log(JSON.stringify({readDenied, writeDenied, hostWriteDenied, networkDenied, networkNamespaceOnlyLoopback, relayReachable, relayDeniesOtherPaths}));
  `));
  return { ...result, verified: Object.values(result).every((value) => value === true) };
}
