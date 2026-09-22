import { chain } from './chain.js';
import { createAccessSigner } from './access-signing.js';
import { db, dbFile } from './db.js';

// Egen signer-instans för verifiering. Den skapar inga nycklar, utan läser
// användarens registrerade publika nyckel (Mats modul, #12).
const signer = createAccessSigner(db, `${dbFile}.keys`);

// Läsindex av kedjan enligt docs/database.sql. Kedjan är sanningen, den här
// raden finns för att slippa gå igenom alla block.
const insertAccessLog = db.prepare(`
  INSERT INTO access_logs (block_hash, node_id, block_index, user_id, patient_id, action, timestamp)
  VALUES (@blockHash, @nodeId, @blockIndex, @userId, @patientId, @action, @timestamp)
`);

const selectUserName = db.prepare('SELECT display_name AS name FROM users WHERE id = ?');

export function recordAccess({ user, patientId, action }) {
  // Eventet får bara innehålla de fyra fälten; modulen signerar och sätter
  // tidsstämpel. Anropas utanför pågående SQL-transaktion.
  const block = chain.addAccessLog({
    userId: user.id,
    role: user.role,
    patientId,
    action,
  });

  insertAccessLog.run({
    blockHash: block.hash,
    nodeId: block.nodeId,
    blockIndex: block.index,
    userId: block.data.userId,
    patientId: block.data.patientId,
    action: block.data.action,
    timestamp: block.timestamp,
  });

  // TODO (#39): skicka blocket vidare till peers med block:new när
  // broadcast-koden finns. Inget anrop görs härifrån än.
  return block;
}

// Middleware som loggar en lyckad journalåtkomst. Loggen skrivs först när
// svaret gått iväg med 200, så nekade anrop (401/403) och okända patienter
// (404) inte hamnar i kedjan.
export function auditLogger(action) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode !== 200) return;

      try {
        recordAccess({ user: req.user, patientId: req.patientId, action });
      } catch (err) {
        // Svaret är redan skickat. Logga tydligt i stället för att krascha.
        console.error(`[audit] could not log ${action} for patient ${req.patientId}:`, err.message);
      }
    });

    next();
  };
}

// Accessloggen byggs av kedjan, filtrerad på patient och sorterad nyaste först
// (docs/kontrakt.md, beslut d). TODO (#40): slå ihop med peerns kedjor när
// chain-sync finns. I dag visas bara den egna nodens kedja.
export function accessLogFor(patientId) {
  return chain.blockchain.chain
    .filter((block) => block.data && block.data.patientId === patientId)
    .map((block) => ({
      id: `${block.nodeId}-${block.index}`,
      userId: block.data.userId,
      name: selectUserName.get(block.data.userId)?.name ?? null,
      role: block.data.role,
      action: block.data.action,
      timestamp: block.timestamp,
      nodeId: block.nodeId,
      verified: isVerified(block),
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function isVerified(block) {
  try {
    return chain.blockchain.isValid() && signer.verifyAccessEvent(block.data, block.timestamp);
  } catch {
    return false;
  }
}
