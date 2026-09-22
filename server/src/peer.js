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
  nodeId, peerUrl, url, getChainLength, receiveBlock, logger = console,
}) {
  const socketServer = new Server(httpServer);
  const hello = () => ({ nodeId, url, chainLength: getChainLength() });
  const connections = new Map();

  function attach(socket) {
    socket.on('peer:hello', (message) => {
      receiveHello(message);
      if (validHello(message) && message.nodeId !== nodeId) {
        connections.set(socket, message.nodeId);
      } else {
        connections.delete(socket);
      }
    });
    socket.on('disconnect', () => connections.delete(socket));
    socket.on('block:new', (message) => {
      const sender = connections.get(socket);
      if (!sender || !receiveBlock) return;
      try {
        const result = receiveBlock(message, sender);
        logger.log(`[${nodeId}] block:new from ${sender}: ${result}`);
      } catch (error) {
        logger.warn(`[${nodeId}] block:new rejected: ${error.message}`);
      }
    });
  }

  function receiveHello(message) {
    if (!validHello(message) || message.nodeId === nodeId) {
      logger.warn(`[${nodeId}] ignored invalid or self peer:hello`);
      return;
    }
    logger.log(`[${nodeId}] peer:hello from ${message.nodeId} (${message.url}), chainLength=${message.chainLength}`);
  }

  socketServer.on('connection', (socket) => {
    attach(socket);
    socket.emit('peer:hello', hello());
  });

  let client;
  if (peerUrl) {
    client = io(peerUrl, { autoConnect: false, reconnection: true });
    attach(client);
    client.on('connect', () => client.emit('peer:hello', hello()));
    client.on('connect_error', (error) => {
      logger.warn(`[${nodeId}] cannot connect to ${peerUrl}: ${error.message}; retrying`);
    });
    client.connect();
  }

  let closing;
  return {
    broadcastBlock(block) {
      if (block.nodeId !== nodeId) throw new Error('Only local blocks may be broadcast');
      // Reciprocal peer connections are normal. Send once per known node.
      const sent = new Set();
      for (const [socket, remoteNodeId] of connections) {
        if (!socket.connected || sent.has(remoteNodeId)) continue;
        socket.emit('block:new', { nodeId, block });
        sent.add(remoteNodeId);
      }
      return sent.size;
    },
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
