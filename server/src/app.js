import cors from 'cors';
import express from 'express';

export function createApp(config) {
  const app = express();

  // Klienten skickar med JWT-cookien (credentials: 'include'),
  // så origin måste anges uttryckligen, inte '*'.
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, port: config.port, nodeId: config.nodeId });
  });

  return app;
}
