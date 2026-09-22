import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

it('broadcasts real signed audit blocks between two servers without echoing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bcu-broadcast-'));
  const children = [];
  try {
    const ports = [await freePort(), await freePort()];
    const logs = ['', ''];
    for (const [index, port] of ports.entries()) {
      const env = join(directory, `${index}.env`);
      writeFileSync(env, [
        `PORT=${port}`, `NODE_ID=node-${index}`, `PEER_URL=http://127.0.0.1:${ports[1 - index]}`,
        `DB_PATH=${join(directory, 'journal.db').replaceAll('\\', '/')}`,
        'JWT_SECRET=broadcast-test-only',
      ].join('\n'));
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('./index.js', import.meta.url)), '--env', env,
      ], { windowsHide: true });
      const closed = once(child, 'close');
      children.push({ child, closed });
      child.stdout.on('data', (chunk) => { logs[index] += chunk; });
      child.stderr.on('data', (chunk) => { logs[index] += chunk; });
      // Start sequentially so schema creation is finished before node two.
      await vi.waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        expect(response.status).toBe(200);
      }, { timeout: 10000 });
    }
    await vi.waitFor(() => {
      expect(logs[0]).toContain('peer:hello from node-1');
      expect(logs[1]).toContain('peer:hello from node-0');
    }, { timeout: 10000 });
    for (const [index, port] of ports.entries()) {
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'doctor1', password: 'demo1234' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const response = await fetch(`http://127.0.0.1:${port}/api/patients/1`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(logs[1 - index]).toContain(`block:new from node-${index}: accepted`);
      }, { timeout: 5000 });
    }
    for (const log of logs) {
      expect(log.match(/block:new .*: accepted/g)).toHaveLength(1);
      expect(log).not.toContain('block:new from node-0: invalid');
      expect(log).not.toContain('block:new from node-1: invalid');
    }
  } finally {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ closed }) => closed));
    rmSync(directory, { recursive: true, force: true });
  }
}, 40000);
