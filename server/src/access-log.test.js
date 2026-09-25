import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessLog } from './access-log.js';
import { createAccessSigner } from './access-signing.js';

const schema = readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8');
const exportFixture = fileURLToPath(new URL('../test/fixtures/chain-export.js', import.meta.url));
const event = { userId: 1, role: 'doctor', patientId: 2, action: 'read' };
let directory;
let databaseFile;
let keyDirectory;
let db;
let chain;
let statements;

function registeredKey(userId = 1) {
  return db.prepare('SELECT public_key FROM users WHERE id = ?').get(userId).public_key;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bcu-access-log-'));
  databaseFile = join(directory, 'journal.db');
  keyDirectory = `${databaseFile}.keys`;
  statements = [];
  db = new Database(databaseFile, { verbose: (sql) => statements.push(sql) });
  db.exec(schema);
  chain = createAccessLog('node-3001', db, keyDirectory);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('access log', () => {
  it('links read and write blocks using one clock reading per signed timestamp', () => {
    const firstTime = '2026-09-17T12:00:00.001Z';
    const secondTime = '2026-09-17T12:00:00.002Z';
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse(firstTime))
      .mockReturnValueOnce(Date.parse(secondTime));
    const blockchain = chain.blockchain;
    const read = chain.addAccessLog(event);
    const writeEvent = { ...event, action: 'write' };
    const write = chain.addAccessLog(writeEvent);

    expect(now).toHaveBeenCalledTimes(2);
    expect(read.timestamp).toBe(firstTime);
    expect(write.timestamp).toBe(secondTime);
    for (const [block, input, timestamp] of [[read, event, firstTime], [write, writeEvent, secondTime]]) {
      expect(verify(null, Buffer.from(JSON.stringify({ ...input, timestamp })),
        registeredKey(), Buffer.from(block.data.signature, 'base64'))).toBe(true);
      expect(block.data.publicKey).toBe(registeredKey());
    }
    expect(chain.blockchain).toBe(blockchain);
    expect(blockchain.chain.map((block) => block.index)).toEqual([0, 1, 2]);
    expect(blockchain.chain[1]).toBe(read);
    expect(blockchain.chain[2]).toBe(write);
    expect(read.prevHash).toBe(blockchain.chain[0].hash);
    expect(write.prevHash).toBe(read.hash);
    expect(blockchain.isValid()).toBe(true);
  });

  it('keeps node chains separate while sharing the registered user key', () => {
    const otherDb = new Database(databaseFile);
    try {
      const other = createAccessLog('node-3002', otherDb, keyDirectory);
      const first = chain.addAccessLog(event);
      const privateFile = readFileSync(join(keyDirectory, '1.pem'));
      const second = other.addAccessLog({ ...event, action: 'write' });

      expect(other.blockchain).not.toBe(chain.blockchain);
      expect(first.nodeId).toBe('node-3001');
      expect(second.nodeId).toBe('node-3002');
      expect(first.index).toBe(1);
      expect(second.index).toBe(1);
      expect(second.data.publicKey).toBe(first.data.publicKey);
      expect(readFileSync(join(keyDirectory, '1.pem')).equals(privateFile)).toBe(true);
      expect(readdirSync(keyDirectory)).toEqual(['1.pem']);
      expect(createAccessSigner(otherDb, keyDirectory).verifyAccessEvent(second.data, second.timestamp)).toBe(true);
      chain.addAccessLog(event);
      expect(chain.blockchain.chain).toHaveLength(3);
      expect(other.blockchain.chain).toHaveLength(2);
      expect(other.blockchain.isValid()).toBe(true);
    } finally {
      otherDb.close();
    }
  });

  it.each([
    ['null event', null, /access-event object/],
    ['missing field', { userId: 1, role: 'doctor', patientId: 2 }, /only userId/],
    ['invalid action', { ...event, action: 'delete' }, /action/],
    ['invalid userId', { ...event, userId: '1' }, /userId/],
    ['journal field', { ...event, journalText: 'test-only journal content' }, /only userId/],
    ['supplied timestamp', { ...event, timestamp: '2020-01-01T00:00:00.000Z' }, /only userId/],
    ['private key field', { ...event, privateKey: 'test-only key' }, /only userId/],
    ['unknown user', { ...event, userId: 999 }, /Unknown user/],
    ['wrong role', { ...event, role: 'patient' }, /does not match the registered user/],
  ])('rejects %s without appending or creating keys', (_name, input, message) => {
    const before = JSON.stringify(chain.blockchain.chain);
    expect(() => chain.addAccessLog(input)).toThrow(message);
    expect(JSON.stringify(chain.blockchain.chain)).toBe(before);
    expect(registeredKey()).toBeNull();
    expect(existsSync(keyDirectory)).toBe(false);
  });

  it.each(['missing', 'mismatched'])('does not append when the registered private key is %s', (kind) => {
    chain.addAccessLog(event);
    const before = JSON.stringify(chain.blockchain.chain);
    const publicKey = registeredKey();
    const file = join(keyDirectory, '1.pem');
    if (kind === 'missing') {
      unlinkSync(file);
    } else {
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    const message = kind === 'missing' ? /private key is missing/ : /does not match the registered public key/;

    expect(() => chain.addAccessLog(event)).toThrow(message);
    expect(JSON.stringify(chain.blockchain.chain)).toBe(before);
    expect(registeredKey()).toBe(publicKey);
    if (kind === 'missing') expect(existsSync(file)).toBe(false);
  });

  it('rejects a tampered chain before signing without repairing it', () => {
    chain.addAccessLog(event);
    chain.blockchain.chain[1].data.patientId = 3;
    const before = JSON.stringify(chain.blockchain.chain);
    statements.length = 0;

    expect(() => chain.addAccessLog({ ...event, userId: 2, role: 'nurse' }))
      .toThrow('Cannot append to an invalid chain');
    expect(statements).toEqual([]);
    expect(JSON.stringify(chain.blockchain.chain)).toBe(before);
    expect(chain.blockchain.isValid()).toBe(false);
    expect(registeredKey(2)).toBeNull();
    expect(existsSync(join(keyDirectory, '2.pem'))).toBe(false);
  });

  it('leaves the caller transaction and its uncommitted write intact on rejection', () => {
    const originalName = db.prepare('SELECT display_name FROM users WHERE id = 1').get().display_name;
    const observer = new Database(databaseFile);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET display_name = ? WHERE id = 1').run('Temporary test name');
      expect(() => chain.addAccessLog(event)).toThrow('Signing must start outside an existing database transaction');
      expect(db.inTransaction).toBe(true);
      expect(db.prepare('SELECT display_name FROM users WHERE id = 1').get().display_name).toBe('Temporary test name');
      expect(observer.prepare('SELECT display_name FROM users WHERE id = 1').get().display_name).toBe(originalName);
      expect(chain.blockchain.chain).toHaveLength(1);
      expect(registeredKey()).toBeNull();
      expect(existsSync(keyDirectory)).toBe(false);
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      observer.close();
    }
    expect(db.prepare('SELECT display_name FROM users WHERE id = 1').get().display_name).toBe(originalName);
    expect(chain.addAccessLog(event).index).toBe(1);
  });

  it('returns a JSON-safe block containing only public access metadata', () => {
    const block = chain.addAccessLog(event);
    const json = JSON.stringify(block);
    const parsed = JSON.parse(json);

    expect(Object.keys(parsed).sort()).toEqual(['data', 'hash', 'index', 'nodeId', 'prevHash', 'timestamp']);
    expect(Object.keys(parsed.data)).toEqual(['userId', 'role', 'patientId', 'action', 'signature', 'publicKey']);
    expect(parsed.data).toMatchObject(event);
    expect(json.includes('PRIVATE KEY')).toBe(false);
    expect(json.includes(readFileSync(join(keyDirectory, '1.pem'), 'utf8').trim())).toBe(false);
    expect(createAccessSigner(db, keyDirectory).verifyAccessEvent(parsed.data, parsed.timestamp)).toBe(true);
    expect(chain.blockchain.isValid(JSON.parse(JSON.stringify(chain.blockchain.chain)))).toBe(true);
  });

  it('runs the real chain export with temporary configuration and reuses its singleton', () => {
    const productionDb = join(directory, 'production.db');
    const envFile = join(directory, 'test.env');
    writeFileSync(envFile, `PORT=3009\nNODE_ID=test-production-node\nDB_PATH=${productionDb}\n`);
    const environment = { ...process.env };
    for (const name of ['PORT', 'NODE_ID', 'DB_PATH', 'PEER_URL', 'CLIENT_ORIGIN']) delete environment[name];
    const result = JSON.parse(execFileSync(process.execPath, [exportFixture, '--env', envFile], {
      cwd: directory, env: environment, encoding: 'utf8', timeout: 10000,
    }));

    expect(result.sameExport).toBe(true);
    expect(result.sameBlockchain).toBe(true);
    expect(result.returnedStoredBlocks).toBe(true);
    expect(result.nodeId).toBe('test-production-node');
    expect(result.dbFile).toBe(productionDb);
    expect(result.indexes).toEqual([0, 1, 2]);
    expect(result.validChain).toBe(true);
    expect(result.chainVerification).toEqual({ valid: true, position: null, reason: null });
    expect(result.validSignatures).toEqual([true, true]);
    expect(readdirSync(`${productionDb}.keys`)).toEqual(['1.pem']);
  });
});
