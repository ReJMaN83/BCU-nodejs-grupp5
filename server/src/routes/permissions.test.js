import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Tester för behörighetsmatrisen i docs/permissions.md (#27). Anteckningarnas
// skapande och synlighet testas redan i notes.test.js.

// config.js läser env-filen när modulen laddas, så testet pekar ut en egen fil
// med en tillfällig databas innan appen importeras.
const directory = mkdtempSync(join(tmpdir(), 'bcu-permissions-'));
const envFile = join(directory, '.env.test');
writeFileSync(envFile, [
  'PORT=3997',
  'NODE_ID=node-permissions',
  `DB_PATH=${join(directory, 'journal.db').replaceAll('\\', '/')}`,
  'JWT_SECRET=test-secret',
].join('\n'));
process.argv.push('--env', envFile);

const { createApp } = await import('../app.js');
const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { chain } = await import('../chain.js');

const PASSWORD = 'demo1234';
const OWN_PATIENT = 1;
const OTHER_PATIENT = 2;
const STAFF = ['doctor1', 'nurse1', 'clinic1'];

// Seed-kontona i docs/database.sql.
const ACCOUNTS = [
  { username: 'doctor1', id: 1, role: 'doctor', displayName: 'Dr. Lindberg', linkedPatientId: null },
  { username: 'nurse1', id: 2, role: 'nurse', displayName: 'Nurse Åström', linkedPatientId: null },
  { username: 'clinic1', id: 3, role: 'clinic', displayName: 'Vårdcentralen Centrum', linkedPatientId: null },
  { username: 'patient1', id: 4, role: 'patient', linkedPatientId: OWN_PATIENT },
  { username: 'unauthorized1', id: 5, role: 'unauthorized', linkedPatientId: null },
];

let server;
let baseUrl;
const cookies = {};

function request(path, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const as = (username, path, options = {}) => request(path, { ...options, cookie: cookies[username] });

function login(username, password = PASSWORD) {
  return request('/api/auth/login', { method: 'POST', body: { username, password } });
}

function patientEndpoints(patientId) {
  return [
    ['GET', `/api/patients/${patientId}`],
    ['POST', `/api/patients/${patientId}/notes`, { text: 'Permission test', visibility: 'everyone' }],
    ['GET', `/api/patients/${patientId}/access-log`],
  ];
}

const PROTECTED = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/patients?search='],
  ...patientEndpoints(OWN_PATIENT),
];

const chainLength = () => chain.blockchain.chain.length;
const lastBlock = () => chain.blockchain.chain.at(-1);

beforeAll(async () => {
  server = createApp(config).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  for (const { username } of ACCOUNTS) {
    const res = await login(username);
    expect(res.status).toBe(200);
    cookies[username] = res.headers.get('set-cookie').split(';')[0];
  }
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('login, me and logout', () => {
  it.each(ACCOUNTS)('logs in $username and /me returns the same user and role', async (account) => {
    const { username, ...expected } = account;

    const res = await login(username);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(expected);
    expect(res.headers.get('set-cookie')).toMatch(/^token=[^;]+;.*HttpOnly/i);

    const me = await as(username, '/api/auth/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject(expected);
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    const res = await login('doctor1', 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('clears the cookie on logout so /me gives 401 afterwards', async () => {
    const loggedIn = await login('nurse1');
    let cookie = loggedIn.headers.get('set-cookie').split(';')[0];
    expect((await request('/api/auth/me', { cookie })).status).toBe(200);

    const res = await request('/api/auth/logout', { method: 'POST', cookie });
    expect(res.status).toBe(204);
    // Webbläsaren ersätter cookien med värdet i Set-Cookie, som är tomt.
    const cleared = res.headers.get('set-cookie');
    expect(cleared).toMatch(/^token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
    cookie = cleared.split(';')[0];

    const me = await request('/api/auth/me', { cookie });
    expect(me.status).toBe(401);
  });

  it('allows logout without being logged in', async () => {
    expect((await request('/api/auth/logout', { method: 'POST' })).status).toBe(204);
  });
});

describe('401 without authentication', () => {
  it.each(PROTECTED)('%s %s without cookie', async (method, path, body) => {
    const res = await request(path, { method, body });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: 'Not authenticated' });
  });

  it.each(PROTECTED)('%s %s with an invalid token', async (method, path, body) => {
    const res = await request(path, { method, body, cookie: 'token=not-a-valid-jwt' });
    expect(res.status).toBe(401);
  });
});

describe('patient search', () => {
  it.each(STAFF)('lets %s search patients', async (username) => {
    const all = await as(username, '/api/patients?search=');
    expect(all.status).toBe(200);
    expect(await all.json()).toHaveLength(5);

    const res = await as(username, '/api/patients?search=anna');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: OWN_PATIENT, fullName: 'Anna Karlsson', personalId: '19850312-4521' },
    ]);
  });

  it.each(['patient1', 'unauthorized1'])('returns 403 to %s', async (username) => {
    const res = await as(username, '/api/patients?search=anna');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Forbidden' });
  });
});

describe('staff access to any patient', () => {
  it.each(STAFF)('lets %s read record and access log of patient 2', async (username) => {
    for (const path of [`/api/patients/${OTHER_PATIENT}`, `/api/patients/${OTHER_PATIENT}/access-log`]) {
      expect((await as(username, path)).status).toBe(200);
    }
  });
});

describe('patient1 and its own record', () => {
  it('can read its own record, notes and access log', async () => {
    const record = await as('patient1', `/api/patients/${OWN_PATIENT}`);
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({ id: OWN_PATIENT, fullName: 'Anna Karlsson', notes: expect.any(Array) });

    const log = await as('patient1', `/api/patients/${OWN_PATIENT}/access-log`);
    expect(log.status).toBe(200);
    expect(Array.isArray(await log.json())).toBe(true);
  });

  it('cannot create a note on its own record', async () => {
    const res = await as('patient1', `/api/patients/${OWN_PATIENT}/notes`, {
      method: 'POST', body: { text: 'Written by patient', visibility: 'everyone' },
    });
    expect(res.status).toBe(403);
  });

  it.each(patientEndpoints(OTHER_PATIENT))('gets 403 on %s %s', async (method, path, body) => {
    const res = await as('patient1', path, { method, body });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Forbidden' });
  });

  it('gets 403, not 404, for a patient that does not exist', async () => {
    // Matrisen: 404 bara efter behörighetskontrollen, så en nekad användare
    // får inte veta om patienten finns.
    expect((await as('patient1', '/api/patients/999')).status).toBe(403);
  });
});

describe('unauthorized1', () => {
  it.each([
    ['GET', '/api/patients?search='],
    ...patientEndpoints(OWN_PATIENT),
    ...patientEndpoints(OTHER_PATIENT),
    ['GET', '/api/patients/999'],
  ])('gets 403 on %s %s', async (method, path, body) => {
    const res = await as('unauthorized1', path, { method, body });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Forbidden' });
  });
});

describe('access blocks', () => {
  it.each([...STAFF, 'patient1'])('search and access log create no block for %s', async (username) => {
    const before = chainLength();
    const paths = [`/api/patients/${OWN_PATIENT}/access-log`];
    if (username !== 'patient1') paths.push('/api/patients?search=', '/api/patients?search=anna');

    for (const path of paths) {
      expect((await as(username, path)).status).toBe(200);
    }
    expect(chainLength()).toBe(before);
  });

  it.each([...STAFF, 'patient1'])('a record read by %s creates exactly one read block', async (username) => {
    const { id, role } = ACCOUNTS.find((account) => account.username === username);
    const before = chainLength();

    const res = await as(username, `/api/patients/${OWN_PATIENT}`);
    expect(res.status).toBe(200);
    expect(chainLength()).toBe(before + 1);
    expect(lastBlock().data).toMatchObject({ userId: id, role, patientId: OWN_PATIENT, action: 'read' });
  });
});
