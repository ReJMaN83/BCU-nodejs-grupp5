import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessLog } from './access-log.js';
import { createAccessSigner } from './access-signing.js';
import { calculateBlockHash } from './block.js';
import { chainFilePath } from './chain-storage.js';

// Real filesystem operations except for explicitly injected write failures.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    writeFileSync: vi.fn(fs.writeFileSync),
    fsyncSync: vi.fn(fs.fsyncSync),
    renameSync: vi.fn(fs.renameSync),
  };
});
const realFs = await vi.importActual('node:fs');
const schema = readFileSync(new URL('../../docs/database.sql', import.meta.url), 'utf8');
const restartFixture = fileURLToPath(new URL('../test/fixtures/chain-restart.js', import.meta.url));
const nodeId = 'node-3001';
const event = { userId: 1, role: 'doctor', patientId: 2, action: 'read' };
let directory;
let dbFile;
let keyDirectory;
let chainFile;
let db;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bcu-chain-storage-'));
  dbFile = join(directory, 'test.db');
  keyDirectory = `${dbFile}.keys`;
  chainFile = chainFilePath(dbFile, nodeId);
  db = new Database(dbFile);
  db.exec(schema);
});

afterEach(() => {
  vi.clearAllMocks();
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function openChain(id = nodeId) {
  return createAccessLog(id, db, keyDirectory, chainFilePath(dbFile, id));
}

function twoBlocks() {
  const chain = openChain();
  chain.addAccessLog(event);
  chain.addAccessLog({ ...event, action: 'write' });
  return chain;
}

function indexBlock(block) {
  db.prepare(`INSERT INTO access_logs
    (block_hash, node_id, block_index, user_id, patient_id, action, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(block.hash, block.nodeId, block.index, block.data.userId,
      block.data.patientId, block.data.action, block.timestamp);
}

function processOptions() {
  const envFile = join(directory, 'test.env');
  writeFileSync(envFile, `PORT=3009\nNODE_ID=${nodeId}\nDB_PATH=${dbFile}\nJWT_SECRET=restart-test-secret\n`);
  const env = { ...process.env };
  for (const name of ['PORT', 'NODE_ID', 'DB_PATH', 'JWT_SECRET', 'PEER_URL', 'CLIENT_ORIGIN']) delete env[name];
  return { envFile, options: { cwd: directory, env, encoding: 'utf8', timeout: 10000 } };
}

describe('local chain persistence', () => {
  it('starts with genesis only when both chain file and local SQL history are absent', () => {
    const chain = openChain();
    expect(chain.blockchain.chain).toHaveLength(1);
    expect(chain.verifyChain().valid).toBe(true);
    expect(existsSync(chainFile)).toBe(false);
    expect(existsSync(keyDirectory)).toBe(false);
  });

  it('restores the exact signed chain after reopening the database and continues its indexes', () => {
    const original = twoBlocks();
    const saved = JSON.stringify(original.blockchain.chain);
    indexBlock(original.blockchain.chain[1]);
    indexBlock(original.blockchain.chain[2]);
    db.close();
    db = new Database(dbFile);

    const restored = openChain();
    expect(JSON.stringify(restored.blockchain.chain)).toBe(saved);
    const block = restored.addAccessLog(event);
    expect(block.index).toBe(3);
    expect(block.prevHash).toBe(original.blockchain.chain[2].hash);
    expect(restored.verifyChain().valid).toBe(true);
    expect(JSON.parse(readFileSync(chainFile, 'utf8'))).toEqual(JSON.parse(JSON.stringify(restored.blockchain.chain)));
    expect(openChain().blockchain.chain[3]).toEqual(block);
  });

  it('restores the production chain export across two separate Node processes', () => {
    const { envFile, options } = processOptions();
    const first = JSON.parse(execFileSync(process.execPath, [restartFixture, '2', '--env', envFile], options));
    const second = JSON.parse(execFileSync(process.execPath, [restartFixture, '1', '--env', envFile], options));

    expect(first.before).toHaveLength(1);
    expect(second.before).toEqual(first.after);
    expect(second.after.map((block) => block.index)).toEqual([0, 1, 2, 3]);
    expect(second.after[3].prevHash).toBe(first.after[2].hash);
    expect(second.verification).toEqual({ valid: true, position: null, reason: null });
    // These are the reads used by #90's getChainLength and getChain callbacks.
    expect(second.chainLength).toBe(4);
    expect(second.snapshot).toEqual(second.after);
    expect(db.prepare('SELECT count(*) AS count FROM access_logs WHERE node_id = ?').get(nodeId).count).toBe(3);
    expect(JSON.parse(readFileSync(chainFile, 'utf8'))).toEqual(second.after);
  });

  it('keeps two nodes in separate files while sharing one database and key directory', () => {
    const first = twoBlocks();
    indexBlock(first.blockchain.chain[1]);
    const second = openChain('node-3002');
    second.addAccessLog(event);
    indexBlock(second.blockchain.chain[1]);

    expect(openChain().blockchain.chain).toEqual(first.blockchain.chain);
    expect(openChain('node-3002').blockchain.chain).toEqual(second.blockchain.chain);
    expect(readdirSync(dirname(chainFile)).sort()).toEqual([
      basename(chainFile), basename(chainFilePath(dbFile, 'node-3002')),
    ].sort());
    expect(first.blockchain.chain[1].data.publicKey).toBe(second.blockchain.chain[1].data.publicKey);
  });

  it.each(['../../outside', '/absolute/path', 'A', 'a', 'node:3001', 'x'.repeat(500)])(
    'uses a bounded safe filename for nodeId %s', (id) => {
      const file = chainFilePath(dbFile, id);
      expect(dirname(file)).toBe(`${dbFile}.chains`);
      expect(basename(file)).toMatch(/^[a-f0-9]{64}\.json$/);
      expect(file).not.toBe(chainFilePath(dbFile, `${id}-other`));
    },
  );

  it('preserves stored field order and timestamp text through restore, save and reload', () => {
    const signing = createAccessSigner(db, keyDirectory);
    const chain = createAccessLog(nodeId, db, keyDirectory);
    const timestamp = '2026-09-18T09:15:02.1Z';
    const block = chain.blockchain.addBlock(signing.signAccessEvent(event, timestamp), timestamp);
    block.data = Object.fromEntries(Object.entries(block.data).reverse());
    block.hash = calculateBlockHash(block);
    const savedBlock = JSON.stringify(block);
    mkdirSync(dirname(chainFile), { mode: 0o700 });
    writeFileSync(chainFile, JSON.stringify(chain.blockchain.chain), { mode: 0o600 });

    const restored = openChain();
    restored.addAccessLog(event);
    const reloaded = openChain();
    expect(JSON.stringify(reloaded.blockchain.chain[1])).toBe(savedBlock);
    expect(reloaded.blockchain.chain[1].timestamp).toBe(timestamp);
    expect(reloaded.verifyChain().valid).toBe(true);
  });

  it('restores using only registered public keys without recreating private key files', () => {
    const chain = twoBlocks();
    const users = db.prepare('SELECT id, public_key FROM users').all();
    rmSync(keyDirectory, { recursive: true });
    expect(openChain().blockchain.chain).toEqual(chain.blockchain.chain);
    expect(existsSync(keyDirectory)).toBe(false);
    expect(db.prepare('SELECT id, public_key FROM users').all()).toEqual(users);
  });

  it.each(['hash', 'data', 'signature', 'nodeId'])(
    'rejects altered %s without overwriting or resetting the file', (kind) => {
      twoBlocks();
      const blocks = JSON.parse(readFileSync(chainFile, 'utf8'));
      if (kind === 'hash') blocks[1].hash = '0'.repeat(64);
      if (kind === 'data' || kind === 'signature') blocks[1].data.patientId = 99;
      if (kind === 'nodeId') blocks.forEach((block) => { block.nodeId = 'other-node'; });
      if (kind === 'signature' || kind === 'nodeId') {
        for (let index = 0; index < blocks.length; index += 1) {
          if (index > 0) blocks[index].prevHash = blocks[index - 1].hash;
          blocks[index].hash = calculateBlockHash(blocks[index]);
        }
      }
      const corrupted = JSON.stringify(blocks);
      writeFileSync(chainFile, corrupted);
      expect(() => openChain()).toThrow(kind === 'signature' ? /signature/ : /Cannot restore local chain/);
      expect(readFileSync(chainFile, 'utf8')).toBe(corrupted);
    },
  );

  it.each(['', '[{"index":0', '{', '[]', 'null'])(
    'rejects corrupt, truncated or malformed JSON: %j', (json) => {
      twoBlocks();
      writeFileSync(chainFile, json);
      expect(() => openChain()).toThrow(/Cannot restore local chain/);
      expect(readFileSync(chainFile, 'utf8')).toBe(json);
    },
  );

  it('fails production startup on a corrupt chain file', () => {
    twoBlocks();
    writeFileSync(chainFile, '[');
    const { envFile, options } = processOptions();
    const result = spawnSync(process.execPath, [restartFixture, '1', '--env', envFile], options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot restore local chain: invalid JSON');
    expect(result.stdout).toBe('');
    expect(readFileSync(chainFile, 'utf8')).toBe('[');
  });

  it('refuses missing chain storage when local SQL history already exists', () => {
    const chain = twoBlocks();
    indexBlock(chain.blockchain.chain[1]);
    rmSync(chainFile);
    expect(() => openChain()).toThrow(/missing file with existing SQL access history/);
    expect(existsSync(chainFile)).toBe(false);
  });

  it.each(['hash', 'later index', 'genesis index'])(
    'rejects a SQL %s mismatch with the restored chain', (kind) => {
      const chain = twoBlocks();
      indexBlock(chain.blockchain.chain[1]);
      const saved = readFileSync(chainFile, 'utf8');
      if (kind === 'hash') db.prepare('UPDATE access_logs SET block_hash = ?').run('bad');
      else db.prepare('UPDATE access_logs SET block_index = ?').run(kind === 'later index' ? 3 : 0);
      expect(() => openChain()).toThrow(/SQL access history mismatch/);
      expect(readFileSync(chainFile, 'utf8')).toBe(saved);
    },
  );

  it('rejects a valid but shortened chain when SQL remembers its later block', () => {
    const chain = twoBlocks();
    indexBlock(chain.blockchain.chain[2]);
    const truncated = JSON.stringify(chain.blockchain.chain.slice(0, 2));
    writeFileSync(chainFile, truncated);
    expect(() => openChain()).toThrow(/SQL access history mismatch.*index 2/);
    expect(readFileSync(chainFile, 'utf8')).toBe(truncated);
  });

  it('allows the chain to be ahead of SQL without rebuilding the SQL index', () => {
    const chain = twoBlocks();
    indexBlock(chain.blockchain.chain[1]);
    expect(openChain().blockchain.chain).toEqual(chain.blockchain.chain);
    expect(db.prepare('SELECT block_index FROM access_logs').all()).toEqual([{ block_index: 1 }]);
  });

  it.each(['altered', 'shortened'])('refuses an append after persisted history is %s in memory', (kind) => {
    const chain = twoBlocks();
    chain.blockchain.chain.slice(1).forEach(indexBlock);
    const saved = readFileSync(chainFile, 'utf8');
    const rows = db.prepare('SELECT * FROM access_logs ORDER BY id').all();
    const blocks = chain.blockchain.chain;
    if (kind === 'altered') {
      blocks[1].data.patientId = 99;
      for (let index = 1; index < blocks.length; index += 1) {
        blocks[index].prevHash = blocks[index - 1].hash;
        blocks[index].hash = calculateBlockHash(blocks[index]);
      }
    } else {
      blocks.pop();
    }
    const before = JSON.stringify(blocks);
    expect(chain.blockchain.isValid()).toBe(true);
    expect(chain.verifyChain().valid).toBe(kind === 'shortened');

    expect(() => indexBlock(chain.addAccessLog(event))).toThrow(/Cannot append/);

    expect(chain.blockchain.chain).toBe(blocks);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(readFileSync(chainFile, 'utf8')).toBe(saved);
    expect(db.prepare('SELECT * FROM access_logs ORDER BY id').all()).toEqual(rows);
    const restored = openChain();
    expect(restored.verifyChain().valid).toBe(true);
    const next = restored.addAccessLog(event);
    expect(next.index).toBe(3);
    expect(next.prevHash).toBe(JSON.parse(saved)[2].hash);
    indexBlock(next);
    expect(openChain().verifyChain().valid).toBe(true);
    expect(db.prepare('SELECT count(*) AS count FROM access_logs').get().count).toBe(3);
  });

  it.each(['partial write', 'fsync', 'rename'])('rolls back only the new block after a failed %s', (failure) => {
    const chain = twoBlocks();
    const originalArray = chain.blockchain.chain;
    const before = JSON.stringify(originalArray);
    const saved = readFileSync(chainFile, 'utf8');
    if (failure === 'partial write') {
      vi.mocked(writeFileSync).mockImplementationOnce((fd) => {
        realFs.writeFileSync(fd, 'partial');
        throw new Error('Injected write failure');
      });
    } else {
      vi.mocked(failure === 'fsync' ? fsyncSync : renameSync).mockImplementationOnce(() => {
        throw new Error('Injected persistence failure');
      });
    }

    expect(() => chain.addAccessLog(event)).toThrow(/Could not persist local chain/);
    expect(chain.blockchain.chain).toBe(originalArray);
    expect(JSON.stringify(originalArray)).toBe(before);
    expect(readFileSync(chainFile, 'utf8')).toBe(saved);
    expect(readdirSync(dirname(chainFile))).toEqual([basename(chainFile)]);
    expect(chain.addAccessLog(event).index).toBe(3);
    expect(openChain().verifyChain().valid).toBe(true);
  });

  it('rolls back the first block when no chain file can be published', () => {
    const chain = openChain();
    writeFileSync(dirname(chainFile), 'not a directory');
    expect(() => chain.addAccessLog(event)).toThrow(/Could not persist local chain/);
    expect(chain.blockchain.chain).toHaveLength(1);
    expect(chain.verifyChain().valid).toBe(true);
    expect(existsSync(chainFile)).toBe(false);
  });

  it.each(['corrupt', 'missing'])('does not replace a %s file after the instance has started', (kind) => {
    const chain = twoBlocks();
    const before = JSON.stringify(chain.blockchain.chain);
    if (kind === 'corrupt') writeFileSync(chainFile, '[');
    else rmSync(chainFile);
    expect(() => chain.addAccessLog(event)).toThrow(/Chain file changed on disk/);
    expect(JSON.stringify(chain.blockchain.chain)).toBe(before);
    if (kind === 'corrupt') expect(readFileSync(chainFile, 'utf8')).toBe('[');
    else expect(existsSync(chainFile)).toBe(false);
  });

  it('refuses to overwrite a snapshot written by another instance since loading', () => {
    const first = twoBlocks();
    const stale = openChain();
    first.addAccessLog(event);
    const saved = readFileSync(chainFile, 'utf8');
    expect(() => stale.addAccessLog(event)).toThrow(/Chain file changed on disk/);
    expect(stale.blockchain.chain).toHaveLength(3);
    expect(readFileSync(chainFile, 'utf8')).toBe(saved);
  });

  it('publishes complete JSON and leaves no temporary files after each successful append', () => {
    const chain = twoBlocks();
    expect(readdirSync(dirname(chainFile))).toEqual([basename(chainFile)]);
    expect(JSON.parse(readFileSync(chainFile, 'utf8'))).toEqual(JSON.parse(JSON.stringify(chain.blockchain.chain)));
    if (process.platform !== 'win32') {
      expect(statSync(dirname(chainFile)).mode & 0o777).toBe(0o700);
      expect(statSync(chainFile).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a dangling symlink instead of treating it as missing history', () => {
    mkdirSync(dirname(chainFile), { mode: 0o700 });
    symlinkSync(join(directory, 'missing.json'), chainFile);
    expect(() => openChain()).toThrow(/must be a regular file/);
    expect(realFs.lstatSync(chainFile).isSymbolicLink()).toBe(true);
  });
});
