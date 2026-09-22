import { createApp } from './app.js';
import { config } from './config.js';
import { db, dbFile, schemaCreated } from './db.js';
import { chain } from './chain.js';
import { createPeer } from './peer.js';
import { createPeerChains } from './peer-chains.js';
import { createAccessSigner } from './access-signing.js';
import { setBlockBroadcaster } from './audit-logger.js';

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[${config.nodeId}] listening on http://localhost:${config.port}`);
  console.log(`[${config.nodeId}] peer: ${config.peerUrl ?? '(none)'}`);
  console.log(`[${config.nodeId}] database: ${dbFile}${schemaCreated ? ' (created with seed data)' : ''}`);
});

const signer = createAccessSigner(db, `${dbFile}.keys`);
const peerChains = createPeerChains(config.nodeId, signer.verifyAccessEvent);
const peer = createPeer(server, {
  nodeId: config.nodeId,
  peerUrl: config.peerUrl,
  url: config.nodeUrl,
  getChainLength: () => chain.blockchain.chain.length,
  receiveBlock: peerChains.receive,
});
setBlockBroadcaster(peer.broadcastBlock);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await peer.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
