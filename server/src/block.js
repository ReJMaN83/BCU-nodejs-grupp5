import { createHash } from 'node:crypto';

const dataFields = ['userId', 'role', 'patientId', 'action', 'signature', 'publicKey'];
const roles = ['lakare', 'sjukskoterska', 'vardcentral', 'patient', 'obehorig'];

function createData(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError('data must be an access-event object');
  }

  const keys = Reflect.ownKeys(data);
  if (keys.length !== dataFields.length || keys.some((key) => !dataFields.includes(key))) {
    throw new TypeError('data must contain exactly the six access-event fields');
  }

  const { userId, role, patientId, action, signature, publicKey } = data;
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(patientId)) {
    throw new TypeError('userId and patientId must be integers');
  }
  if (!roles.includes(role) || !['read', 'write'].includes(action)) {
    throw new TypeError('Invalid access-event role or action');
  }
  if (typeof signature !== 'string' || signature.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new TypeError('signature must be a base64 string');
  }
  if (typeof publicKey !== 'string'
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(publicKey)) {
    throw new TypeError('publicKey must be a public-key PEM string');
  }

  return { userId, role, patientId, action, signature, publicKey };
}

export class Block {
  constructor({ index, timestamp, nodeId, prevHash, data }) {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new TypeError('index must be a non-negative integer');
    }
    if (typeof timestamp !== 'string' || typeof nodeId !== 'string'
      || typeof prevHash !== 'string' || !timestamp || !nodeId || !prevHash) {
      throw new TypeError('timestamp, nodeId and prevHash must be non-empty strings');
    }
    if (index === 0 && (prevHash !== '0' || data !== null)) {
      throw new TypeError('Genesis requires prevHash "0" and data null');
    }

    this.index = index;
    this.timestamp = timestamp;
    this.nodeId = nodeId;
    this.prevHash = prevHash;
    this.data = index === 0 ? null : createData(data);
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return createHash('sha256')
      .update(this.index + this.timestamp + this.nodeId + this.prevHash + JSON.stringify(this.data))
      .digest('hex');
  }
}
