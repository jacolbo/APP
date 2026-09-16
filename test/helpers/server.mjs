// Starts a throwaway Pose Board instance on a free port with its own data
// directory, so tests never touch your real library.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startServer({ password = 'test-password', env = {} } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: password, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  let exited = false;
  child.on('exit', () => { exited = true; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (exited) throw new Error(`The server exited before it was ready:\n${output}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`The server did not start in time:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return {
    base,
    password,
    dataDir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => (exited ? resolve() : child.on('exit', resolve)));
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}
