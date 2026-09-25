# P2P synchronization verification

## Scope

Verification for #40, providing a basis for the broader scenario in #42.
Each node owns one chain and stores read-only copies of directly connected
peers' chains. There is no shared writable chain and no longest-chain selection.

## Automated checks

Run `npm test` from `server/`. Tests use temporary databases or in-memory state,
ephemeral local ports and generated test keys. They do not open the demo database.

| Scenario | Evidence |
| --- | --- |
| Node A logs before node B starts | `block-broadcast.test.js` starts two real server processes sequentially, creates a signed read on A before B starts, then verifies it appears in B's access-log API |
| Both nodes create their own signed reads | The same test logs on both nodes and verifies that both APIs return all three expected IDs with `verified: true` |
| Missing predecessor | `chain-sync.test.js` withholds a block, sends the following one, observes `missing-history` and checks the recovered complete chain |
| Transport outage with both owners retaining their chains | The test closes B's transport, adds a signed block on each owner, reconnects B and compares each replica with its owner's complete chain |
| Both nodes broadcast after reconnect | Both owners append and broadcast independently; all entries survive in the replicas |
| Stale response | `peer-chains.test.js` delivers an older valid snapshot after a newer one and verifies no truncation |
| Invalid signature, wrong owner or conflicting history | Complete response is rejected without modifying the previously accepted replica |
| Read-only copies | Mutating a returned snapshot does not modify stored replicas |

Observed on 2026-09-22: 202 tests passed, one skipped across eight test files.
The skipped test is from the existing suite. These are automated results, not
a claim of a completed manual two-computer demo.

## Manual demo using a fresh disposable database

1. Preserve any existing database and key directory. Set both demo env files to
   the same new `DB_PATH`, matching `JWT_SECRET`, distinct `NODE_ID`/`PORT`, and
   each other's `PEER_URL`.
2. Start node A only. Log in using `doctor1` / `demo1234` and read patient 1 via
   `GET /api/patients/1` with the returned cookie. This creates A's first block.
3. Start node B. Confirm `chain:response from <A>: accepted` in B's terminal.
4. Query `/api/patients/1/access-log` on B with an authenticated cookie. A's read
   should appear with A's node ID and `verified: true`.
5. Read patient 1 on both servers. Query both access-log endpoints and compare
   the IDs: both should contain all reads, each once. Reading the access-log
   endpoint itself does not create a new block.

## Remaining boundary for #42 and persistence

The transport-outage test keeps the owner's chain in memory. It is not a test
of recovering an owner's own chain after killing its process. Local-chain
persistence is #30. Restarting an owner currently resets its local chain and
can reuse indices already present in the shared SQL index. Sync preserves a
peer's longer replica but does not restore or overwrite the owner's own chain.
Do not close #42 on the assumption that process-restart recovery is implemented.

Peer hello identity is not authenticated (#22). Signature validation checks
against registered user keys, but does not prove the sending node's identity.
Use the existing trusted demo network. Payloads also remain subject to the
Socket.IO message-size limit; chunked large-history synchronization is not part
of this implementation.
