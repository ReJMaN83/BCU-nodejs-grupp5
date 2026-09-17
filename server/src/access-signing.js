import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { validateAccessEventFields, validateBlockData, validateTimestamp } from './block.js';

const eventFields = ['userId', 'role', 'patientId', 'action'];

function validateEvent(event) {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new TypeError('event must be an access-event object');
  }
  const prototype = Object.getPrototypeOf(event);
  const keys = Reflect.ownKeys(event);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== eventFields.length || Object.keys(event).length !== eventFields.length
    || keys.some((key) => !eventFields.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(event, key), 'value'))) {
    throw new TypeError('event must contain only userId, role, patientId and action as stored values');
  }
  validateAccessEventFields(event);
}

function payload({ userId, role, patientId, action }, timestamp) {
  return Buffer.from(JSON.stringify({ userId, role, patientId, action, timestamp }));
}

function publicKeyFromPem(pem) {
  if (typeof pem !== 'string'
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(pem)) {
    throw new Error('Invalid registered public key');
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Public key must be Ed25519');
  }
  return key;
}

function samePublicKey(left, right) {
  return left.export({ type: 'spki', format: 'der' })
    .equals(right.export({ type: 'spki', format: 'der' }));
}

function checkKeyDirectory(directory, create) {
  try {
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error();
    }
  } catch {
    throw new Error('Private key directory is missing or unsafe (requires owner-only access)');
  }
}

function readPrivateKey(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error();
    }
    const pem = readFileSync(fd, 'utf8');
    if (!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\r?\n?$/.test(pem)) {
      throw new Error();
    }
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Private key file is corrupt, unsafe or not Ed25519');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writePrivateKey(directory, file, privateKey) {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A hard link publishes the complete file atomically and never replaces a target.
    linkSync(temporary, file);
    if (process.platform !== 'win32') {
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } catch {
    throw new Error('Could not publish private key file; existing files are never overwritten');
  } finally {
    unlinkSync(temporary);
  }
}

export function createAccessSigner(db, keyDirectory) {
  if (typeof keyDirectory !== 'string' || !keyDirectory) {
    throw new TypeError('An explicit private key directory is required');
  }
  const directory = resolve(keyDirectory);
  const findUser = db.prepare('SELECT id, role, public_key FROM users WHERE id = ?');
  const registerKey = db.prepare('UPDATE users SET public_key = ? WHERE id = ? AND public_key IS NULL');

  const signForUser = db.transaction((event, timestamp) => {
    const user = findUser.get(event.userId);
    if (!user) throw new Error('Unknown user');
    if (user.role !== event.role) throw new Error('Event role does not match the registered user');

    checkKeyDirectory(directory, user.public_key === null);
    const file = join(directory, `${user.id}.pem`);
    let privateKey = readPrivateKey(file);
    if (!privateKey) {
      if (user.public_key !== null) throw new Error('Registered user private key is missing');
      privateKey = generateKeyPairSync('ed25519').privateKey;
      writePrivateKey(directory, file, privateKey);
    }
    const publicKey = createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    if (user.public_key === null) {
      // Also recovers a complete key published before an interrupted SQL commit.
      if (registerKey.run(publicKeyPem, user.id).changes !== 1) {
        throw new Error('Could not register the user public key');
      }
    } else {
      let registeredKey;
      try {
        registeredKey = publicKeyFromPem(user.public_key);
      } catch {
        throw new Error('Registered public key is invalid or not Ed25519');
      }
      if (!samePublicKey(publicKey, registeredKey)) {
        throw new Error('Private key does not match the registered public key');
      }
    }

    const { userId, role, patientId, action } = event;
    const signature = sign(null, payload(event, timestamp), privateKey).toString('base64');
    return { userId, role, patientId, action, signature, publicKey: publicKeyPem };
  });

  function signAccessEvent(event, timestamp) {
    validateEvent(event);
    validateTimestamp(timestamp);
    if (db.inTransaction) {
      throw new Error('Signing must start outside an existing database transaction');
    }
    // SQLite serializes key creation across processes sharing this database.
    return signForUser.immediate(event, timestamp);
  }

  function verifyAccessEvent(data, timestamp) {
    try {
      validateBlockData(data);
      validateTimestamp(timestamp);
      if (Buffer.from(data.signature, 'base64').toString('base64') !== data.signature) return false;
      const user = findUser.get(data.userId);
      if (!user || user.public_key === null) return false;
      const registeredKey = publicKeyFromPem(user.public_key);
      const suppliedKey = publicKeyFromPem(data.publicKey);
      if (!samePublicKey(registeredKey, suppliedKey)) return false;
      return verify(null, payload(data, timestamp), registeredKey, Buffer.from(data.signature, 'base64'));
    } catch {
      return false;
    }
  }

  return { signAccessEvent, verifyAccessEvent };
}
