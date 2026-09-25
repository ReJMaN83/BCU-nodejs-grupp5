import { createHash, timingSafeEqual } from 'node:crypto';
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

// Hashing first gives equal-length buffers, so the comparison takes the same
// time whatever the length of the supplied secret.
function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// Each node both accepts connections and connects to its configured peer.
export function createPeer(httpServer, {
  nodeId, peerUrl, url, getChainLength, receiveBlock, getChain, receiveChain,
  logger = console, peerSecret, clientOrigin, attachClients, receiveNote,
}) {
  const socketServer = new Server(httpServer, {
    cors: { origin: clientOrigin, credentials: true },
  });
  attachClients?.(socketServer.of('/'));
  const peerNamespace = socketServer.of('/peers');
  peerNamespace.use((socket, next) => {
    // Without PEER_SECRET no peer is accepted, instead of every peer.
    if (!sameSecret(socket.handshake.auth?.peerSecret, peerSecret)) {
      return next(new Error('Peer authentication required'));
    }
    next();
  });
  const hello = () => ({ nodeId, url, chainLength: getChainLength() });
  const connections = new Map();
  const requests = new Map();
  const refreshRequests = new Set();

  function clearRequest(socket) {
    clearTimeout(requests.get(socket));
    requests.delete(socket);
    refreshRequests.delete(socket);
  }

  function requestChain(socket, refresh = false) {
    if (!receiveChain || !getChain || !socket.connected || !connections.has(socket)) return;
    if (requests.has(socket)) {
      if (refresh) refreshRequests.add(socket);
      return;
    }
    const timeout = setTimeout(() => {
      requests.delete(socket);
      requestChain(socket);
    }, 5000);
    timeout.unref?.();
    requests.set(socket, timeout);
    socket.emit('chain:request', { nodeId });
  }

  function attach(socket) {
    socket.on('note:created', (message) => {
      const sender = connections.get(socket);
      if (sender && peerSecret && receiveNote) {
        try { receiveNote(message, sender); }
        catch (error) { logger.warn(`[${nodeId}] note:created rejected: ${error.message}`); }
      }
    });
    socket.on('peer:hello', (message) => {
      receiveHello(message);
      if (validHello(message) && message.nodeId !== nodeId) {
        connections.set(socket, message.nodeId);
        requestChain(socket);
      } else {
        connections.delete(socket);
        clearRequest(socket);
      }
    });
    socket.on('disconnect', () => {
      connections.delete(socket);
      clearRequest(socket);
    });
    socket.on('chain:request', (message) => {
      const sender = connections.get(socket);
      if (!sender || message?.nodeId !== sender || !getChain) return;
      try {
        socket.emit('chain:response', { nodeId, chain: getChain() });
      } catch (error) {
        logger.warn(`[${nodeId}] cannot send chain: ${error.message}`);
      }
    });
    socket.on('chain:response', (message) => {
      const sender = connections.get(socket);
      if (!sender || !requests.has(socket) || !receiveChain) return;
      const refresh = refreshRequests.has(socket);
      clearRequest(socket);
      try {
        const result = receiveChain(message, sender);
        logger.log(`[${nodeId}] chain:response from ${sender}: ${result}`);
      } catch (error) {
        logger.warn(`[${nodeId}] chain:response rejected: ${error.message}`);
      }
      if (refresh) requestChain(socket);
    });
    socket.on('block:new', (message) => {
      const sender = connections.get(socket);
      if (!sender || !receiveBlock) return;
      try {
        const result = receiveBlock(message, sender);
        logger.log(`[${nodeId}] block:new from ${sender}: ${result}`);
        if (result === 'missing-history' || result === 'invalid') requestChain(socket, true);
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

  peerNamespace.on('connection', (socket) => {
    attach(socket);
    socket.emit('peer:hello', hello());
  });

  let client;
  if (peerUrl) {
    client = io(`${peerUrl.replace(/\/$/, '')}/peers`, {
      autoConnect: false, reconnection: true, auth: { peerSecret },
    });
    attach(client);
    client.on('connect', () => client.emit('peer:hello', hello()));
    client.on('connect_error', (error) => {
      logger.warn(`[${nodeId}] cannot connect to ${peerUrl}: ${error.message}; retrying`);
    });
    client.connect();
  }

  let closing;
  return {
    broadcastNote(message) {
      // Local clients are served by note-events; without a secret there are no peers.
      if (!peerSecret) return;
      if (message.originNodeId !== nodeId) throw new Error('Only local notes may be broadcast');
      const sent = new Set();
      for (const [socket, remoteNodeId] of connections) {
        if (!socket.connected || sent.has(remoteNodeId)) continue;
        socket.emit('note:created', message);
        sent.add(remoteNodeId);
      }
    },
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
        for (const socket of requests.keys()) clearRequest(socket);
        client?.disconnect();
        // Socket.IO also closes the underlying HTTP server.
        closing = new Promise((resolve) => socketServer.close(resolve));
      }
      return closing;
    },
  };
}
