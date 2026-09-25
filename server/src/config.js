import dotenv from 'dotenv';

// Vilken env-fil som läses styrs med --env <fil> (standard: .env).
// Så kan två instanser köras från samma kod: npm run dev:3001 / dev:3002.
const envFlag = process.argv.indexOf('--env');
const envFile = envFlag !== -1 ? process.argv[envFlag + 1] : '.env';

const result = dotenv.config({ path: envFile, quiet: true });
if (result.error) {
  console.error(`Could not read ${envFile}. Copy .env.example, see README.`);
  process.exit(1);
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`PORT is missing or invalid in ${envFile}`);
  process.exit(1);
}

// Utan JWT_SECRET går servern igång med ett utvecklingsvärde, men båda
// instanserna måste ha samma hemlighet för att godta varandras cookies.
const DEV_JWT_SECRET = 'dev-secret-byt-i-env';
if (!process.env.JWT_SECRET) {
  console.warn(`JWT_SECRET is missing in ${envFile}, using the development value.`);
}

// Utan PEER_SECRET avvisar /peers alla anslutningar, så ingen synk mellan noderna.
if (!process.env.PEER_SECRET) {
  console.warn(`PEER_SECRET is missing in ${envFile}; all peer connections on /peers will be rejected.`);
}

export const config = {
  port,
  nodeId: process.env.NODE_ID || `node-${port}`,
  peerUrl: process.env.PEER_URL || null,
  peerSecret: process.env.PEER_SECRET || null,
  nodeUrl: process.env.NODE_URL || `http://localhost:${port}`,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  dbPath: process.env.DB_PATH || '../data/journal.db',
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
};
