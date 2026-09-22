import { Blockchain, verifyChain } from './blockchain.js';
import { createAccessSigner } from './access-signing.js';
import { readChainFile, saveChainFile } from './chain-storage.js';

export function createAccessLog(nodeId, db, keyDirectory, chainFile) {
  const blockchain = new Blockchain(nodeId);
  const signing = createAccessSigner(db, keyDirectory);
  let storedJson = null;

  if (chainFile !== undefined) {
    storedJson = readChainFile(chainFile);
    const rows = db.prepare('SELECT block_index, block_hash FROM access_logs WHERE node_id = ? ORDER BY block_index')
      .all(nodeId);
    if (storedJson === null && rows.length > 0) {
      throw new Error(`Cannot restore local chain: missing file with existing SQL access history for ${nodeId}: ${chainFile}`);
    }
    let blocks = blockchain.chain;
    if (storedJson !== null) {
      try {
        blocks = JSON.parse(storedJson);
      } catch (error) {
        throw new Error(`Cannot restore local chain: invalid JSON in ${chainFile}`, { cause: error });
      }
      const result = verifyChain(blocks, nodeId, signing.verifyAccessEvent);
      if (!result.valid) {
        throw new Error(`Cannot restore local chain from ${chainFile} at position ${result.position}: ${result.reason}`);
      }
    }
    for (const row of rows) {
      if (!Number.isSafeInteger(row.block_index) || row.block_index < 1
        || blocks[row.block_index]?.hash !== row.block_hash) {
        throw new Error(`Cannot restore local chain: SQL access history mismatch for ${nodeId} at index ${row.block_index}`);
      }
    }
    blockchain.chain = blocks;
  }

  function addAccessLog(event) {
    if (!blockchain.isValid()) {
      throw new Error('Cannot append to an invalid chain');
    }
    const timestamp = new Date(Date.now()).toISOString();
    const data = signing.signAccessEvent(event, timestamp);
    const block = blockchain.addBlock(data, timestamp);
    if (chainFile !== undefined) {
      try {
        storedJson = saveChainFile(chainFile, blockchain.chain, storedJson);
      } catch (error) {
        blockchain.chain.pop();
        throw error;
      }
    }
    return block;
  }

  return {
    blockchain,
    addAccessLog,
    verifyChain: (blocks = blockchain.chain) => verifyChain(blocks, nodeId, signing.verifyAccessEvent),
  };
}
