import { scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';

const TOKEN_COOKIE = 'token';
const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const selectById = db.prepare('SELECT * FROM users WHERE id = ?');

// Formatet i docs/database.sql: scrypt$<salt hex>$<hash hex>
export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

// Formen som klienten får: { id, role, displayName, linkedPatientId }
export function toPublicUser(row) {
  return {
    id: row.id,
    role: row.role,
    displayName: row.display_name,
    linkedPatientId: row.linked_patient_id,
  };
}

export function findUserByUsername(username) {
  return selectByUsername.get(username);
}

export function findUserById(id) {
  return selectById.get(id);
}

export function setAuthCookie(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: TOKEN_MAX_AGE_MS / 1000,
  });

  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // dev körs över http
    maxAge: TOKEN_MAX_AGE_MS,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}

// Läser cookien och hämtar användaren ur databasen, så att en ändrad eller
// borttagen användare inte kan fortsätta använda en gammal token.
// Rollkontrollerna byggs i #23.
export function userFromRequest(req) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return findUserById(payload.sub) ?? null;
  } catch {
    return null;
  }
}
