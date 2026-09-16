import { createApp } from './app.js';
import { config } from './config.js';
import { db, dbFile, schemaCreated } from './db.js';

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[${config.nodeId}] lyssnar på http://localhost:${config.port}`);
  console.log(`[${config.nodeId}] peer: ${config.peerUrl ?? '(ingen)'}`);
  console.log(`[${config.nodeId}] databas: ${dbFile}${schemaCreated ? ' (skapad med seed)' : ''}`);
});

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
