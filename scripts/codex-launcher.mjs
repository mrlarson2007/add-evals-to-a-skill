import { appendFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { startContainer } from './codex-container.mjs';

const [manifestPath, ...args] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (args.includes('resume')) throw new Error('Isolated Codex requires a fresh session');
const schemaIndex = args.indexOf('--output-schema');
if (schemaIndex >= 0) {
  const schema = await realpath(args[schemaIndex + 1]);
  const relative = path.relative(path.join(path.dirname(manifestPath), 'schemas'), schema);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Output schema must be staged in the private SDK schema directory');
  }
  manifest.mounts.push({ source: schema, target: '/runtime/output-schema.json' });
  args[schemaIndex + 1] = '/runtime/output-schema.json';
}
const child = startContainer(manifest, '/runtime/node', ['/runtime/inside.mjs', ...args], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 1; });
child.on('exit', async (code) => {
  await appendFile(manifest.events, `${JSON.stringify({
    kind: 'docker-codex-exit', nonce: manifest.nonce, code, nativeExec: args[0] === 'exec',
  })}\n`);
  process.exitCode = code ?? 1;
});
