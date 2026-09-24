import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function chainFilePath(dbFile, nodeId) {
  if (typeof dbFile !== 'string' || !dbFile || dbFile === ':memory:') {
    throw new TypeError('Chain persistence requires a database file path');
  }
  const filename = `${createHash('sha256').update(nodeId).digest('hex')}.json`;
  return join(`${resolve(dbFile)}.chains`, filename);
}

export function readChainFile(file) {
  try {
    if (!lstatSync(file).isFile()) {
      throw new Error(`Chain storage must be a regular file: ${file}`);
    }
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function saveChainFile(file, blocks, previousJson) {
  const json = JSON.stringify(blocks);
  const directory = dirname(file);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let fd;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Chain directory must have owner-only access');
    }
    // Do not replace history changed or removed since this instance loaded/saved it.
    if (readChainFile(file) !== previousJson) {
      throw new Error('Chain file changed on disk; refusing to overwrite it');
    }
    fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, json, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Publication is the last fallible operation: no rollback after a successful rename.
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the write error. */ }
    }
    throw new Error(`Could not persist local chain to ${file}: ${error.message}`, { cause: error });
  }
  return json;
}
