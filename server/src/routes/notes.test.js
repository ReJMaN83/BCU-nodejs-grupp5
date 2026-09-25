import cookieParser from 'cookie-parser';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// config.js läser env-filen när modulen laddas, så testet pekar ut en egen fil
// med en tillfällig databas innan appen importeras.
const directory = mkdtempSync(join(tmpdir(), 'bcu-notes-'));
const envFile = join(directory, '.env.test');
writeFileSync(envFile, [
  'PORT=3999',
  'NODE_ID=node-test',
  `DB_PATH=${join(directory, 'journal.db').replaceAll('\\', '/')}`,
  'JWT_SECRET=test-secret',
].join('\n'));
process.argv.push('--env', envFile);

const { createApp } = await import('../app.js');
const { config } = await import('../config.js');
const { db } = await import('../db.js');
const { userFromRequest } = await import('../auth.js');
const { createNoteEvents } = await import('../note-events.js');
const { setNotePublisher } = await import('../notes-live.js');
const { createPeer } = await import('../peer.js');

const PASSWORD = 'demo1234';
const PATIENT_ID = 1;
let server;
let peer;
let notesPublish;
let baseUrl;
const sockets = [];
const cookies = {};

async function login(username) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie').split(';')[0];
}

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

function postNote(as, body, patientId = PATIENT_ID) {
  return request(`/api/patients/${patientId}/notes`, { as, method: 'POST', body });
}

async function writeBlocks() {
  const res = await request(`/api/patients/${PATIENT_ID}/access-log`, { as: 'doctor1' });
  return (await res.json()).filter((entry) => entry.action === 'write');
}

beforeAll(async () => {
  server = createApp(config).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  // Samma koppling som i index.js, utan peer (ingen PEER_URL eller PEER_SECRET).
  const parseCookies = cookieParser();
  const notes = createNoteEvents({ nodeId: config.nodeId, db, authenticate: (request) => {
    parseCookies(request, {}, () => {});
    return userFromRequest(request);
  } });
  peer = createPeer(server, {
    nodeId: config.nodeId, url: baseUrl, getChainLength: () => 1,
    attachClients: notes.attach, logger: { log() {}, warn() {} },
  });
  notes.setBroadcaster(peer.broadcastNote);
  notesPublish = notes.publish;
  setNotePublisher(notesPublish);

  for (const username of ['doctor1', 'nurse1', 'clinic1', 'patient1', 'unauthorized1']) {
    cookies[username] = await login(username);
  }
});

afterAll(async () => {
  sockets.forEach((socket) => socket.disconnect());
  // Socket.IO stänger även HTTP-servern.
  await peer.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('POST /api/patients/:id/notes', () => {
  it.each([
    ['doctor1', 'doctor', 'Dr. Lindberg'],
    ['nurse1', 'nurse', 'Nurse Åström'],
    ['clinic1', 'clinic', 'Vårdcentralen Centrum'],
  ])('lets %s write a note and returns it in the GET format', async (username, role, name) => {
    const res = await postNote(username, { text: `  Note by ${role}  `, visibility: 'staff' });

    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note).toEqual({
      id: expect.any(Number),
      patientId: PATIENT_ID,
      authorId: expect.any(Number),
      authorName: name,
      authorRole: role,
      text: `Note by ${role}`,
      visibility: 'staff',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });

    const list = await (await request(`/api/patients/${PATIENT_ID}/notes`, { as: username })).json();
    expect(list).toContainEqual(note);
  });

  it.each(['patient1', 'unauthorized1'])('returns 403 for %s', async (username) => {
    const res = await postNote(username, { text: 'Not allowed', visibility: 'everyone' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Forbidden' });
  });

  it('returns 401 without login', async () => {
    const res = await postNote(undefined, { text: 'Anonymous', visibility: 'everyone' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['missing text', { visibility: 'staff' }],
    ['empty text', { text: '', visibility: 'staff' }],
    ['whitespace text', { text: '   ', visibility: 'staff' }],
    ['non-string text', { text: 42, visibility: 'staff' }],
    ['missing visibility', { text: 'Hello' }],
    ['unknown visibility', { text: 'Hello', visibility: 'public' }],
  ])('returns 400 for %s', async (_, body) => {
    const res = await postNote('doctor1', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('message');
  });

  it('returns 404 for an unknown patient', async () => {
    const res = await postNote('doctor1', { text: 'Hello', visibility: 'staff' }, 999);
    expect(res.status).toBe(404);
  });

  it('creates one signed write block per saved note and none for rejected requests', async () => {
    const before = (await writeBlocks()).length;

    await postNote('patient1', { text: 'Rejected', visibility: 'everyone' });
    await postNote('doctor1', { text: '', visibility: 'staff' });
    expect(await writeBlocks()).toHaveLength(before);

    const res = await postNote('nurse1', { text: 'Logged', visibility: 'staff' });
    expect(res.status).toBe(201);

    const blocks = await writeBlocks();
    expect(blocks).toHaveLength(before + 1);
    expect(blocks[0]).toMatchObject({
      userId: 2,
      role: 'nurse',
      action: 'write',
      nodeId: 'node-test',
      verified: true,
    });
  });
});

describe('visibility of new notes', () => {
  const created = {};

  beforeAll(async () => {
    for (const visibility of ['private', 'staff', 'everyone']) {
      const res = await postNote('doctor1', { text: `Visibility ${visibility}`, visibility });
      expect(res.status).toBe(201);
      created[visibility] = (await res.json()).id;
    }
  });

  async function visibleNewNotes(username) {
    const res = await request(`/api/patients/${PATIENT_ID}`, { as: username });
    expect(res.status).toBe(200);
    const ids = Object.values(created);
    return (await res.json()).notes
      .filter((note) => ids.includes(note.id))
      .map((note) => note.visibility)
      .sort();
  }

  it('shows all three to the author', async () => {
    expect(await visibleNewNotes('doctor1')).toEqual(['everyone', 'private', 'staff']);
  });

  it.each(['nurse1', 'clinic1'])('shows staff and everyone to %s', async (username) => {
    expect(await visibleNewNotes(username)).toEqual(['everyone', 'staff']);
  });

  it('shows only the everyone note to the patient', async () => {
    expect(await visibleNewNotes('patient1')).toEqual(['everyone']);
  });
});

describe('note:created after POST', () => {
  async function joinedSocket(username, patientId) {
    const socket = io(baseUrl, {
      autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookies[username] },
    });
    sockets.push(socket);
    const connected = once(socket, 'connect');
    socket.connect();
    await connected;
    const ack = await socket.timeout(2000).emitWithAck('join-patient-room', patientId);
    expect(ack).toEqual({ ok: true, patientId });
    return socket;
  }

  it('reaches a socket in patient:1 when doctor1 posts', async () => {
    const socket = await joinedSocket('nurse1', PATIENT_ID);
    const received = once(socket, 'note:created');

    const res = await postNote('doctor1', { text: 'Live note', visibility: 'staff' });
    expect(res.status).toBe(201);
    const note = await res.json();

    const [payload] = await received;
    expect(payload).toEqual({ originNodeId: 'node-test', note });
  });

  it('does not send the note to a socket in another patient room', async () => {
    const other = await joinedSocket('doctor1', 2);
    const same = await joinedSocket('doctor1', PATIENT_ID);
    const got = [];
    other.on('note:created', (payload) => got.push(payload));
    const received = once(same, 'note:created');

    expect((await postNote('doctor1', { text: 'Only room 1', visibility: 'everyone' })).status).toBe(201);
    await received;
    expect(got).toEqual([]);
  });

  it('still returns 201 and keeps the note when live delivery fails', async () => {
    setNotePublisher(() => { throw new Error('socket down'); });
    try {
      const res = await postNote('doctor1', { text: 'Saved anyway', visibility: 'staff' });
      expect(res.status).toBe(201);
      const note = await res.json();
      const list = await (await request(`/api/patients/${PATIENT_ID}/notes`, { as: 'doctor1' })).json();
      expect(list).toContainEqual(note);
    } finally {
      setNotePublisher(notesPublish);
    }
  });
});
