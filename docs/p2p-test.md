# P2P synchronization verification

## Scope

Verification for #40 and #42, integrating #90 with persistence from #92 (including #91).
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

Observed on Windows / Node 24.21.0 on 2026-09-24: 306 tests passed, two skipped across eleven test files.
The skipped tests are platform-specific checks from the existing suite. These are automated results, not
a claim of a completed manual two-computer demo.

## Manual demo using a fresh disposable database

1. Preserve any existing database and key directory. Set both demo env files to
   the same new `DB_PATH`, matching `JWT_SECRET`, the same `PEER_SECRET`, distinct
   `NODE_ID`/`PORT`, and each other's `PEER_URL`.
2. Start node A only. Log in using `doctor1` / `demo1234` and read patient 1 via
   `GET /api/patients/1` with the returned cookie. This creates A's first block.
3. Start node B. Confirm `chain:response from <A>: accepted` in B's terminal.
4. Query `/api/patients/1/access-log` on B with an authenticated cookie. A's read
   should appear with A's node ID and `verified: true`.
5. Read patient 1 on both servers. Query both access-log endpoints and compare
   the IDs: both should contain all reads, each once. Reading the access-log
   endpoint itself does not create a new block.

## Full process restart verification (#42)

`p2p-restart.test.js` runs the real production entry point against one temporary
SQLite database and separate persisted node chains. It performs simultaneous
HTTP reads on both nodes, kills node B, logs another read on A, restarts B and
checks both APIs contain all three verified entries. B's saved chain remains
identical. A new read on B continues at index 2 with the prior block hash.
The test then kills A, logs on B, restarts A and checks both APIs contain the
same five unique verified entries. Both directions preserve history.

This branch depends on unmerged #90 and #92 (which depends on #91). It does not
change Mats' persistence implementation; only README integration conflicts were
resolved. The result is a localhost backend/P2P test, not a two-computer or
frontend live-note demonstration. Keep the dependency PRs ahead of this PR.

Peer hello identity is not authenticated (#22). Signature validation checks
against registered user keys, but does not prove the sending node's identity.
Use the existing trusted demo network. Payloads also remain subject to the
Socket.IO message-size limit; chunked large-history synchronization is not part
of this implementation.
