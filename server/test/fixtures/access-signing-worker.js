import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createAccessSigner } from '../../src/access-signing.js';

let db;
let signer;
let keyDirectory;

process.on('message', (message) => {
  try {
    if (message.type === 'init') {
      db = new Database(message.databaseFile, { timeout: 5000 });
      keyDirectory = message.keyDirectory;
      signer = createAccessSigner(db, keyDirectory);
      process.send({ type: 'ready' });
    } else if (message.type === 'sign') {
      process.send({ type: 'attempting' });
      const data = signer.signAccessEvent(message.event, message.timestamp);
      const inode = statSync(join(keyDirectory, `${data.userId}.pem`)).ino;
      db.close();
      process.send({ type: 'result', data, inode, pid: process.pid });
      process.disconnect();
    }
  } catch (error) {
    if (db?.open) db.close();
    process.send({ type: 'error', message: error.message });
    process.disconnect();
    process.exitCode = 1;
  }
});
