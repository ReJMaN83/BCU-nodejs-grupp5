import { Block, calculateBlockHash, validateBlockFields } from './block.js';

const genesisTimestamp = '1970-01-01T00:00:00.000Z';
const blockFields = ['index', 'timestamp', 'nodeId', 'prevHash', 'hash', 'data'];

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
    if (!Array.isArray(chain) || chain.length === 0) {
      return false;
    }

    try {
      for (let index = 0; index < chain.length; index += 1) {
        const block = chain[index];
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          return false;
        }
        const prototype = Object.getPrototypeOf(block);
        if (prototype !== Block.prototype && prototype !== Object.prototype && prototype !== null) {
          return false;
        }
        const keys = Reflect.ownKeys(block);
        if (keys.length !== blockFields.length || Object.keys(block).length !== blockFields.length
          || keys.some((key) => !blockFields.includes(key))) {
          return false;
        }
        if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(block, key), 'value'))) {
          return false;
        }
        validateBlockFields(block);
        if (block.index !== index || block.nodeId !== this.#nodeId) {
          return false;
        }
        if (index === 0) {
          if (block.timestamp !== genesisTimestamp) {
            return false;
          }
        } else if (block.prevHash !== chain[index - 1].hash) {
          return false;
        }
        if (typeof block.hash !== 'string' || block.hash !== calculateBlockHash(block)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
