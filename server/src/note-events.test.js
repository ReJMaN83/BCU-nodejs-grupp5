import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { createPeer } from './peer.js';
import { createNoteEvents } from './note-events.js';

it('delivers saved notes from A to authorized browser sockets on B only', async () => {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8'));
  const peers = [];
  const clients = [];
  const secret = 'test-only-cookie-secret';
  try {
    const authenticate = (request) => {
      try {
        const token = request.headers.cookie?.replace(/^token=/, '');
        const claims = jwt.verify(token, secret);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(claims.sub);
      } catch { return null; }
    };
    async function node(nodeId, peerUrl) {
      const server = createServer((req, res) => res.end('ok'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      const notes = createNoteEvents({ nodeId, db, authenticate });
      const logger = { log: vi.fn(), warn: vi.fn() };
      const peer = createPeer(server, { nodeId, url, peerUrl, getChainLength: () => 1,
        peerSecret: 'peer-test-secret', attachClients: notes.attach, receiveNote: notes.receive, logger });
      notes.setBroadcaster(peer.broadcastNote);
      peers.push(peer);
      return { url, notes, logger };
    }
    const a = await node('node-a');
    const b = await node('node-b', a.url);
    await vi.waitFor(() => expect(a.logger.log).toHaveBeenCalledWith(expect.stringContaining('peer:hello from node-b')));
    async function browser(userId) {
      const cookie = `token=${jwt.sign({ sub: userId }, secret)}`;
      const client = io(b.url, { autoConnect: false, extraHeaders: { Cookie: cookie } });
      clients.push(client);
      const connected = once(client, 'connect');
      client.connect();
      await connected;
      const received = [];
      client.on('note:created', (payload) => received.push(payload));
      return { client, received };
    }
    const doctor = await browser(1);
    const nurse = await browser(2);
    const patient = await browser(4);
    const denied = await browser(5);
    const join = (client, id) => client.timeout(2000).emitWithAck('join-patient-room', id);
    for (const viewer of [doctor, nurse, patient]) expect(await join(viewer.client, '1')).toEqual({ ok: true, patientId: 1 });
    expect(await join(denied.client, 1)).toEqual({ ok: false, status: 403 });
    expect(await join(patient.client, 2)).toEqual({ ok: false, status: 403 });
    expect(await join(doctor.client, 'p1')).toEqual({ ok: false, status: 400 });

    // Simulate the backend's committed insert; no production write endpoint is added.
    const insert = db.prepare('INSERT INTO notes (patient_id, author_id, text, visibility) VALUES (1, 1, ?, ?)');
    const allId = Number(insert.run('Everyone note', 'everyone').lastInsertRowid);
    const staffId = Number(insert.run('Staff note', 'staff').lastInsertRowid);
    const privateId = Number(insert.run('Private note', 'private').lastInsertRowid);
    for (const id of [allId, staffId, privateId]) a.notes.publish(id);
    await vi.waitFor(() => expect(doctor.received).toHaveLength(3));
    for (const viewer of [nurse, patient, denied]) await join(viewer.client, 1);
    expect(nurse.received.map((p) => p.note.id)).toEqual([allId, staffId]);
    expect(patient.received.map((p) => p.note.id)).toEqual([allId]);
    expect(denied.received).toEqual([]);
    expect(doctor.received.every((p) => p.originNodeId === 'node-a')).toBe(true);

    // A duplicate local publish does not forward twice. Revoked roles are rechecked.
    a.notes.publish(allId);
    db.prepare("UPDATE users SET role = 'unauthorized' WHERE id = 2").run();
    const laterId = Number(insert.run('Later staff note', 'staff').lastInsertRowid);
    a.notes.publish(laterId);
    await vi.waitFor(() => expect(doctor.received).toHaveLength(4));
    await join(nurse.client, 1);
    await join(patient.client, 1);
    expect(nurse.received).toHaveLength(2);
    expect(patient.received).toHaveLength(1);

    const stranger = io(b.url, { autoConnect: false, reconnection: false });
    clients.push(stranger);
    const error = once(stranger, 'connect_error');
    stranger.connect();
    expect((await error)[0].message).toBe('Not authenticated');
    const fakePeer = io(`${b.url}/peers`, { autoConnect: false, reconnection: false });
    clients.push(fakePeer);
    const peerError = once(fakePeer, 'connect_error');
    fakePeer.connect();
    expect((await peerError)[0].message).toBe('Peer authentication required');
  } finally {
    clients.forEach((client) => client.disconnect());
    await Promise.all(peers.map((peer) => peer.close()));
    db.close();
  }
}, 15000);
