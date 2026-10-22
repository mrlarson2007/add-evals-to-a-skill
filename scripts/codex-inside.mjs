import http from 'node:http';
import { spawn } from 'node:child_process';

// The container has no external network; only this fixed Unix-socket relay exists.
const server = http.createServer((request, response) => {
  const forwarded = http.request({
    socketPath: '/relay/model.sock', path: request.url, method: request.method,
    headers: { 'content-type': 'application/json' },
  }, (upstream) => {
    response.writeHead(upstream.statusCode, { 'content-type': upstream.headers['content-type'] ?? 'application/json' });
    upstream.pipe(response);
  });
  forwarded.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(forwarded);
  response.on('close', () => forwarded.destroy());
});

server.listen(43127, '127.0.0.1', () => {
  const child = spawn('/runtime/codex', process.argv.slice(2), {
    env: process.env, stdio: 'inherit',
  });
  // A deadline may SIGKILL the host worker. Docker children are not in its
  // process group, so PID 1 must also stop when the host-owned relay disappears.
  const watchdog = setInterval(() => {
    const check = http.get({ socketPath: '/relay/model.sock', path: '/__boundary-health', timeout: 2000 }, (response) => {
      response.resume();
      if (response.statusCode !== 200) process.exit(1);
    });
    check.on('timeout', () => check.destroy());
    check.on('error', () => process.exit(1));
  }, 1000);
  watchdog.unref();
  const finish = (code) => { clearInterval(watchdog); server.close(); process.exitCode = code; };
  child.on('error', () => finish(1));
  child.on('exit', (code) => finish(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
});
