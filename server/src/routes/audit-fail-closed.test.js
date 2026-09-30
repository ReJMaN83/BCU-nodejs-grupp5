import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// recordAccess och publishCreatedNote byts mot spioner som anropar den riktiga
// koden, så varje test kan låta dem kasta eller kontrollera antal anrop.
vi.mock('../audit-logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAccess: vi.fn(actual.recordAccess) };
});
vi.mock('../notes-live.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, publishCreatedNote: vi.fn() };
});

// config.js läser env-filen när modulen laddas, så testet pekar ut en egen fil
// med en tillfällig databas innan appen importeras.
const directory = mkdtempSync(join(tmpdir(), 'bcu-audit-'));
const envFile = join(directory, '.env.test');
writeFileSync(envFile, [
  'PORT=3998',
  'NODE_ID=node-audit',
  `DB_PATH=${join(directory, 'journal.db').replaceAll('\\', '/')}`,
  'JWT_SECRET=test-secret',
].join('\n'));
process.argv.push('--env', envFile);

const { createApp } = await import('../app.js');
const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { chain } = await import('../chain.js');
const { recordAccess } = await import('../audit-logger.js');
const { publishCreatedNote } = await import('../notes-live.js');

const PATIENT_ID = 1;
let server;
let baseUrl;
let consoleError;
const cookies = {};

function request(path, { as, method = 'GET', body } = {}) {
  const headers = {};
  if (as) headers.Cookie = cookies[as];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const chainLength = () => chain.blockchain.chain.length;
const countNotes = () => db.prepare('SELECT count(*) AS count FROM notes').get().count;

beforeAll(async () => {
  server = createApp(config).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  for (const username of ['doctor1', 'patient1']) {
    const res = await request('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'demo1234' },
    });
    expect(res.status).toBe(200);
    cookies[username] = res.headers.get('set-cookie').split(';')[0];
  }
});

afterEach(() => {
  vi.mocked(recordAccess).mockClear();
  vi.mocked(publishCreatedNote).mockClear();
  consoleError?.mockRestore();
  consoleError = undefined;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GET /api/patients/:id', () => {
  it('returns 503 without journal data when the read cannot be logged', async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordAccess).mockImplementationOnce(() => { throw new Error('signing failed'); });
    const before = chainLength();

    const res = await request(`/api/patients/${PATIENT_ID}`, { as: 'doctor1' });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ message: 'Access could not be logged' });
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('personalId');
    expect(chainLength()).toBe(before);
    expect(consoleError).toHaveBeenCalled();
  });

  it('writes the read block before the journal is sent', async () => {
    const events = [];
    const actual = vi.mocked(recordAccess).getMockImplementation();
    // Fördröjd loggning: skickades svaret före loggningen skulle 'response'
    // hamna först.
    vi.mocked(recordAccess).mockImplementationOnce(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const block = actual(event);
      events.push('block');
      return block;
    });
    const before = chainLength();

    const res = await request(`/api/patients/${PATIENT_ID}`, { as: 'doctor1' });
    events.push('response');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PATIENT_ID, notes: expect.any(Array) });
    expect(events).toEqual(['block', 'response']);
    expect(chainLength()).toBe(before + 1);
    expect(chain.blockchain.chain.at(-1).data).toMatchObject({
      userId: 1, role: 'doctor', patientId: PATIENT_ID, action: 'read',
    });
  });

  it('does not log denied or unknown reads', async () => {
    const before = chainLength();
    expect((await request(`/api/patients/${PATIENT_ID}`)).status).toBe(401);
    expect((await request('/api/patients/2', { as: 'patient1' })).status).toBe(403);
    expect((await request('/api/patients/999', { as: 'doctor1' })).status).toBe(404);
    expect(recordAccess).not.toHaveBeenCalled();
    expect(chainLength()).toBe(before);
  });
});

describe('POST /api/patients/:id/notes', () => {
  const note = { text: 'Audit test', visibility: 'staff' };

  it('returns 503, removes the note and does not publish when the write cannot be logged', async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordAccess).mockImplementationOnce(() => { throw new Error('chain storage failed'); });
    const blocksBefore = chainLength();
    const notesBefore = countNotes();

    const res = await request(`/api/patients/${PATIENT_ID}/notes`, { as: 'doctor1', method: 'POST', body: note });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message: 'Access could not be logged' });
    expect(countNotes()).toBe(notesBefore);
    expect(chainLength()).toBe(blocksBefore);
    expect(publishCreatedNote).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('publishes the note exactly once after the write block is stored', async () => {
    const blocksBefore = chainLength();

    const res = await request(`/api/patients/${PATIENT_ID}/notes`, { as: 'doctor1', method: 'POST', body: note });

    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(chainLength()).toBe(blocksBefore + 1);
    expect(chain.blockchain.chain.at(-1).data).toMatchObject({ action: 'write', patientId: PATIENT_ID });
    await vi.waitFor(() => expect(publishCreatedNote).toHaveBeenCalledTimes(1));
    expect(publishCreatedNote).toHaveBeenCalledWith(id);
    expect(vi.mocked(recordAccess).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(publishCreatedNote).mock.invocationCallOrder[0]);
  });
});
