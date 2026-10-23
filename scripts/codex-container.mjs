import { spawn } from 'node:child_process';

export function containerArgs(manifest, command, args = []) {
  return [
    'run', '--rm', '--interactive', '--pull=never', '--name', manifest.containerName,
    '--label', `eval.codex.owner=${manifest.owner}`,
    '--label', `eval.codex.boundary=${manifest.nonce}`,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g',
    '--user', `${manifest.uid}:${manifest.gid}`,
    '--tmpfs', `/home/codex:rw,nosuid,nodev,noexec,size=64m,uid=${manifest.uid},gid=${manifest.gid},mode=700`,
    '--tmpfs', `/scratch:rw,nosuid,nodev,noexec,size=32m,uid=${manifest.uid},gid=${manifest.gid},mode=700`,
    '--env', 'HOME=/home/codex', '--env', 'CODEX_HOME=/home/codex',
    '--env', 'TMPDIR=/scratch', '--env', 'PATH=/runtime/bin:/bin',
    '--env', 'OPENAI_BASE_URL=http://127.0.0.1:43127/v1',
    '--env', 'CODEX_API_KEY=isolated-relay', '--env', 'OPENAI_API_KEY=isolated-relay',
    ...manifest.mounts.flatMap(({ source, target }) => [
      '--mount', `type=bind,src=${source},dst=${target},readonly`,
    ]),
    '--workdir', manifest.workspace,
    '--entrypoint', command, manifest.image, ...args,
  ];
}

export function startContainer(manifest, command, args, options = {}) {
  return spawn(manifest.docker, containerArgs(manifest, command, args), {
    env: manifest.dockerEnv, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}
