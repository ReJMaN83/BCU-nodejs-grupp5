import { Block, calculateBlockHash, validateBlockFields } from './block.js';

const genesisTimestamp = '1970-01-01T00:00:00.000Z';
const blockFields = ['index', 'timestamp', 'nodeId', 'prevHash', 'hash', 'data'];

function invalid(position, reason) {
  return { valid: false, position, reason };
}

function validateChain(chain, nodeId, verifyAccessEvent) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return invalid(null, 'Chain must be a non-empty array');
  }
  if (typeof nodeId !== 'string' || !nodeId) {
    return invalid(null, 'Expected nodeId must be a non-empty string');
  }

  for (let position = 0; position < chain.length; position += 1) {
    try {
      const block = chain[position];
      if (typeof block !== 'object' || block === null || Array.isArray(block)) {
        return invalid(position, 'Invalid block object');
      }
      const prototype = Object.getPrototypeOf(block);
      if (prototype !== Block.prototype && prototype !== Object.prototype && prototype !== null) {
        return invalid(position, 'Invalid block prototype');
      }
      const keys = Reflect.ownKeys(block);
      if (keys.length !== blockFields.length || Object.keys(block).length !== blockFields.length
        || keys.some((key) => !blockFields.includes(key))) {
        return invalid(position, 'Block must contain exactly the six block fields');
      }
      if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(block, key), 'value'))) {
        return invalid(position, 'Block fields must be stored values');
      }
      validateBlockFields(block);
      if (block.index !== position) {
        return invalid(position, 'Invalid block index');
      }
      if (block.nodeId !== nodeId) {
        return invalid(position, 'Unexpected nodeId');
      }
      if (position === 0) {
        if (block.timestamp !== genesisTimestamp) {
          return invalid(position, 'Invalid genesis timestamp');
        }
      } else if (block.prevHash !== chain[position - 1].hash) {
        return invalid(position, 'Invalid prevHash');
      }
      if (typeof block.hash !== 'string' || block.hash !== calculateBlockHash(block)) {
        return invalid(position, 'Invalid block hash');
      }
      if (position > 0 && verifyAccessEvent && verifyAccessEvent(block.data, block.timestamp) !== true) {
        return invalid(position, 'Invalid access-event signature');
      }
    } catch {
      return invalid(position, 'Invalid block fields or verification failure');
    }
  }
  return { valid: true, position: null, reason: null };
}

// Pass the expected node identity and the verifier from createAccessSigner.
export function verifyChain(chain, nodeId, verifyAccessEvent) {
  if (typeof verifyAccessEvent !== 'function') {
    throw new TypeError('verifyAccessEvent must be a trusted signature verifier');
  }
  return validateChain(chain, nodeId, verifyAccessEvent);
}

export class Blockchain {
  #nodeId;

  constructor(nodeId) {
    const genesis = new Block({
      index: 0,
      timestamp: genesisTimestamp,
      nodeId,
      prevHash: '0',
      data: null,
    });
    this.#nodeId = nodeId;
    this.chain = [genesis];
  }

  get nodeId() {
    return this.#nodeId;
  }

  addBlock(data, timestamp) {
    if (!this.isValid()) {
      throw new Error('Cannot append to an invalid chain');
    }
    const block = new Block({
      index: this.chain.length,
      timestamp,
      nodeId: this.#nodeId,
      prevHash: this.chain[this.chain.length - 1].hash,
      data,
    });
    this.chain.push(block);
    return block;
  }

  isValid(chain = this.chain) {
    return validateChain(chain, this.#nodeId).valid;
  }
}
