import { Server } from 'socket.io';
import { io } from 'socket.io-client';

function validHello(message) {
  if (!message || typeof message.nodeId !== 'string' || !message.nodeId.trim()
    || !Number.isSafeInteger(message.chainLength) || message.chainLength < 1
    || typeof message.url !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(message.url).protocol);
  } catch {
    return false;
  }
}

// Each node both accepts connections and connects to its configured peer.
export function createPeer(httpServer, {
  nodeId, peerUrl, url, getChainLength, logger = console,
}) {
  const socketServer = new Server(httpServer);
  const hello = () => ({ nodeId, url, chainLength: getChainLength() });

  function receiveHello(message) {
    if (!validHello(message) || message.nodeId === nodeId) {
      logger.warn(`[${nodeId}] ignored invalid or self peer:hello`);
      return;
    }
    logger.log(`[${nodeId}] peer:hello from ${message.nodeId} (${message.url}), chainLength=${message.chainLength}`);
  }

  socketServer.on('connection', (socket) => {
    socket.on('peer:hello', receiveHello);
    socket.emit('peer:hello', hello());
  });

  let client;
  if (peerUrl) {
    client = io(peerUrl, { autoConnect: false, reconnection: true });
    client.on('peer:hello', receiveHello);
    client.on('connect', () => client.emit('peer:hello', hello()));
    client.on('connect_error', (error) => {
      logger.warn(`[${nodeId}] cannot connect to ${peerUrl}: ${error.message}; retrying`);
    });
    client.connect();
  }

  let closing;
  return {
    close() {
      if (!closing) {
        client?.disconnect();
        // Socket.IO also closes the underlying HTTP server.
        closing = new Promise((resolve) => socketServer.close(resolve));
      }
      return closing;
    },
  };
}
