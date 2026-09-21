import { userFromRequest } from './auth.js';

export const STAFF_ROLES = ['doctor', 'nurse', 'clinic'];

// Lägger den inloggade användaren på req.user, eller svarar 401.
// Klienten visar login vid 401 och access denied vid 403 (docs/kontrakt.md).
export function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Not authenticated' });

  req.user = user;
  return next();
}

// Kräver att den inloggade har en av rollerna. Används efter requireAuth.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
  };
}
