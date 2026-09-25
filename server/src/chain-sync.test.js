import { createServer } from 'node:http';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Blockchain } from './blockchain.js';
import { createPeerChains } from './peer-chains.js';
import { createPeer } from './peer.js';

const running = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((peer) => peer.close()));
});

function node(nodeId) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const chain = new Blockchain(nodeId);
  return {
    nodeId, chain, publicKey,
    add() {
      const timestamp = new Date().toISOString();
      const data = { userId: 1, role: 'doctor', patientId: 1, action: 'read' };
      const signature = sign(null, Buffer.from(JSON.stringify({ ...data, timestamp })), privateKey).toString('base64');
      return chain.addBlock({ ...data, signature, publicKey: pem }, timestamp);
    },
  };
}

function verifier(key) {
  return (data, timestamp) => {
    const { userId, role, patientId, action } = data;
    return verify(null, Buffer.from(JSON.stringify({ userId, role, patientId, action, timestamp })),
      key, Buffer.from(data.signature, 'base64'));
  };
}

async function connect(local, remoteUrl) {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const logger = { log: vi.fn(), warn: vi.fn() };
  const peer = createPeer(server, {
    nodeId: local.nodeId, url, peerUrl: remoteUrl,
    getChainLength: () => local.chain.chain.length,
    getChain: () => structuredClone(local.chain.chain),
    receiveBlock: local.replicas.receive, receiveChain: local.replicas.receiveChain, logger,
    peerSecret: 'peer-test-secret',
  });
  running.push(peer);
  return { peer, url, logger };
}

it('preserves both owners histories across transport loss and catches up missing blocks', async () => {
  const a = node('node-a');
  const b = node('node-b');
  a.replicas = createPeerChains(a.nodeId, verifier(b.publicKey));
  b.replicas = createPeerChains(b.nodeId, verifier(a.publicKey));
  a.add();
  b.add();
  const first = await connect(a);
  const second = await connect(b, first.url);
  await vi.waitFor(() => {
    expect(a.replicas.getChain(b.nodeId)).toEqual(b.chain.chain);
    expect(b.replicas.getChain(a.nodeId)).toEqual(a.chain.chain);
  }, { timeout: 5000 });

  // Miss index 2 deliberately, then receive index 3: triggers chain:request.
  a.add();
  first.peer.broadcastBlock(a.add());
  await vi.waitFor(() => {
    expect(second.logger.log).toHaveBeenCalledWith(expect.stringContaining('missing-history'));
    expect(b.replicas.getChain(a.nodeId)).toEqual(a.chain.chain);
  }, { timeout: 5000 });

  // Disconnect the transport while retaining both owners' in-memory histories.
  await second.peer.close();
  a.add();
  b.add();
  const reconnected = await connect(b, first.url);
  await vi.waitFor(() => {
    expect(a.replicas.getChain(b.nodeId)).toEqual(b.chain.chain);
    expect(b.replicas.getChain(a.nodeId)).toEqual(a.chain.chain);
  }, { timeout: 5000 });

  // Both nodes create and broadcast independently after reconnection.
  first.peer.broadcastBlock(a.add());
  reconnected.peer.broadcastBlock(b.add());
  await vi.waitFor(() => {
    expect(a.replicas.getChain(b.nodeId)).toEqual(b.chain.chain);
    expect(b.replicas.getChain(a.nodeId)).toEqual(a.chain.chain);
  }, { timeout: 5000 });
  expect(a.chain.chain).toHaveLength(6);
  expect(b.chain.chain).toHaveLength(4);
}, 20000);
