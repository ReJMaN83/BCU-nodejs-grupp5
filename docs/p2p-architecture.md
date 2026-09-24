# Two-node demo and architecture (#53)

## Architecture

```mermaid
flowchart LR
  C1[Browser: server 1] -->|HTTP and session cookie| S1[Server 1 / node-3001]
  C2[Browser: server 2] -->|HTTP and session cookie| S2[Server 2 / node-3002]
  S1 <-->|Socket.IO: hello, blocks, chain sync| S2
  S1 --> DB[(Shared SQLite: users, patients, notes, access index)]
  S2 --> DB
  S1 --> A[Own chain A and read-only replica B]
  S2 --> B[Own chain B and read-only replica A]
  S1 -.->|Authorized note events: integration pending| C1
  S2 -.->|Authorized note events: integration pending| C2
```

Each server writes only its own chain. A received chain is a separate validated
replica; it never replaces the receiver's local chain. Journal text stays in
SQLite, not in blocks. Blocks contain access-event IDs, role, action, timestamp
and cryptographic verification material. The access log combines known chains.

Solid arrows show the #22/#39/#40 implementation. Live notes (#41) still require
the backend note-save hook and frontend integration. Persistence is provided by
Mats' PR #92, not by this documentation branch. Review and merge dependencies
before demonstrating their combined behavior.

## Safe local setup (Windows PowerShell)

Use two server processes on one computer with one shared SQLite file. Do not
delete an existing database, keys or chain files. A new `DB_PATH` creates an
independent demo using the current English seed accounts.

From the repository root, install locked dependencies:

```powershell
npm ci --prefix server --ignore-scripts
npm ci --prefix client
npm test --prefix server
```

The `--ignore-scripts` option is the verified workaround for this Windows
installation's unnecessary better-sqlite3 build step. It uses the bundled binary;
the tests must pass before proceeding. It is not a global npm setting.

Create `.env.3001` and `.env.3002` in `server/` from `.env.example` if they do not
already exist. Compare before editing an existing file. Set these values:

| Setting | `.env.3001` | `.env.3002` |
| --- | --- | --- |
| `PORT` | `3001` | `3002` |
| `NODE_ID` | `node-3001` | `node-3002` |
| `NODE_URL` | `http://localhost:3001` | `http://localhost:3002` |
| `PEER_URL` | `http://localhost:3002` | `http://localhost:3001` |
| `DB_PATH` | `../data/demo-v39.db` (choose a new path) | Same exact path |
| `JWT_SECRET` | New local random secret | Same secret |
| `CLIENT_ORIGIN` | `http://localhost:5173` | `http://localhost:5174` |

Once #41's server integration is included, also set the same random `PEER_SECRET`
on both servers. Keep it server-side; never put it in a `VITE_` variable.

Start each server in a separate terminal from the repository root:

```powershell
npm run dev:3001 --prefix server
```

```powershell
npm run dev:3002 --prefix server
```

Check `http://localhost:3001/api/health` and `http://localhost:3002/api/health`.
Both should report `ok: true`, the correct node ID and five seeded patients for a
new database. Wait for `peer:hello` and successful chain responses. Initial retry
messages while the other server is not running are expected.

## Two frontend instances (when API integration is ready)

Run each command in its own PowerShell terminal from the repository root:

```powershell
$env:VITE_API_URL = 'http://localhost:3001'
npm run dev --prefix client -- --port 5173 --strictPort
```

```powershell
$env:VITE_API_URL = 'http://localhost:3002'
npm run dev --prefix client -- --port 5174 --strictPort
```

Use separate browser profiles/private sessions for different roles: cookies on
localhost are shared across ports. On this baseline, patient views still contain
mock data; starting Vite is not evidence that real notes or live events work.
Use API tests until the frontend integration has been reviewed.

## Demo order and checks

1. Show health and peer hello on both nodes.
2. Log in with a fresh seed account (`doctor1`, password `demo1234`), read a real
   patient through the API and show the signed access entry on both nodes.
3. Explain that `verified` checks the chain and registered user signature; it
   does not prove clinical correctness or authenticate the remote node itself.
4. With #92 and the #42 integration test included, restart a peer and show that
   stored history survives and missed access entries are synchronized.
5. Show live notes only after the note POST endpoint and frontend are integrated.

Stop each process with Ctrl+C. Keep database, `.keys` and (with #92) `.chains`
storage together for backup; no private files or node_modules belong in a PR.
For reproducible automated evidence, see [p2p-test.md](p2p-test.md).

## Different computers

The agreed demo uses a shared SQLite file on one computer. Two computers with
independent database files do not automatically share notes, users or trusted
public keys. Changing only `PEER_URL` does not implement database replication.
Agree a supported database deployment with the group before a two-computer demo.
Set node and peer URLs to reachable addresses, and client origins to the actual
browser origins. Do not claim the localhost tests verify this deployment.
