import { Router } from 'express';
import {
  clearAuthCookie,
  findUserByUsername,
  setAuthCookie,
  toPublicUser,
  userFromRequest,
  verifyPassword,
} from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ message: 'username och password krävs' });
  }

  const user = findUserByUsername(username);
  // Samma svar oavsett om användaren saknas eller lösenordet är fel.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ message: 'Fel användarnamn eller lösenord' });
  }

  setAuthCookie(res, user);
  return res.json(toPublicUser(user));
});

authRouter.get('/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Inte inloggad' });

  return res.json(toPublicUser(user));
});

authRouter.post('/logout', (req, res) => {
  clearAuthCookie(res);
  return res.status(204).end();
});
