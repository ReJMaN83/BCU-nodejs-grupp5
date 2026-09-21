-- Databasschema för journalsystemet (#18)
--
-- Båda servrarna på samma dator delar den här SQLite-filen i WAL-läge
-- (docs/kontrakt.md, beslut a). Scriptet går att köra om: det tar bort
-- tabellerna och skapar dem på nytt med seed-data.
--
-- Konventioner:
-- - Heltals-id (INTEGER PRIMARY KEY).
-- - Tider sparas som ISO 8601-text i UTC, t.ex. '2026-09-12T12:32:00.000Z'.
-- - Kolumnerna heter snake_case här och camelCase i API:t
--   (full_name -> fullName, personal_id -> personalId osv.).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS access_logs;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS patients;

-- patients: de personer som har en journal. Svaret från GET /api/patients
-- och GET /api/patients/:id byggs härifrån.
CREATE TABLE patients (
  id          INTEGER PRIMARY KEY,
  full_name   TEXT NOT NULL,
  personal_id TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- users: alla som kan logga in. role följer kontraktets rollnamn.
-- linked_patient_id pekar på patientens egen journal och är satt bara för
-- rollen patient. public_key är användarens Ed25519-nyckel (PEM, SPKI) för
-- att verifiera signaturer i kedjan. Den är NULL tills nyckelparet skapats (#12).
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL
                    CHECK (role IN ('doctor', 'nurse', 'clinic', 'patient', 'unauthorized')),
  linked_patient_id INTEGER REFERENCES patients (id) ON DELETE SET NULL,
  public_key        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (role = 'patient' OR linked_patient_id IS NULL)
);

-- notes: journalanteckningar. Innehållet finns bara här och skickas via
-- socket, aldrig in i kedjan (kontrakt, beslut c). visibility styr vem som
-- ser anteckningen, och servern filtrerar innan svaret skickas.
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users (id),
  text       TEXT NOT NULL CHECK (length(trim(text)) > 0),
  visibility TEXT NOT NULL DEFAULT 'staff'
             CHECK (visibility IN ('private', 'staff', 'everyone')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_notes_patient_created ON notes (patient_id, created_at DESC);

-- access_logs: läsindex av blockkedjorna så att GET /api/patients/:id/access-log
-- slipper gå igenom alla block. Kedjan är sanningen: en rad läggs till när ett
-- block läggs till i en kedja (egen eller peerns), och tabellen kan byggas om
-- från kedjorna. block_index behövs för id:t "<nodeId>-<index>" i API-svaret.
CREATE TABLE access_logs (
  id          INTEGER PRIMARY KEY,
  block_hash  TEXT NOT NULL UNIQUE,
  node_id     TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users (id),
  patient_id  INTEGER NOT NULL REFERENCES patients (id),
  action      TEXT NOT NULL CHECK (action IN ('read', 'write')),
  timestamp   TEXT NOT NULL,
  UNIQUE (node_id, block_index)
);

CREATE INDEX idx_access_logs_patient_time ON access_logs (patient_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- Seed-data (bara för utveckling)
--
-- Patienter och anteckningar motsvarar Fattmas mockdata i
-- client/src/api/mockPatients.js och mockPatientDetails.js
-- ('p1' -> 1, 'n1' -> 11 osv.). Personnumren är samma som där och har
-- avsiktligt fel kontrollsiffra, så de tillhör inga riktiga personer.
-- ---------------------------------------------------------------------------

INSERT INTO patients (id, full_name, personal_id, created_at) VALUES
  (1, 'Anna Karlsson',   '19850312-4521', '2026-09-01T08:00:00.000Z'),
  (2, 'Erik Johansson',  '19921107-8834', '2026-09-01T08:00:00.000Z'),
  (3, 'Maria Lindqvist', '19760822-1190', '2026-09-01T08:00:00.000Z'),
  (4, 'Johan Bergström', '19901215-6672', '2026-09-01T08:00:00.000Z'),
  (5, 'Sara Nilsson',    '19881030-3345', '2026-09-01T08:00:00.000Z');

-- En användare per roll. Lösenordet är 'demo1234' för alla.
-- password_hash har formatet scrypt$<salt hex>$<hash hex>
-- (node:crypto scryptSync, 64 byte). Nyckelpar skapas i #12.
INSERT INTO users (id, username, password_hash, display_name, role, linked_patient_id, created_at) VALUES
  (1, 'doctor1',
      'scrypt$16c5af7cfd134347b0ba621e5b744b62$7f8990c5f064b240be1363a29e695722dd951eb42c876cd49392ec2e31d11f11f70bab52db11744c211685907b55011416924f0bf27eadde8e3cae7c4c03bc34',
      'Dr. Lindberg', 'doctor', NULL, '2026-09-01T08:00:00.000Z'),
  (2, 'nurse1',
      'scrypt$4f1dac20d8c163a901c73ec16773adcc$f0bf9bc0ee4f9f388917b3d10ffac6692a3bd08e0ff0a6bbd3200a36ee2d06a1aa4be21454b422900b0ba47a633c511483f71baf319b3b3619dbd11673f24cbf',
      'Nurse Åström', 'nurse', NULL, '2026-09-01T08:00:00.000Z'),
  (3, 'clinic1',
      'scrypt$4cb26d3a88bb7676d19c2ad03b0d0bee$c49be4714f18795fd427b31c7f0d8ea0bb678df9488f6dd2b9bceacf411580267c9e4110f76cd5cdcf5608ffd53218f124050ba9bee50fb662ef85f40759034b',
      'Vårdcentralen Centrum', 'clinic', NULL, '2026-09-01T08:00:00.000Z'),
  (4, 'patient1',
      'scrypt$b6dc2f5e20555e1e98dbc7330bbcf7e9$e74156bda18cb181cad91d1c2e01c1d0af810c6af58d195cecd85c21e9958c4221844d9af296b36a2e045b26198518c0589f1391f7a838d862f93f9246d4d1cb',
      'Anna Karlsson', 'patient', 1, '2026-09-01T08:00:00.000Z'),
  (5, 'unauthorized1',
      'scrypt$fa04f481d48a4422ebf0979413739fb4$907455d30788d14fa72bb1a435bbed0ba78f00009a7b1eb3e6bed41557feff6a743e8da0ece609d952c681c569e0b7174c4ff65c34eb0f1b957aa9543f1d5a1b',
      'Obehörig Testsson', 'unauthorized', NULL, '2026-09-01T08:00:00.000Z');

-- Mockdatans tider saknar tidszon och tolkas som svensk sommartid (UTC+2).
INSERT INTO notes (id, patient_id, author_id, text, visibility, created_at) VALUES
  (11, 1, 1, 'Patient reports improved mobility after physical therapy. Follow-up in 3 weeks.',
      'everyone', '2026-09-12T12:32:00.000Z'),
  (12, 1, 1, 'Internal note: consider referral to specialist if no improvement by next visit.',
      'private',  '2026-09-10T07:15:00.000Z'),
  (13, 1, 2, 'Blood pressure and vitals recorded, all within normal range.',
      'staff',    '2026-09-08T14:50:00.000Z');

-- access_logs seedas inte. Raderna måste motsvara riktiga, signerade block,
-- annars går de inte att verifiera. De fylls på när någon öppnar en journal.
