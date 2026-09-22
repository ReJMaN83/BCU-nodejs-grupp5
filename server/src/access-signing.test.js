import Database from 'better-sqlite3';
import { fork } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessSigner } from './access-signing.js';
import { Blockchain } from './blockchain.js';

const schema = readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8');
const workerFile = fileURLToPath(new URL('../test/fixtures/access-signing-worker.js', import.meta.url));
const timestamp = '2026-09-18T09:15:02.123Z';
const event = { userId: 1, role: 'doctor', patientId: 2, action: 'read' };
const otherEvent = { ...event, userId: 2, role: 'nurse' };

let directory;
let databaseFile;
let keyDirectory;
let db;
let signer;
let workers;

function registeredKey(userId = 1) {
  return db.prepare('SELECT public_key FROM users WHERE id = ?').get(userId)?.public_key;
}

function fileState() {
  if (!existsSync(keyDirectory)) return [];
  return readdirSync(keyDirectory).sort().map((name) => {
    const file = join(keyDirectory, name);
    const { ino, mode, size, mtimeMs } = statSync(file);
    return { name, ino, mode, size, mtimeMs, digest: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}

function startWorker() {
  const child = fork(workerFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const promises = {};
  const resolve = {};
  const reject = {};
  for (const type of ['ready', 'attempting', 'result', 'exit']) {
    promises[type] = new Promise((yes, no) => { resolve[type] = yes; reject[type] = no; });
    promises[type].catch(() => {});
  }
  child.on('message', (message) => {
    if (message.type === 'error') {
      for (const no of Object.values(reject)) no(new Error(message.message));
    } else {
      resolve[message.type]?.(message);
    }
  });
  child.on('error', (error) => {
    for (const no of Object.values(reject)) no(error);
  });
  child.on('exit', (code) => {
    resolve.exit(code);
    for (const type of ['ready', 'attempting', 'result']) {
      reject[type](new Error(`Signing worker exited before ${type}`));
    }
  });
  const worker = { child, ...promises };
  workers.push(worker);
  child.send({ type: 'init', databaseFile, keyDirectory });
  return worker;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bcu-access-signing-'));
  databaseFile = join(directory, 'journal.db');
  keyDirectory = `${databaseFile}.keys`;
  db = new Database(databaseFile, { timeout: 5000 });
  db.exec(schema);
  signer = createAccessSigner(db, keyDirectory);
  workers = [];
});

afterEach(async () => {
  for (const worker of workers) {
    if (worker.child.exitCode === null) worker.child.kill();
  }
  await Promise.allSettled(workers.map((worker) => worker.exit));
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('access signing', () => {
  it('does not create keys when the signer is constructed', () => {
    expect(existsSync(keyDirectory)).toBe(false);
    expect(registeredKey()).toBeNull();
    expect(Object.keys(signer)).toEqual(['signAccessEvent', 'verifyAccessEvent']);
  });

  it('signs the exact payload and verifies a JSON-read access block', () => {
    const data = signer.signAccessEvent(event, timestamp);
    const blockchain = new Blockchain('node-3001');
    const block = blockchain.addBlock(data, timestamp);
    const parsed = JSON.parse(JSON.stringify(block));
    const expectedPayload = Buffer.from(
      '{"userId":1,"role":"doctor","patientId":2,"action":"read","timestamp":"2026-09-18T09:15:02.123Z"}',
    );

    expect(verify(null, expectedPayload, registeredKey(), Buffer.from(data.signature, 'base64'))).toBe(true);
    expect(createPublicKey(data.publicKey).asymmetricKeyType).toBe('ed25519');
    expect(signer.verifyAccessEvent(parsed.data, parsed.timestamp)).toBe(true);
    expect(blockchain.isValid()).toBe(true);
    expect(Object.keys(data)).toEqual(['userId', 'role', 'patientId', 'action', 'signature', 'publicKey']);
    expect(JSON.stringify(data).includes('PRIVATE KEY')).toBe(false);
    const pem = readFileSync(join(keyDirectory, '1.pem'), 'utf8');
    expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(JSON.stringify(data).includes(pem.trim())).toBe(false);
  });

  it('preserves timestamp text and ignores incoming field order', () => {
    const reversed = Object.fromEntries(Object.entries(event).reverse());
    const shortTimestamp = '2026-09-18T09:15:02.1Z';
    const data = signer.signAccessEvent(reversed, shortTimestamp);

    expect(data).toEqual(signer.signAccessEvent(event, shortTimestamp));
    expect(signer.verifyAccessEvent(data, shortTimestamp)).toBe(true);
    expect(signer.verifyAccessEvent(data, '2026-09-18T09:15:02.100Z')).toBe(false);
  });

  it('reuses one key per user and creates different keys for different users', () => {
    const first = signer.signAccessEvent(event, timestamp);
    const before = fileState();
    const repeat = signer.signAccessEvent(event, timestamp);

    expect(repeat).toEqual(first);
    expect(fileState()).toEqual(before);
    const second = signer.signAccessEvent(otherEvent, timestamp);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(registeredKey(2)).toBe(second.publicKey);
    expect(readdirSync(keyDirectory).sort()).toEqual(['1.pem', '2.pem']);
  });

  it('reuses keys after reopening storage and verifies old signatures', () => {
    const original = signer.signAccessEvent(event, timestamp);
    const before = fileState();
    db.close();
    db = new Database(databaseFile);
    const reopened = createAccessSigner(db, keyDirectory);

    expect(reopened.verifyAccessEvent(original, timestamp)).toBe(true);
    expect(reopened.signAccessEvent(event, timestamp)).toEqual(original);
    expect(fileState()).toEqual(before);
  });

  it('serializes first-use initialization across two separate processes', async () => {
    const first = startWorker();
    const second = startWorker();
    await Promise.all([first.ready, second.ready]);
    // Both workers request signing while another connection holds the write lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const worker of [first, second]) worker.child.send({ type: 'sign', event, timestamp });
      await Promise.all([first.attempting, second.attempting]);
    } finally {
      db.exec('COMMIT');
    }
    const [left, right] = await Promise.all([first.result, second.result]);
    expect(left.pid).not.toBe(right.pid);
    expect(left.data).toEqual(right.data);
    expect(left.inode).toBe(right.inode);
    expect(registeredKey()).toBe(left.data.publicKey);
    expect(signer.verifyAccessEvent(left.data, timestamp)).toBe(true);
    expect(readdirSync(keyDirectory)).toEqual(['1.pem']);
    expect(await Promise.all([first.exit, second.exit])).toEqual([0, 0]);
  }, 10000);

  it.each([
    ['userId', 2], ['role', 'patient'], ['patientId', 3], ['action', 'write'],
  ])('rejects modified %s', (field, value) => {
    const data = signer.signAccessEvent(event, timestamp);
    signer.signAccessEvent(otherEvent, timestamp);
    expect(signer.verifyAccessEvent({ ...data, [field]: value }, timestamp)).toBe(false);
  });

  it('rejects an altered timestamp, signature or supplied key', () => {
    const data = signer.signAccessEvent(event, timestamp);
    const other = signer.signAccessEvent(otherEvent, timestamp);
    const changedSignature = Buffer.from(data.signature, 'base64');
    changedSignature[0] ^= 1;

    expect(signer.verifyAccessEvent(data, '2026-09-18T09:15:03.123Z')).toBe(false);
    expect(signer.verifyAccessEvent({ ...data, signature: changedSignature.toString('base64') }, timestamp)).toBe(false);
    expect(signer.verifyAccessEvent({ ...data, publicKey: other.publicKey }, timestamp)).toBe(false);
  });

  it('rejects an attacker replacing both the supplied key and signature', () => {
    const original = signer.signAccessEvent(event, timestamp);
    const attacker = generateKeyPairSync('ed25519');
    const encodedPayload = Buffer.from(JSON.stringify({ ...event, timestamp }));
    const forged = {
      ...original,
      publicKey: attacker.publicKey.export({ type: 'spki', format: 'pem' }),
      signature: sign(null, encodedPayload, attacker.privateKey).toString('base64'),
    };

    expect(verify(null, encodedPayload, forged.publicKey, Buffer.from(forged.signature, 'base64'))).toBe(true);
    expect(signer.verifyAccessEvent(forged, timestamp)).toBe(false);
  });

  it('keeps hash validation separate from signature validation', () => {
    const blockchain = new Blockchain('node-3001');
    const data = signer.signAccessEvent(event, timestamp);
    const block = blockchain.addBlock(data, timestamp);
    block.data.patientId = 3;
    block.hash = block.calculateHash();

    expect(blockchain.isValid()).toBe(true);
    expect(signer.verifyAccessEvent(block.data, block.timestamp)).toBe(false);
  });

  it('rejects non-canonical base64 even if it decodes to the same signature bytes', () => {
    const data = signer.signAccessEvent(event, timestamp);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const changed = alphabet[alphabet.indexOf(data.signature.at(-3)) ^ 1];
    const signature = `${data.signature.slice(0, -3)}${changed}==`;

    expect(Buffer.from(signature, 'base64').equals(Buffer.from(data.signature, 'base64'))).toBe(true);
    expect(signer.verifyAccessEvent({ ...data, signature }, timestamp)).toBe(false);
  });

  it('requires a known user and matching role before creating any key', () => {
    expect(() => signer.signAccessEvent({ ...event, userId: 999 }, timestamp)).toThrow('Unknown user');
    expect(() => signer.signAccessEvent({ ...event, role: 'patient' }, timestamp)).toThrow('role');
    expect(existsSync(keyDirectory)).toBe(false);
    expect(registeredKey()).toBeNull();
  });

  it.each(['text', 'diagnosis', 'name', 'personalId', 'privateKey', 'publicKey', 'signature', 'timestamp'])(
    'rejects an extra event field %s without creating a key', (field) => {
      expect(() => signer.signAccessEvent({ ...event, [field]: 'not allowed' }, timestamp)).toThrow(TypeError);
      expect(existsSync(keyDirectory)).toBe(false);
      expect(registeredKey()).toBeNull();
    },
  );

  it.each([null, [], {}, { ...event, userId: '1' }, { ...event, patientId: {} }, { ...event, action: 'delete' }])(
    'rejects invalid event %j', (data) => {
      expect(() => signer.signAccessEvent(data, timestamp)).toThrow(TypeError);
      expect(existsSync(keyDirectory)).toBe(false);
    },
  );

  it.each([undefined, null, '2026-09-18', '2026-02-30T09:00:00Z', '2026-09-18T09:00:00+02:00'])(
    'rejects invalid timestamp %j before creating a key', (value) => {
      expect(() => signer.signAccessEvent(event, value)).toThrow(TypeError);
      expect(existsSync(keyDirectory)).toBe(false);
    },
  );

  it('rejects missing and getter event fields', () => {
    const missing = { ...event };
    delete missing.action;
    expect(() => signer.signAccessEvent(missing, timestamp)).toThrow(TypeError);
    const accessor = { ...event };
    let reads = 0;
    Object.defineProperty(accessor, 'patientId', { get() { reads += 1; return 2; } });
    expect(() => signer.signAccessEvent(accessor, timestamp)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it.each(['missing', 'corrupt', 'trailing-data', 'mismatch'])('fails on a %s private key without rotation', (damage) => {
    signer.signAccessEvent(event, timestamp);
    const publicKey = registeredKey();
    const file = join(keyDirectory, '1.pem');
    if (damage === 'missing') unlinkSync(file);
    if (damage === 'corrupt') writeFileSync(file, 'incomplete');
    if (damage === 'trailing-data') writeFileSync(file, `${readFileSync(file, 'utf8')}unexpected data`);
    if (damage === 'mismatch') {
      writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    }
    const before = fileState();

    expect(() => signer.signAccessEvent(event, timestamp)).toThrow(/missing|corrupt|match/);
    expect(registeredKey()).toBe(publicKey);
    expect(fileState()).toEqual(before);
  });

  it('does not recreate a missing key directory for a registered key', () => {
    signer.signAccessEvent(event, timestamp);
    const publicKey = registeredKey();
    rmSync(keyDirectory, { recursive: true });

    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('missing');
    expect(existsSync(keyDirectory)).toBe(false);
    expect(registeredKey()).toBe(publicKey);
  });

  it('rejects a corrupt final file even before public-key registration', () => {
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, '1.pem'), 'partial', { mode: 0o600 });
    const before = fileState();

    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('corrupt');
    expect(registeredKey()).toBeNull();
    expect(fileState()).toEqual(before);
  });

  it('ignores unfinished temporary files and publishes a complete final key', () => {
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, '.interrupted.tmp'), 'partial', { mode: 0o600 });
    const data = signer.signAccessEvent(event, timestamp);

    expect(signer.verifyAccessEvent(data, timestamp)).toBe(true);
    expect(createPrivateKey(readFileSync(join(keyDirectory, '1.pem'))).asymmetricKeyType).toBe('ed25519');
    expect(readFileSync(join(keyDirectory, '.interrupted.tmp'), 'utf8')).toBe('partial');
  });

  it('reuses a complete file if registration was interrupted', () => {
    db.exec("CREATE TRIGGER interrupt_registration BEFORE UPDATE OF public_key ON users BEGIN SELECT RAISE(ABORT, 'test interruption'); END");
    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('test interruption');
    expect(registeredKey()).toBeNull();
    const before = fileState();
    const publicKey = createPublicKey(createPrivateKey(readFileSync(join(keyDirectory, '1.pem'))))
      .export({ type: 'spki', format: 'pem' });
    db.exec('DROP TRIGGER interrupt_registration');

    expect(signer.signAccessEvent(event, timestamp).publicKey).toBe(publicKey);
    expect(fileState()).toEqual(before);
  });

  it('rejects an invalid or non-Ed25519 registered key without changing it', () => {
    const data = signer.signAccessEvent(event, timestamp);
    const before = fileState();
    const wrongType = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' });
    for (const publicKey of ['corrupt', wrongType]) {
      db.prepare('UPDATE users SET public_key = ? WHERE id = 1').run(publicKey);
      expect(() => signer.signAccessEvent(event, timestamp)).toThrow(/registered public key/i);
      expect(signer.verifyAccessEvent({ ...data, publicKey }, timestamp)).toBe(false);
      expect(registeredKey()).toBe(publicKey);
      expect(fileState()).toEqual(before);
    }
  });

  it('rejects a non-Ed25519 private key', () => {
    signer.signAccessEvent(event, timestamp);
    writeFileSync(join(keyDirectory, '1.pem'), generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const before = fileState();

    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('not Ed25519');
    expect(fileState()).toEqual(before);
  });

  it('refuses signing inside an existing transaction', () => {
    db.exec('BEGIN');
    try {
      expect(() => signer.signAccessEvent(event, timestamp)).toThrow('outside an existing');
      expect(existsSync(keyDirectory)).toBe(false);
    } finally {
      db.exec('ROLLBACK');
    }
  });

  it('verifies historical role snapshots but checks the current role when signing', () => {
    const data = signer.signAccessEvent(event, timestamp);
    db.prepare('UPDATE users SET role = ? WHERE id = 1').run('nurse');

    expect(signer.verifyAccessEvent(data, timestamp)).toBe(true);
    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('role');
  });

  it('does not create a key to verify an unknown or unregistered user', () => {
    const pair = generateKeyPairSync('ed25519');
    const data = {
      ...event,
      signature: sign(null, Buffer.from(JSON.stringify({ ...event, timestamp })), pair.privateKey).toString('base64'),
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    };

    expect(signer.verifyAccessEvent(data, timestamp)).toBe(false);
    expect(signer.verifyAccessEvent({ ...data, userId: 999 }, timestamp)).toBe(false);
    expect(existsSync(keyDirectory)).toBe(false);
    expect(registeredKey()).toBeNull();
  });

  it('does not change blocks, files or registered keys during verification', () => {
    const data = signer.signAccessEvent(event, timestamp);
    const block = new Blockchain('node-3001').addBlock(data, timestamp);
    const beforeBlock = JSON.stringify(block);
    const beforeFiles = fileState();
    const publicKey = registeredKey();
    Object.freeze(block.data);
    Object.freeze(block);

    expect(signer.verifyAccessEvent(block.data, block.timestamp)).toBe(true);
    expect(signer.verifyAccessEvent({ ...data, signature: 'bad' }, timestamp)).toBe(false);
    expect(signer.verifyAccessEvent({ ...data, text: 'not allowed' }, timestamp)).toBe(false);
    expect(signer.verifyAccessEvent(null, timestamp)).toBe(false);
    expect(JSON.stringify(block)).toBe(beforeBlock);
    expect(fileState()).toEqual(beforeFiles);
    expect(registeredKey()).toBe(publicKey);
    unlinkSync(join(keyDirectory, '1.pem'));
    expect(signer.verifyAccessEvent(data, timestamp)).toBe(true);
    expect(readdirSync(keyDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('uses restrictive permissions and rejects unsafe files/symlinks', () => {
    signer.signAccessEvent(event, timestamp);
    const file = join(keyDirectory, '1.pem');
    expect(statSync(keyDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('unsafe');
    chmodSync(file, 0o600);
    const saved = join(directory, 'saved.pem');
    writeFileSync(saved, readFileSync(file), { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(saved, file);
    expect(() => signer.signAccessEvent(event, timestamp)).toThrow('unsafe');
  });
});
