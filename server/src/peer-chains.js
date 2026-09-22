import { Blockchain } from './blockchain.js';

// Replicas are private; callers receive snapshots, never writable chain storage.
export function createPeerChains(localNodeId, verifyAccessEvent) {
  const replicas = new Map();
  return {
    receive(message, peerNodeId) {
      try {
        const { nodeId, block } = message ?? {};
        if (typeof nodeId !== 'string' || !nodeId.trim() || nodeId === localNodeId
          || nodeId !== peerNodeId || block?.nodeId !== nodeId
          || !Number.isSafeInteger(block.index) || block.index < 1) return 'invalid';
        const replica = replicas.get(nodeId) ?? new Blockchain(nodeId);
        const existing = replica.chain[block.index];
        if (existing) {
          return JSON.stringify(existing) === JSON.stringify(block) ? 'duplicate' : 'invalid';
        }
        if (block.index !== replica.chain.length) return 'missing-history';
        const candidate = [...replica.chain, block];
        if (!replica.isValid(candidate) || !verifyAccessEvent(block.data, block.timestamp)) {
          return 'invalid';
        }
        replica.chain.push(structuredClone(block));
        replicas.set(nodeId, replica);
        return 'accepted';
      } catch {
        return 'invalid';
      }
    },
    getChain(nodeId) {
      return structuredClone(replicas.get(nodeId)?.chain ?? []);
    },
  };
}
