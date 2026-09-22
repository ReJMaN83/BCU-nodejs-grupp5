import { createAccessLog } from './access-log.js';
import { config } from './config.js';
import { db, dbFile } from './db.js';
import { chainFilePath } from './chain-storage.js';

export const chain = createAccessLog(config.nodeId, db, `${dbFile}.keys`, chainFilePath(dbFile, config.nodeId));
