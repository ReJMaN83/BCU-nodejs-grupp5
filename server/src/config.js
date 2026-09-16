import dotenv from 'dotenv';

// Vilken env-fil som läses styrs med --env <fil> (standard: .env).
// Så kan två instanser köras från samma kod: npm run dev:3001 / dev:3002.
const envFlag = process.argv.indexOf('--env');
const envFile = envFlag !== -1 ? process.argv[envFlag + 1] : '.env';

const result = dotenv.config({ path: envFile, quiet: true });
if (result.error) {
  console.error(`Kunde inte läsa ${envFile}. Kopiera .env.example, se README.`);
  process.exit(1);
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`PORT saknas eller är ogiltig i ${envFile}`);
  process.exit(1);
}

export const config = {
  port,
  nodeId: process.env.NODE_ID || `node-${port}`,
  peerUrl: process.env.PEER_URL || null,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
};
