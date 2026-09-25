import Database from 'better-sqlite3';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { calculateBlockHash } from './block.js';
import { createAccessSigner } from './access-signing.js';
import { createPeerChains } from './peer-chains.js';

const databases = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, public_key TEXT)');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  db.prepare('INSERT INTO users VALUES (1, ?, ?)').run('doctor', pem);
  const signer = createAccessSigner(db, 'unused-peer-test-keys');
  const store = createPeerChains('node-b', signer.verifyAccessEvent);
  const chain = new Blockchain('node-a');
  const timestamp = '2026-09-22T10:00:00.000Z';
  const event = { userId: 1, role: 'doctor', patientId: 1, action: 'read' };
  const signature = sign(null, Buffer.from(JSON.stringify({ ...event, timestamp })), privateKey).toString('base64');
  const block = chain.addBlock({ ...event, signature, publicKey: pem }, timestamp);
  return { store, chain, block, db };
}

it('stores a signed foreign block separately and ignores duplicates', () => {
  const { store, block } = fixture();
  const local = new Blockchain('node-b');
  const message = { nodeId: 'node-a', block };
  expect(store.receive(message, 'node-a')).toBe('accepted');
  expect(store.receive(message, 'node-a')).toBe('duplicate');
  expect(store.getChain('node-a')).toHaveLength(2);
  expect(local.chain).toHaveLength(1);
  block.data.patientId = 999;
  const snapshot = store.getChain('node-a');
  snapshot[1].data.patientId = 888;
  expect(store.getChain('node-a')[1].data.patientId).toBe(1);
});

it.each(['hash', 'prevHash', 'signature', 'key', 'sender', 'local', 'extra'])('rejects invalid %s without mutation', (kind) => {
  const { store, block } = fixture();
  const message = { nodeId: 'node-a', block };
  if (kind === 'hash') block.hash = 'bad';
  if (kind === 'prevHash') { block.prevHash = 'bad'; block.hash = calculateBlockHash(block); }
  if (kind === 'signature') { block.data.signature = Buffer.alloc(64).toString('base64'); block.hash = calculateBlockHash(block); }
  if (kind === 'key') { block.data.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }); block.hash = calculateBlockHash(block); }
  if (kind === 'local') message.nodeId = block.nodeId = 'node-b';
  if (kind === 'extra') block.secret = 'unexpected';
  expect(store.receive(message, kind === 'sender' ? 'wrong-node' : message.nodeId)).toBe('invalid');
  expect(store.getChain('node-a')).toEqual([]);
});

it('rejects missing history and conflicting duplicates while preserving accepted blocks', () => {
  const { store, chain, block } = fixture();
  const next = chain.addBlock(block.data, block.timestamp);
  expect(store.receive({ nodeId: 'node-a', block: next }, 'node-a')).toBe('missing-history');
  expect(store.receive({ nodeId: 'node-a', block }, 'node-a')).toBe('accepted');
  const bad = structuredClone(block);
  bad.hash = 'bad';
  expect(store.receive({ nodeId: 'node-a', block: bad }, 'node-a')).toBe('invalid');
  expect(store.receive({ nodeId: 'node-a', block: next }, 'node-a')).toBe('accepted');
  expect(store.getChain('node-a')).toHaveLength(3);
});

it('syncs complete signed history and ignores stale responses without losing newer blocks', () => {
  const { store, chain, block } = fixture();
  const first = structuredClone(chain.chain);
  chain.addBlock(block.data, block.timestamp);
  expect(store.receiveChain({ nodeId: 'node-a', chain: chain.chain }, 'node-a')).toBe('accepted');
  expect(store.receiveChain({ nodeId: 'node-a', chain: first }, 'node-a')).toBe('unchanged');
  expect(store.getChain('node-a')).toHaveLength(3);
  const snapshots = store.getChains();
  snapshots[0].pop();
  expect(store.getChain('node-a')).toHaveLength(3);
});

it('rejects conflicting, wrong-owner and invalidly signed chains atomically', () => {
  const { store, chain, block } = fixture();
  expect(store.receiveChain({ nodeId: 'node-a', chain: chain.chain }, 'node-a')).toBe('accepted');
  const original = store.getChain('node-a');
  expect(store.receiveChain({ nodeId: 'node-a', chain: chain.chain }, 'node-c')).toBe('invalid');
  const other = new Blockchain('node-a');
  const timestamp = '2026-09-22T10:00:01.000Z';
  other.addBlock(block.data, timestamp);
  expect(store.receiveChain({ nodeId: 'node-a', chain: other.chain }, 'node-a')).toBe('invalid');
  const conflictingStore = createPeerChains('node-b', () => true);
  conflictingStore.receiveChain({ nodeId: 'node-a', chain: chain.chain }, 'node-a');
  expect(conflictingStore.receiveChain({ nodeId: 'node-a', chain: other.chain }, 'node-a')).toBe('conflict');
  chain.addBlock(block.data, timestamp);
  expect(store.receiveChain({ nodeId: 'node-a', chain: chain.chain }, 'node-a')).toBe('invalid');
  expect(store.getChain('node-a')).toEqual(original);
});
