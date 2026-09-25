import Database from 'better-sqlite3';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoteEvents } from './note-events.js';
import { publishCreatedNote, setNotePublisher } from './notes-live.js';
import { createPeer } from './peer.js';

const PEER_SECRET = 'peer-test-secret';
const peers = [];
const clients = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.disconnect());
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
});

async function start({ peerSecret, attachClients } = {}) {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const logger = { log: vi.fn(), warn: vi.fn() };
  const peer = createPeer(server, {
    nodeId: 'node-a', url, getChainLength: () => 1, logger, peerSecret, attachClients,
  });
  peers.push(peer);
  return { peer, url, logger };
}

// Ansluter till /peers och svarar med 'connected' eller felmeddelandet.
async function connectPeer(url, auth) {
  const client = io(`${url}/peers`, { autoConnect: false, reconnection: false, auth });
  clients.push(client);
  const result = Promise.race([
    once(client, 'connect').then(() => 'connected'),
    once(client, 'connect_error').then(([error]) => error.message),
  ]);
  client.connect();
  return result;
}

describe('/peers handshake', () => {
  it('rejects a peer without a secret', async () => {
    const node = await start({ peerSecret: PEER_SECRET });
    expect(await connectPeer(node.url, {})).toBe('Peer authentication required');
  });

  it('rejects a peer with the wrong secret', async () => {
    const node = await start({ peerSecret: PEER_SECRET });
    expect(await connectPeer(node.url, { peerSecret: 'wrong-secret' })).toBe('Peer authentication required');
    expect(await connectPeer(node.url, { peerSecret: `${PEER_SECRET}x` })).toBe('Peer authentication required');
    expect(await connectPeer(node.url, { peerSecret: 42 })).toBe('Peer authentication required');
  });

  it('accepts a peer with the right secret and exchanges hello', async () => {
    const node = await start({ peerSecret: PEER_SECRET });
    const client = io(`${node.url}/peers`, {
      autoConnect: false, reconnection: false, auth: { peerSecret: PEER_SECRET },
    });
    clients.push(client);
    const hello = once(client, 'peer:hello');
    client.connect();
    expect((await hello)[0]).toMatchObject({ nodeId: 'node-a' });
  });

  it('rejects every peer when the node has no PEER_SECRET', async () => {
    const node = await start();
    expect(await connectPeer(node.url, {})).toBe('Peer authentication required');
    expect(await connectPeer(node.url, { peerSecret: '' })).toBe('Peer authentication required');
    expect(await connectPeer(node.url, { peerSecret: PEER_SECRET })).toBe('Peer authentication required');
  });
});

describe('local note delivery without PEER_SECRET', () => {
  it('delivers note:created to a local client in the patient room', async () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8'));
    const cookieSecret = 'test-only-cookie-secret';
    const authenticate = (request) => {
      try {
        const token = request.headers.cookie?.replace(/^token=/, '');
        return db.prepare('SELECT * FROM users WHERE id = ?').get(jwt.verify(token, cookieSecret).sub);
      } catch {
        return null;
      }
    };
    try {
      const notes = createNoteEvents({ nodeId: 'node-a', db, authenticate });
      const node = await start({ attachClients: notes.attach });
      notes.setBroadcaster(node.peer.broadcastNote);
      setNotePublisher(notes.publish);

      const client = io(node.url, {
        autoConnect: false,
        reconnection: false,
        extraHeaders: { Cookie: `token=${jwt.sign({ sub: 1 }, cookieSecret)}` },
      });
      clients.push(client);
      const connected = once(client, 'connect');
      client.connect();
      await connected;
      expect(await client.timeout(2000).emitWithAck('join-patient-room', 1)).toEqual({ ok: true, patientId: 1 });

      const received = once(client, 'note:created');
      const { lastInsertRowid } = db
        .prepare("INSERT INTO notes (patient_id, author_id, text, visibility) VALUES (1, 1, 'Local only', 'staff')")
        .run();
      expect(() => publishCreatedNote(Number(lastInsertRowid))).not.toThrow();

      const [payload] = await received;
      expect(payload).toMatchObject({
        originNodeId: 'node-a',
        note: { id: Number(lastInsertRowid), patientId: 1, text: 'Local only', visibility: 'staff' },
      });
    } finally {
      db.close();
    }
  });
});
