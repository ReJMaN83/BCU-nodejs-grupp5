import { describe, expect, it } from 'vitest';
import { Block } from './block.js';

// Encoding fixtures only: these are not a valid cryptographic signature/key pair.
const data = {
  userId: 1,
  role: 'doctor',
  patientId: 2,
  action: 'read',
  signature: 'dGVzdA==',
  publicKey: '-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----\n',
};
const input = {
  index: 1,
  timestamp: '2026-09-18T09:15:02.123Z',
  nodeId: 'node-3001',
  prevHash: '0'.repeat(64),
  data,
};
// Fixed vector checked independently from Block.calculateHash().
const expectedHash = '43d27bbf75479d3e01cedbf2a6455708092bb638ddc670dcc0b1e26f0eb7eaca';

describe('Block', () => {
  it('serializes exactly the contract fields and matches a fixed SHA-256 vector', () => {
    const block = new Block(input);

    expect(JSON.parse(JSON.stringify(block))).toEqual({ ...input, hash: expectedHash });
    expect(block.hash).toBe(expectedHash);
    expect(block.calculateHash()).toBe(expectedHash);
  });

  it('normalizes incoming data order and calculates repeatable hashes', () => {
    const reversed = Object.fromEntries(Object.entries(data).reverse());
    const block = new Block({ ...input, data: reversed });

    expect(Object.keys(block.data)).toEqual([
      'userId', 'role', 'patientId', 'action', 'signature', 'publicKey',
    ]);
    expect(JSON.stringify(block.data)).toBe(JSON.stringify(data));
    expect(block.hash).toBe(expectedHash);
    expect(new Block(input).hash).toBe(block.hash);
    expect(block.calculateHash()).toBe(expectedHash);
  });

  it.each([
    ['index', 2],
    ['timestamp', '2026-09-18T09:15:03.123Z'],
    ['nodeId', 'node-3002'],
    ['prevHash', '1'.repeat(64)],
  ])('includes %s in the hash', (field, value) => {
    const block = new Block({ ...input, [field]: value });

    expect(block.hash).not.toBe(expectedHash);
  });

  it.each([
    ['userId', 2],
    ['role', 'patient'],
    ['patientId', 3],
    ['action', 'write'],
    ['signature', 'bmV3'],
    ['publicKey', '-----BEGIN PUBLIC KEY-----\nZGVm\n-----END PUBLIC KEY-----\n'],
  ])('includes data.%s in the hash', (field, value) => {
    const block = new Block({ ...input, data: { ...data, [field]: value } });

    expect(block.hash).not.toBe(expectedHash);
  });

  it('preserves the hash input through a JSON round trip', () => {
    const block = new Block(input);
    const parsed = JSON.parse(JSON.stringify(block));
    const restored = new Block(parsed);

    expect(restored).toEqual(block);
    expect(restored.calculateHash()).toBe(parsed.hash);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(block));
  });

  it('hashes the current stored data representation without reordering it', () => {
    const block = new Block(input);
    block.data = Object.fromEntries(Object.entries(block.data).reverse());

    expect(block.calculateHash()).not.toBe(block.hash);
    expect(JSON.parse(JSON.stringify(block)).data).toEqual(data);
  });

  it('copies input data so changes to the caller object do not change the block', () => {
    const original = { ...data };
    const block = new Block({ ...input, data: original });
    original.patientId = 99;

    expect(block.data.patientId).toBe(2);
    expect(block.calculateHash()).toBe(expectedHash);
  });

  it('represents genesis with the supplied timestamp and null data', () => {
    const genesis = new Block({ ...input, index: 0, prevHash: '0', data: null });

    expect(genesis.data).toBeNull();
    expect(genesis.timestamp).toBe(input.timestamp);
    expect(new Block(JSON.parse(JSON.stringify(genesis)))).toEqual(genesis);
    expect(genesis.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['text', 'diagnosis', 'name', 'personalId', 'privateKey', 'extra'])(
    'rejects the extra data field %s', (field) => {
      expect(() => new Block({ ...input, data: { ...data, [field]: 'not allowed' } }))
        .toThrow('exactly the six access-event fields');
    },
  );

  it('rejects non-enumerable extra fields as well', () => {
    const withExtraField = { ...data };
    Object.defineProperty(withExtraField, 'text', { value: 'not allowed' });

    expect(() => new Block({ ...input, data: withExtraField }))
      .toThrow('exactly the six access-event fields');
  });

  it.each(Object.keys(data))('rejects a missing data.%s', (field) => {
    const incomplete = { ...data };
    delete incomplete[field];

    expect(() => new Block({ ...input, data: incomplete })).toThrow(TypeError);
  });

  it.each([
    ['userId', { text: 'not allowed' }],
    ['patientId', '2'],
    ['role', 'admin'],
    ['action', 'delete'],
    ['signature', { text: 'not allowed' }],
    ['signature', 'not base64'],
    ['publicKey', '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n'],
    ['publicKey', { text: 'not allowed' }],
  ])('rejects an invalid data.%s value', (field, value) => {
    expect(() => new Block({ ...input, data: { ...data, [field]: value } }))
      .toThrow(TypeError);
  });

  it.each([null, [], 'not an event', undefined])('rejects non-event data %j', (value) => {
    expect(() => new Block({ ...input, data: value })).toThrow(TypeError);
  });

  it.each([
    { index: -1 },
    { index: 1.5 },
    { timestamp: {} },
    { nodeId: '' },
    { prevHash: null },
    { index: 0, prevHash: '0', data },
    { index: 0, prevHash: 'wrong', data: null },
  ])('rejects invalid block metadata or genesis shape: %j', (changes) => {
    expect(() => new Block({ ...input, ...changes })).toThrow(TypeError);
  });
});
