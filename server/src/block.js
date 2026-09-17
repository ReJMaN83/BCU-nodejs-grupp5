import { createHash } from 'node:crypto';

const dataFields = ['userId', 'role', 'patientId', 'action', 'signature', 'publicKey'];
const roles = ['lakare', 'sjukskoterska', 'vardcentral', 'patient', 'obehorig'];

export function validateAccessEventFields({ userId, role, patientId, action }) {
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(patientId)) {
    throw new TypeError('userId and patientId must be integers');
  }
  if (!roles.includes(role) || !['read', 'write'].includes(action)) {
    throw new TypeError('Invalid access-event role or action');
  }
}

export function validateBlockData(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError('data must be an access-event object');
  }
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('data must be a plain access-event object');
  }

  const keys = Reflect.ownKeys(data);
  if (keys.length !== dataFields.length || Object.keys(data).length !== dataFields.length
    || keys.some((key) => !dataFields.includes(key))) {
    throw new TypeError('data must contain exactly the six access-event fields');
  }
  if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(data, key), 'value'))) {
    throw new TypeError('data fields must be stored values');
  }

  validateAccessEventFields(data);
  const { signature, publicKey } = data;
  if (typeof signature !== 'string' || signature.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new TypeError('signature must be a base64 string');
  }
  if (typeof publicKey !== 'string'
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(publicKey)) {
    throw new TypeError('publicKey must be a public-key PEM string');
  }
}

export function validateTimestamp(timestamp) {
  if (typeof timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) {
    throw new TypeError('timestamp must be a valid ISO timestamp in UTC');
  }
}

export function validateBlockFields({ index, timestamp, nodeId, prevHash, data }) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('index must be a non-negative integer');
  }
  if (typeof nodeId !== 'string' || typeof prevHash !== 'string' || !nodeId || !prevHash) {
    throw new TypeError('nodeId and prevHash must be non-empty strings');
  }
  validateTimestamp(timestamp);
  if (index === 0) {
    if (prevHash !== '0' || data !== null) {
      throw new TypeError('Genesis requires prevHash "0" and data null');
    }
  } else {
    validateBlockData(data);
  }
}

export function calculateBlockHash({ index, timestamp, nodeId, prevHash, data }) {
  return createHash('sha256')
    .update(index + timestamp + nodeId + prevHash + JSON.stringify(data))
    .digest('hex');
}

export class Block {
  constructor({ index, timestamp, nodeId, prevHash, data }) {
    validateBlockFields({ index, timestamp, nodeId, prevHash, data });
    this.index = index;
    this.timestamp = timestamp;
    this.nodeId = nodeId;
    this.prevHash = prevHash;
    if (data === null) {
      this.data = null;
    } else {
      const { userId, role, patientId, action, signature, publicKey } = data;
      this.data = { userId, role, patientId, action, signature, publicKey };
    }
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return calculateBlockHash(this);
  }
}
