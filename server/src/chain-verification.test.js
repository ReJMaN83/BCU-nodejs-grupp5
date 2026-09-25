import Database from 'better-sqlite3';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog } from './access-log.js';
import { createAccessSigner } from './access-signing.js';
import { Block, calculateBlockHash } from './block.js';
import { Blockchain, verifyChain } from './blockchain.js';

const schema = readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8');
const nodeId = 'test-verification-node';
const timestamp = '2026-09-18T09:15:02.1Z';
const event = { userId: 1, role: 'doctor', patientId: 2, action: 'read' };
const valid = { valid: true, position: null, reason: null };
let directory;
let keyDirectory;
let db;
let signing;
let accessLog;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bcu-chain-verification-'));
  keyDirectory = join(directory, 'test.keys');
  db = new Database(join(directory, 'test.db'));
  db.exec(schema);
  signing = createAccessSigner(db, keyDirectory);
  accessLog = createAccessLog(nodeId, db, keyDirectory);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function signedChain() {
  const blockchain = accessLog.blockchain;
  for (const input of [event, { ...event, userId: 2, role: 'nurse' }, { ...event, action: 'write' }]) {
    blockchain.addBlock(signing.signAccessEvent(input, timestamp), timestamp);
  }
  return blockchain.chain;
}

function copyChain() {
  return JSON.parse(JSON.stringify(signedChain()));
}

function rehashFrom(blocks, position) {
  for (let index = position; index < blocks.length; index += 1) {
    if (index > position) blocks[index].prevHash = blocks[index - 1].hash;
    blocks[index].hash = calculateBlockHash(blocks[index]);
  }
}

function expectInvalid(blocks, position, reason = expect.any(String)) {
  expect(accessLog.verifyChain(blocks)).toEqual({ valid: false, position, reason });
}

describe('verifyChain', () => {
  it('accepts genesis without signatures or key creation', () => {
    expect(accessLog.verifyChain()).toEqual(valid);
    expect(db.prepare('SELECT public_key FROM users').all().every((user) => user.public_key === null)).toBe(true);
    expect(existsSync(keyDirectory)).toBe(false);
  });

  it('accepts signed Block instances and JSON-read blocks with their original timestamps', () => {
    const blocks = signedChain();
    const parsed = JSON.parse(JSON.stringify(blocks));
    expect(blocks[1]).toBeInstanceOf(Block);
    expect(parsed[1]).not.toBeInstanceOf(Block);
    expect(accessLog.verifyChain()).toEqual(valid);
    expect(accessLog.verifyChain(parsed)).toEqual(valid);
    expect(verifyChain(parsed, nodeId, signing.verifyAccessEvent)).toEqual(valid);
    expect(parsed[1].timestamp).toBe(timestamp);
  });

  it('flags a hand-edited block in a JSON copy without altering the live chain (#31)', () => {
    accessLog.addAccessLog(event);
    const original = JSON.stringify(accessLog.blockchain.chain);
    const copy = JSON.parse(original);
    copy[1].data.patientId = 99;

    expectInvalid(copy, 1, 'Invalid block hash');
    expect(copy[1].hash).toBe(accessLog.blockchain.chain[1].hash);
    expect(JSON.stringify(accessLog.blockchain.chain)).toBe(original);
    expect(accessLog.verifyChain()).toEqual(valid);
  });

  it('rejects a changed event even when every hash and link is recalculated', () => {
    const blocks = copyChain();
    blocks[1].data.patientId = 99;
    rehashFrom(blocks, 1);

    expect(accessLog.blockchain.isValid(blocks)).toBe(true);
    expectInvalid(blocks, 1, 'Invalid access-event signature');
  });

  it('rejects replacement of both the supplied public key and signature', () => {
    const blocks = copyChain();
    const block = blocks[1];
    const pair = generateKeyPairSync('ed25519');
    const payload = Buffer.from(JSON.stringify({ ...event, timestamp: block.timestamp }));
    block.data.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    block.data.signature = sign(null, payload, pair.privateKey).toString('base64');
    rehashFrom(blocks, 1);

    expect(verify(null, payload, block.data.publicKey, Buffer.from(block.data.signature, 'base64'))).toBe(true);
    expect(accessLog.blockchain.isValid(blocks)).toBe(true);
    expectInvalid(blocks, 1, 'Invalid access-event signature');
  });

  it.each([null, 'invalid public key'])('rejects an unavailable trusted key: %j', (publicKey) => {
    const blocks = copyChain();
    db.prepare('UPDATE users SET public_key = ? WHERE id = 1').run(publicKey);
    const changes = db.prepare('SELECT total_changes() AS count').get().count;

    expectInvalid(blocks, 1, 'Invalid access-event signature');
    expect(db.prepare('SELECT public_key FROM users WHERE id = 1').get().public_key).toBe(publicKey);
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(changes);
  });

  it('rejects an unknown user without registering a key', () => {
    const blocks = copyChain();
    blocks[1].data.userId = 999;
    rehashFrom(blocks, 1);

    expectInvalid(blocks, 1, 'Invalid access-event signature');
    expect(db.prepare('SELECT id FROM users WHERE id = 999').get()).toBeUndefined();
    expect(existsSync(join(keyDirectory, '999.pem'))).toBe(false);
  });

  it('does not normalize equivalent timestamp text before verifying signatures', () => {
    const blocks = copyChain();
    blocks[1].timestamp = '2026-09-18T09:15:02.100Z';
    rehashFrom(blocks, 1);

    expect(accessLog.blockchain.isValid(blocks)).toBe(true);
    expectInvalid(blocks, 1, 'Invalid access-event signature');
  });

  it('hashes stored field order without reconstructing or normalizing the data', () => {
    const blocks = copyChain();
    blocks[1].data = Object.fromEntries(Object.entries(blocks[1].data).reverse());
    expectInvalid(blocks, 1, 'Invalid block hash');
    rehashFrom(blocks, 1);
    expect(accessLog.verifyChain(blocks)).toEqual(valid);
  });

  it.each([
    ['index', 1], ['timestamp', timestamp], ['nodeId', 'other-node'],
    ['prevHash', 'f'.repeat(64)], ['data', {}], ['hash', 'f'.repeat(64)],
  ])('rejects altered genesis %s', (field, value) => {
    const blocks = JSON.parse(JSON.stringify(accessLog.blockchain.chain));
    blocks[0][field] = value;
    if (field !== 'hash') rehashFrom(blocks, 0);
    expectInvalid(blocks, 0);
  });

  it.each([
    ['index', 99, 'Invalid block index'],
    ['nodeId', 'other-node', 'Unexpected nodeId'],
    ['prevHash', 'f'.repeat(64), 'Invalid prevHash'],
    ['hash', 'f'.repeat(64), 'Invalid block hash'],
  ])('reports array position for altered %s', (field, value, reason) => {
    const blocks = copyChain();
    blocks[2][field] = value;
    if (field !== 'hash') rehashFrom(blocks, 2);
    expectInvalid(blocks, 2, reason);
  });

  it('rejects a complete valid chain belonging to a different node', () => {
    const other = createAccessLog('other-node', db, keyDirectory);
    other.addAccessLog(event);
    expect(other.verifyChain()).toEqual(valid);
    expectInvalid(other.blockchain.chain, 0, 'Unexpected nodeId');
    expect(verifyChain(other.blockchain.chain, nodeId, signing.verifyAccessEvent))
      .toEqual({ valid: false, position: 0, reason: 'Unexpected nodeId' });
  });

  it.each([undefined, null, '', 7])('requires an explicit expected node identity: %j', (expectedNodeId) => {
    expect(verifyChain(signedChain(), expectedNodeId, signing.verifyAccessEvent))
      .toEqual({ valid: false, position: null, reason: 'Expected nodeId must be a non-empty string' });
  });

  it.each([undefined, null, true])('does not silently skip a missing signature verifier: %j', (verifier) => {
    expect(() => verifyChain(signedChain(), nodeId, verifier)).toThrow('trusted signature verifier');
  });

  it('returns the first bad signature before a later structural error', () => {
    const blocks = copyChain();
    blocks[1].data.action = 'write';
    rehashFrom(blocks, 1);
    blocks[2].index = 700;
    blocks[3].hash = 'bad';
    expectInvalid(blocks, 1, 'Invalid access-event signature');
  });

  it.each(['remove', 'reorder'])('rejects %s of an interior block at the first affected position', (change) => {
    const blocks = copyChain();
    if (change === 'remove') blocks.splice(1, 1);
    else [blocks[1], blocks[2]] = [blocks[2], blocks[1]];
    expectInvalid(blocks, 1, 'Invalid block index');
  });

  it.each([undefined, null, [], {}, 'chain', 1].map((blocks) => [blocks]))('reports no block position for malformed chain input: %j', (blocks) => {
    expect(verifyChain(blocks, nodeId, signing.verifyAccessEvent))
      .toEqual({ valid: false, position: null, reason: 'Chain must be a non-empty array' });
  });

  it.each([[null], [[]], [{}], Array(2)].map((blocks) => [blocks]))('reports position zero for a malformed first block: %j', (blocks) => {
    expectInvalid(blocks, 0);
  });

  it.each(['index', 'timestamp', 'nodeId', 'prevHash', 'hash', 'data'])(
    'rejects a missing block field: %s', (field) => {
      const blocks = copyChain();
      delete blocks[2][field];
      expectInvalid(blocks, 2);
    },
  );

  it.each(['userId', 'role', 'patientId', 'action', 'signature', 'publicKey'])(
    'rejects a missing access-event field: %s', (field) => {
      const blocks = copyChain();
      delete blocks[2].data[field];
      rehashFrom(blocks, 2);
      expectInvalid(blocks, 2);
    },
  );

  it.each(['text', 'diagnosis', 'name', 'personalId', 'privateKey'])(
    'rejects a forbidden block or data field: %s', (field) => {
      const original = JSON.stringify(signedChain());
      for (const location of ['block', 'data']) {
        const blocks = JSON.parse(original);
        const target = location === 'block' ? blocks[2] : blocks[2].data;
        target[field] = 'not allowed';
        rehashFrom(blocks, 2);
        expectInvalid(blocks, 2);
      }
    },
  );

  it.each(['block', 'data'])('rejects getters in %s without invoking them', (location) => {
    const blocks = copyChain();
    const target = location === 'block' ? blocks[2] : blocks[2].data;
    const field = location === 'block' ? 'timestamp' : 'patientId';
    let reads = 0;
    Object.defineProperty(target, field, { enumerable: true, get() { reads += 1; return 99; } });
    expectInvalid(blocks, 2);
    expect(reads).toBe(0);
  });

  it.each(['valid', 'hash', 'signature'])('leaves frozen %s input, keys and database unchanged', (kind) => {
    const blocks = copyChain();
    if (kind !== 'valid') blocks[2].data.patientId = 99;
    if (kind === 'signature') rehashFrom(blocks, 2);
    for (const block of blocks) {
      if (block.data) Object.freeze(block.data);
      Object.freeze(block);
    }
    Object.freeze(blocks);
    const before = JSON.stringify(blocks);
    const users = db.prepare('SELECT * FROM users').all();
    const changes = db.prepare('SELECT total_changes() AS count').get().count;
    const files = readdirSync(keyDirectory).map((name) => [name, readFileSync(join(keyDirectory, name), 'utf8')]);

    expect(accessLog.verifyChain(blocks).valid).toBe(kind === 'valid');
    expect(JSON.stringify(blocks)).toBe(before);
    expect(db.prepare('SELECT * FROM users').all()).toEqual(users);
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(changes);
    expect(readdirSync(keyDirectory)).toEqual(files.map(([name]) => name));
    for (const [name, contents] of files) expect(readFileSync(join(keyDirectory, name), 'utf8')).toBe(contents);
  });

  it('verifies without private key files and never recreates them', () => {
    signedChain();
    rmSync(keyDirectory, { recursive: true });
    expect(accessLog.verifyChain()).toEqual(valid);
    expect(existsSync(keyDirectory)).toBe(false);
  });

  it('preserves the boolean structure/hash-only Blockchain interface', () => {
    const blockchain = new Blockchain(nodeId);
    const data = signing.signAccessEvent(event, timestamp);
    const block = blockchain.addBlock(data, timestamp);
    block.data.patientId = 99;
    block.hash = calculateBlockHash(block);
    expect(blockchain.isValid()).toBe(true);
    expect(signing.verifyAccessEvent(block.data, block.timestamp)).toBe(false);
    expect(verifyChain(blockchain.chain, nodeId, signing.verifyAccessEvent).valid).toBe(false);
  });
});
