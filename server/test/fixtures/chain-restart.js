import { chain } from '../../src/chain.js';
import { db } from '../../src/db.js';
import { recordAccess } from '../../src/audit-logger.js';

try {
  const before = structuredClone(chain.blockchain.chain);
  const count = Number(process.argv[2]);
  for (let index = 0; index < count; index += 1) {
    recordAccess({ user: { id: 1, role: 'doctor' }, patientId: 2, action: 'read' });
  }
  console.log(JSON.stringify({
    before,
    after: chain.blockchain.chain,
    verification: chain.verifyChain(),
    chainLength: chain.blockchain.chain.length,
    snapshot: structuredClone(chain.blockchain.chain),
  }));
} finally {
  db.close();
}
