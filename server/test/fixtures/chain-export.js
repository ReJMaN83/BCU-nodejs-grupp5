import { chain } from '../../src/chain.js';
import { db, dbFile } from '../../src/db.js';
import { createAccessSigner } from '../../src/access-signing.js';

try {
  const blockchain = chain.blockchain;
  const event = { userId: 1, role: 'doctor', patientId: 2, action: 'read' };
  const read = chain.addAccessLog(event);
  const { chain: repeatedImport } = await import('../../src/chain.js');
  const write = repeatedImport.addAccessLog({ ...event, action: 'write' });
  const signing = createAccessSigner(db, `${dbFile}.keys`);

  console.log(JSON.stringify({
    sameExport: chain === repeatedImport,
    sameBlockchain: repeatedImport.blockchain === blockchain,
    returnedStoredBlocks: blockchain.chain[1] === read && blockchain.chain[2] === write,
    nodeId: blockchain.nodeId,
    dbFile,
    indexes: blockchain.chain.map((block) => block.index),
    validChain: blockchain.isValid(),
    validSignatures: [read, write].map((block) => signing.verifyAccessEvent(block.data, block.timestamp)),
  }));
} finally {
  db.close();
}
