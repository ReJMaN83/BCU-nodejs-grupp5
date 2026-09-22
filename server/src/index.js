import { createApp } from './app.js';
import { config } from './config.js';
import { db, dbFile, schemaCreated } from './db.js';
import { chain } from './chain.js';
import { createPeer } from './peer.js';

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[${config.nodeId}] listening on http://localhost:${config.port}`);
  console.log(`[${config.nodeId}] peer: ${config.peerUrl ?? '(none)'}`);
  console.log(`[${config.nodeId}] database: ${dbFile}${schemaCreated ? ' (created with seed data)' : ''}`);
});

const peer = createPeer(server, {
  nodeId: config.nodeId,
  peerUrl: config.peerUrl,
  url: config.nodeUrl,
  getChainLength: () => chain.blockchain.chain.length,
});

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
