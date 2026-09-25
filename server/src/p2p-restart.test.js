import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { chainFilePath } from './chain-storage.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

it('preserves simultaneous reads and offline reads across real process restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bcu-p2p-restart-'));
  const children = [];
  const database = join(directory, 'journal.db');
  try {
    const ports = [await freePort(), await freePort()];
    const cookies = [];
    const url = (index, path) => `http://127.0.0.1:${ports[index]}${path}`;
    async function start(index) {
      const env = join(directory, `${index}.env`);
      writeFileSync(env, [`PORT=${ports[index]}`, `NODE_ID=node-${index}`,
        `PEER_URL=http://127.0.0.1:${ports[1 - index]}`,
        `DB_PATH=${database.replaceAll('\\', '/')}`, 'JWT_SECRET=restart-test',
        'PEER_SECRET=restart-peer-test'].join('\n'));
      const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), '--env', env], { windowsHide: true });
      const closed = once(child, 'close');
      const instance = { child, closed, output: '' };
      children.push(instance);
      child.stdout.on('data', (chunk) => { instance.output += chunk; });
      child.stderr.on('data', (chunk) => { instance.output += chunk; });
      await vi.waitFor(async () => expect((await fetch(url(index, '/api/health'))).status).toBe(200), { timeout: 10000 });
      const login = await fetch(url(index, '/api/auth/login'), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doctor1', password: 'demo1234' }) });
      expect(login.status).toBe(200);
      cookies[index] = login.headers.get('set-cookie').split(';')[0];
      return instance;
    }
    async function read(index) {
      const response = await fetch(url(index, '/api/patients/1'), { headers: { Cookie: cookies[index] } });
      expect(response.status).toBe(200);
    }
    async function entries(index) {
      const response = await fetch(url(index, '/api/patients/1/access-log'), { headers: { Cookie: cookies[index] } });
      expect(response.status).toBe(200);
      return response.json();
    }
    async function bothHave(ids) {
      await vi.waitFor(async () => {
        for (const index of [0, 1]) {
          const list = await entries(index);
          expect(list.map((entry) => entry.id).sort()).toEqual(ids);
          expect(list.every((entry) => entry.verified)).toBe(true);
        }
      }, { timeout: 10000 });
    }
    const a = await start(0);
    const b = await start(1);
    await Promise.all([read(0), read(1)]);
    await bothHave(['node-0-1', 'node-1-1']);
    const firstB = JSON.parse(readFileSync(chainFilePath(database, 'node-1'), 'utf8'));
    b.child.kill();
    await b.closed;
    await read(0);
    const restartedB = await start(1);
    await bothHave(['node-0-1', 'node-0-2', 'node-1-1']);
    expect(JSON.parse(readFileSync(chainFilePath(database, 'node-1'), 'utf8'))).toEqual(firstB);
    await read(1);
    await bothHave(['node-0-1', 'node-0-2', 'node-1-1', 'node-1-2']);
    const nextB = JSON.parse(readFileSync(chainFilePath(database, 'node-1'), 'utf8'));
    expect(nextB[2].prevHash).toBe(firstB[1].hash);
    a.child.kill();
    await a.closed;
    await read(1);
    await start(0);
    await bothHave(['node-0-1', 'node-0-2', 'node-1-1', 'node-1-2', 'node-1-3']);
    expect(restartedB.output).not.toContain('could not log');
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(({ closed }) => closed));
    rmSync(directory, { recursive: true, force: true });
  }
}, 45000);
