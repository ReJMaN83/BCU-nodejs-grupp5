import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(serverDir, '../docs/database.sql');
const TABLES = ['patients', 'users', 'notes', 'access_logs'];

// Öppnar databasen och skapar schema + seed om tabellerna saknas.
// Relativa sökvägar utgår från server/, så båda instanserna hamnar på samma fil
// oavsett varifrån de startas. ':memory:' fungerar för tester.
export function openDatabase(dbPath) {
  const file = dbPath === ':memory:' ? dbPath : resolve(serverDir, dbPath);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  // Den andra instansen väntar i stället för att få SQLITE_BUSY direkt.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const created = initSchema(db);
  return { db, file, created };
}

// BEGIN IMMEDIATE tar skrivlåset innan kontrollen, så två instanser som startar
// samtidigt inte båda kör scriptet (det börjar med DROP TABLE).
function initSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`)
      .all(...TABLES)
      .map((row) => row.name);

    if (existing.length === TABLES.length) {
      db.exec('COMMIT');
      return false;
    }
    if (existing.length > 0) {
      throw new Error(
        `Databasen har bara en del av tabellerna (${existing.join(', ')}). ` +
          'Ta bort filen så skapas den på nytt från docs/database.sql.',
      );
    }

    db.exec(readFileSync(schemaPath, 'utf8'));
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const opened = openDatabase(config.dbPath);

export const db = opened.db;
export const dbFile = opened.file;
export const schemaCreated = opened.created;
