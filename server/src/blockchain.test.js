import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Block } from './block.js';
import { Blockchain } from './blockchain.js';

const nodeId = 'node-3001';
const timestamp = '2026-09-18T09:15:02.123Z';
// Encoding fixtures only; signature verification is outside this class.
const event = {
  userId: 1,
  role: 'doctor',
  patientId: 2,
  action: 'read',
  signature: 'dGVzdA==',
  publicKey: '-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----\n',
};

function createBlockchain() {
  const blockchain = new Blockchain(nodeId);
  for (const patientId of [1, 2, 3]) {
    blockchain.addBlock({ ...event, patientId }, timestamp);
  }
  return blockchain;
}

function rehash(block) {
  block.hash = createHash('sha256')
    .update(block.index + block.timestamp + block.nodeId + block.prevHash + JSON.stringify(block.data))
    .digest('hex');
}

describe('Blockchain', () => {
  it('creates a deterministic genesis for its fixed nodeId', () => {
    const blockchain = new Blockchain(nodeId);
    const other = new Blockchain('node-3002');

    expect(blockchain.chain).toEqual([new Block({
      index: 0,
      timestamp: '1970-01-01T00:00:00.000Z',
      nodeId,
      prevHash: '0',
      data: null,
    })]);
    expect(blockchain.chain).toEqual(new Blockchain(nodeId).chain);
    expect(other.chain[0].hash).not.toBe(blockchain.chain[0].hash);
    expect(blockchain.nodeId).toBe(nodeId);
    expect(() => { blockchain.nodeId = 'node-3002'; }).toThrow(TypeError);
    expect(blockchain.isValid()).toBe(true);
  });

  it.each([undefined, null, '', 1])('rejects an invalid nodeId: %j', (value) => {
    expect(() => new Blockchain(value)).toThrow(TypeError);
  });

  it('appends and returns blocks with consecutive indexes and stored hash links', () => {
    const blockchain = new Blockchain(nodeId);
    const first = blockchain.addBlock(event, timestamp);
    const second = blockchain.addBlock({ ...event, action: 'write' }, '2026-09-18T10:00:00Z');

    expect(first).toBe(blockchain.chain[1]);
    expect(second).toBe(blockchain.chain[2]);
    expect(first).toBeInstanceOf(Block);
    expect(first.index).toBe(1);
    expect(second.index).toBe(2);
    expect(first.prevHash).toBe(blockchain.chain[0].hash);
    expect(second.prevHash).toBe(first.hash);
    expect(first.timestamp).toBe(timestamp);
    expect(second.timestamp).toBe('2026-09-18T10:00:00Z');
    expect(second.nodeId).toBe(nodeId);
    expect(blockchain.isValid()).toBe(true);
  });

  it('validates JSON-read blocks without replacing the instance chain', () => {
    const blockchain = createBlockchain();
    const originalChain = blockchain.chain;
    const parsed = JSON.parse(JSON.stringify(originalChain));

    expect(parsed[1]).not.toBeInstanceOf(Block);
    expect(blockchain.isValid(parsed)).toBe(true);
    expect(blockchain.chain).toBe(originalChain);
    expect(new Blockchain('node-3002').isValid(parsed)).toBe(false);
  });

  it('does not repair an altered event by reconstructing the block', () => {
    const blockchain = createBlockchain();
    const parsed = JSON.parse(JSON.stringify(blockchain.chain));
    const last = parsed[3];
    const originalHash = last.hash;
    last.data.patientId = 99;
    const before = JSON.stringify(parsed);

    expect(new Block(last).hash).not.toBe(originalHash);
    expect(blockchain.isValid(parsed)).toBe(false);
    expect(last.hash).toBe(originalHash);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it('checks the actual stored data order instead of normalizing it', () => {
    const blockchain = createBlockchain();
    const parsed = JSON.parse(JSON.stringify(blockchain.chain));
    const last = parsed[3];
    last.data = Object.fromEntries(Object.entries(last.data).reverse());

    expect(new Block(last).hash).toBe(last.hash);
    expect(blockchain.isValid(parsed)).toBe(false);
    rehash(last);
    const before = JSON.stringify(parsed);
    expect(blockchain.isValid(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ['hash', 'f'.repeat(64)],
    ['prevHash', 'f'.repeat(64)],
    ['index', 99],
    ['nodeId', 'node-3002'],
    ['timestamp', '2026-09-19T09:15:02.123Z'],
  ])('detects an altered %s on a Block instance', (field, value) => {
    const blockchain = createBlockchain();
    blockchain.chain[2][field] = value;

    expect(blockchain.isValid()).toBe(false);
  });

  it.each([
    ['prevHash', 'f'.repeat(64)],
    ['index', 99],
    ['nodeId', 'node-3002'],
    ['data', null],
  ])('rejects invalid %s even with a matching recalculated hash', (field, value) => {
    const blockchain = createBlockchain();
    const last = blockchain.chain[3];
    last[field] = value;
    rehash(last);

    expect(blockchain.isValid()).toBe(false);
  });

  it.each([
    ['index', 1],
    ['timestamp', timestamp],
    ['nodeId', 'node-3002'],
    ['prevHash', 'f'.repeat(64)],
    ['data', event],
  ])('rejects altered genesis %s even after rehashing', (field, value) => {
    const blockchain = new Blockchain(nodeId);
    blockchain.chain[0][field] = value;
    rehash(blockchain.chain[0]);

    expect(blockchain.isValid()).toBe(false);
  });

  it('rejects a removed interior block', () => {
    const blockchain = createBlockchain();
    blockchain.chain.splice(1, 1);

    expect(blockchain.isValid()).toBe(false);
  });

  it('rejects reordered interior blocks', () => {
    const blockchain = createBlockchain();
    [blockchain.chain[1], blockchain.chain[2]] = [blockchain.chain[2], blockchain.chain[1]];

    expect(blockchain.isValid()).toBe(false);
  });

  it.each([null, [], {}, 'chain', 1, [null], [[]], [{}], Array(2)])(
    'returns false for a malformed chain: %j', (chain) => {
      expect(new Blockchain(nodeId).isValid(chain)).toBe(false);
    },
  );

  it.each(['index', 'timestamp', 'nodeId', 'prevHash', 'hash', 'data'])(
    'rejects a missing block field: %s', (field) => {
      const blockchain = createBlockchain();
      delete blockchain.chain[3][field];

      expect(blockchain.isValid()).toBe(false);
    },
  );

  it.each(['text', 'diagnosis', 'name', 'personalId', 'privateKey'])(
    'rejects extra block/data field %s even after rehashing', (field) => {
      for (const location of ['block', 'data']) {
        const blockchain = createBlockchain();
        const block = blockchain.chain[3];
        const target = location === 'block' ? block : block.data;
        target[field] = 'not allowed';
        rehash(block);

        expect(blockchain.isValid()).toBe(false);
      }
    },
  );

  it('rejects non-enumerable fields and custom serialization', () => {
    const blockchain = createBlockchain();
    const parsed = JSON.parse(JSON.stringify(blockchain.chain));
    Object.defineProperty(parsed[3], 'text', { value: 'not allowed' });
    expect(blockchain.isValid(parsed)).toBe(false);

    const data = Object.assign(Object.create({ toJSON: () => ({ text: 'not allowed' }) }), event);
    blockchain.chain[3].data = data;
    rehash(blockchain.chain[3]);
    expect(blockchain.isValid()).toBe(false);
  });

  it.each(['block', 'data'])('rejects getters in %s without invoking them', (location) => {
    const blockchain = createBlockchain();
    const block = blockchain.chain[3];
    const target = location === 'block' ? block : block.data;
    const field = location === 'block' ? 'timestamp' : 'patientId';
    let reads = 0;
    Object.defineProperty(target, field, {
      enumerable: true,
      get() { reads += 1; return 'not a stored value'; },
    });

    expect(blockchain.isValid()).toBe(false);
    expect(reads).toBe(0);
  });

  it.each([
    ['userId', '1'],
    ['patientId', 1.5],
    ['role', 'admin'],
    ['action', 'delete'],
    ['signature', null],
    ['publicKey', '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n'],
  ])('rejects invalid data.%s after rehashing', (field, value) => {
    const blockchain = createBlockchain();
    blockchain.chain[3].data[field] = value;
    rehash(blockchain.chain[3]);

    expect(blockchain.isValid()).toBe(false);
  });

  it.each([
    undefined, null, '', 'not a date', '2026-09-18',
    '2026-09-18T09:15:02.123', '2026-09-18T09:15:02.123+00:00',
    '2026-02-30T09:15:02.123Z', '2026-09-18T24:00:00.000Z',
  ])('rejects invalid/non-UTC timestamp %j without appending', (value) => {
    const blockchain = createBlockchain();
    const before = JSON.stringify(blockchain.chain);

    expect(() => blockchain.addBlock(event, value)).toThrow(TypeError);
    expect(JSON.stringify(blockchain.chain)).toBe(before);
    blockchain.chain[3].timestamp = value;
    rehash(blockchain.chain[3]);
    expect(blockchain.isValid()).toBe(false);
  });

  it.each(['2026-09-18T09:15:02Z', '2026-09-18T09:15:02.1Z', timestamp])(
    'preserves a valid UTC timestamp exactly: %s', (value) => {
      const blockchain = new Blockchain(nodeId);

      expect(blockchain.addBlock(event, value).timestamp).toBe(value);
      expect(blockchain.isValid()).toBe(true);
    },
  );

  it.each([false, true])('does not mutate a frozen chain (tampered: %j)', (tampered) => {
    const blockchain = createBlockchain();
    const parsed = JSON.parse(JSON.stringify(blockchain.chain));
    if (tampered) parsed[3].data.patientId = 99;
    for (const block of parsed) {
      if (block.data) Object.freeze(block.data);
      Object.freeze(block);
    }
    Object.freeze(parsed);
    const before = JSON.stringify(parsed);

    expect(blockchain.isValid(parsed)).toBe(!tampered);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([null, {}, { ...event, text: 'not allowed' }])(
    'leaves the chain unchanged when an event is invalid: %j', (data) => {
      const blockchain = createBlockchain();
      const originalChain = blockchain.chain;
      const before = JSON.stringify(originalChain);

      expect(() => blockchain.addBlock(data, timestamp)).toThrow(TypeError);
      expect(blockchain.chain).toBe(originalChain);
      expect(JSON.stringify(blockchain.chain)).toBe(before);
    },
  );

  it('refuses to append to an invalid chain without repairing it', () => {
    const blockchain = createBlockchain();
    blockchain.chain[1].data.patientId = 99;
    const before = JSON.stringify(blockchain.chain);

    expect(() => blockchain.addBlock(event, timestamp)).toThrow('invalid chain');
    expect(JSON.stringify(blockchain.chain)).toBe(before);
  });
});
