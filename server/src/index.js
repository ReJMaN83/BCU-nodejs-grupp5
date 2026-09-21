import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp(config);

app.listen(config.port, () => {
  console.log(`[${config.nodeId}] lyssnar på http://localhost:${config.port}`);
  console.log(`[${config.nodeId}] peer: ${config.peerUrl ?? '(ingen)'}`);
});
