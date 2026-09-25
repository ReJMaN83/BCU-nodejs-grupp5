import { createApp } from './app.js';
import { config } from './config.js';
import { db, dbFile, schemaCreated } from './db.js';
import { chain } from './chain.js';
import { createPeer } from './peer.js';
import { createPeerChains } from './peer-chains.js';
import { createAccessSigner } from './access-signing.js';
import { setBlockBroadcaster, setPeerChainReader } from './audit-logger.js';
import cookieParser from 'cookie-parser';
import { userFromRequest } from './auth.js';
import { createNoteEvents } from './note-events.js';
import { setNotePublisher } from './notes-live.js';

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[${config.nodeId}] listening on http://localhost:${config.port}`);
  console.log(`[${config.nodeId}] peer: ${config.peerUrl ?? '(none)'}`);
  console.log(`[${config.nodeId}] database: ${dbFile}${schemaCreated ? ' (created with seed data)' : ''}`);
});

const signer = createAccessSigner(db, `${dbFile}.keys`);
const peerChains = createPeerChains(config.nodeId, signer.verifyAccessEvent);
const parseCookies = cookieParser();
const notes = createNoteEvents({ nodeId: config.nodeId, db, authenticate: (request) => {
  parseCookies(request, {}, () => {});
  return userFromRequest(request);
} });
const peer = createPeer(server, {
  nodeId: config.nodeId,
  peerUrl: config.peerUrl,
  url: config.nodeUrl,
  getChainLength: () => chain.blockchain.chain.length,
  receiveBlock: peerChains.receive,
  getChain: () => structuredClone(chain.blockchain.chain),
  receiveChain: peerChains.receiveChain,
  peerSecret: config.peerSecret,
  clientOrigin: config.clientOrigin,
  attachClients: notes.attach,
  receiveNote: notes.receive,
});
notes.setBroadcaster(peer.broadcastNote);
// Own clients get note:created even without peers; broadcastNote skips peers then.
setNotePublisher(notes.publish);
setBlockBroadcaster(peer.broadcastBlock);
setPeerChainReader(peerChains.getChains);

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
