import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { createPeer } from './peer.js';

const peers = [];
const clients = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.disconnect());
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
});

async function start(nodeId, peerUrl, port = 0, getChainLength = () => 1, receiveBlock) {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const logger = { log: vi.fn(), warn: vi.fn() };
  const peer = createPeer(server, { nodeId, peerUrl, url, getChainLength, logger, receiveBlock });
  peers.push(peer);
  return { peer, logger, url, port: server.address().port };
}

it('exchanges hello in both directions and reconnects with current chain length', async () => {
  const first = await start('node-a');
  let length = 2;
  const second = await start('node-b', first.url, 0, () => length);
  await vi.waitFor(() => {
    expect(first.logger.log).toHaveBeenCalledWith(expect.stringContaining('peer:hello from node-b'));
    expect(second.logger.log).toHaveBeenCalledWith(expect.stringContaining('peer:hello from node-a'));
  }, { timeout: 5000 });
  await first.peer.close();
  length = 3;
  const restarted = await start('node-a', undefined, first.port);
  await vi.waitFor(() => {
    expect(restarted.logger.log).toHaveBeenCalledWith(
      `[node-a] peer:hello from node-b (${second.url}), chainLength=3`,
    );
  }, { timeout: 8000 });
}, 15000);

it('rejects malformed and self hellos without losing the connection', async () => {
  const node = await start('node-a');
  const client = io(`${node.url}/peers`, { autoConnect: false });
  clients.push(client);
  const greeting = new Promise((resolve) => client.once('peer:hello', resolve));
  client.connect();
  expect(await greeting).toEqual({ nodeId: 'node-a', url: node.url, chainLength: 1 });
  client.emit('peer:hello', null);
  client.emit('peer:hello', { nodeId: 'node-a', url: node.url, chainLength: 1 });
  client.emit('peer:hello', { nodeId: 'node-b', url: node.url, chainLength: 1 });
  await vi.waitFor(() => {
    expect(node.logger.warn).toHaveBeenCalledTimes(2);
    expect(node.logger.log).toHaveBeenCalledTimes(1);
  });
});

it('supports reciprocal peer URLs even when the other node starts later', async () => {
  const received = vi.fn(() => 'accepted');
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const first = await start('node-a', `http://127.0.0.1:${port}`);
  await vi.waitFor(() => expect(first.logger.warn).toHaveBeenCalled(), { timeout: 3000 });
  const second = await start('node-b', first.url, port, () => 1, received);
  await vi.waitFor(() => {
    expect(first.logger.log).toHaveBeenCalledTimes(2);
    expect(second.logger.log).toHaveBeenCalledTimes(2);
  }, { timeout: 8000 });
  const block = { nodeId: 'node-a', index: 1 };
  expect(first.peer.broadcastBlock(block)).toBe(1);
  await vi.waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith(
    { nodeId: 'node-a', block }, 'node-a',
  ));
  expect(() => second.peer.broadcastBlock(block)).toThrow('Only local blocks');
}, 15000);
