import { Blockchain } from './blockchain.js';
import { createAccessSigner } from './access-signing.js';

export function createAccessLog(nodeId, db, keyDirectory) {
  const blockchain = new Blockchain(nodeId);
  const signing = createAccessSigner(db, keyDirectory);

  function addAccessLog(event) {
    if (!blockchain.isValid()) {
      throw new Error('Cannot append to an invalid chain');
    }
    const timestamp = new Date(Date.now()).toISOString();
    const data = signing.signAccessEvent(event, timestamp);
    return blockchain.addBlock(data, timestamp);
  }

  return { blockchain, addAccessLog };
}
