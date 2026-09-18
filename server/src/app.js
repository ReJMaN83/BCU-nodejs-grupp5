import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { db } from './db.js';
import { authRouter } from './routes/auth.js';

const countPatients = db.prepare('SELECT count(*) AS count FROM patients');

export function createApp(config) {
  const app = express();

  // Klienten skickar med JWT-cookien (credentials: 'include'),
  // så origin måste anges uttryckligen, inte '*'.
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/auth', authRouter);

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      port: config.port,
      nodeId: config.nodeId,
      patients: countPatients.get().count,
    });
  });

  return app;
}
