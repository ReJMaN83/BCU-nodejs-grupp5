# Live notes integration (#41)

## Implemented on this branch

- Browser clients connect to the default Socket.IO namespace, using the existing
  JWT cookie. The server authorizes `join-patient-room` with a numeric patient ID
  (a numeric string is accepted), matching the event already used in PR #95.
- The acknowledgement is `{ ok: true, patientId }` or `{ ok: false, status }`.
  Status is 400 for an invalid ID, 401 for missing authentication, 403 for denied
  access, or 404 for an allowed but nonexistent patient. Successful joins leave
  the prior patient room. `leave-patient-room` leaves the room explicitly.
- Peer traffic uses `/peers`, separate from browser traffic. Configure the same
  random `PEER_SECRET` in both server env files. When set, it is required for
  peer connections. Live note forwarding is disabled without it. Never expose it
  through a `VITE_` variable. Both peers must run this namespace change together.
- Events keep the contract shape `{ originNodeId, note }`. Received note IDs are
  resolved from the shared database: peer-supplied text and visibility are not
  trusted. Delivery checks the current user's JWT, database role, linked patient
  and note visibility each time. No journal text enters the block chain.
- Duplicate forwarding is suppressed in a bounded 1,000-event recent-ID cache.
  Notes are not sent back to peers, and local publishing sends once per peer.

## Backend handoff (Daniel)

The note-creation POST endpoint is still absent from the inspected main and
published branches. This PR deliberately does not implement or replace that work.
After the endpoint has successfully committed the note and handled its signed
write audit event, call:

```js
import { publishCreatedNote } from '../notes-live.js';

publishCreatedNote(savedNote.id);
```

The function accepts a database note ID, not arbitrary request content. Production
startup installs the publisher when `PEER_SECRET` is present. Report/configure a
missing secret before the demo; do not retry a committed note insertion just
because a notification failed. The API needs its own explicit failure handling.
Delivery is best-effort; there is no durable note-event replay queue.

## Frontend handoff (Fattma / PR #95)

The existing event name `join-patient-room` is supported, as is the current
`note:created` payload. Use real numeric patient IDs, not mock IDs such as `p1`.
Register the note listener before joining; rejoin in every `connect` callback:

```js
const join = () => socket.emit('join-patient-room', Number(id), (result) => {
  // Handle !result.ok in the UI (401 => login; 403 => access denied).
});
socket.on('note:created', handleNoteCreated);
socket.on('connect', join);
if (socket.connected) join();
else socket.connect();
// Cleanup: off both handlers and disconnect (or leave-patient-room).
```

Use real API data, reload authorized notes after reconnect to recover missed
notifications, and deduplicate by note ID. PR #95 still uses mock patient data,
the role name `health_center` rather than `clinic`, and a client-only private-note
filter that allows all staff. The server filters correctly here; those frontend
integration gaps must also be resolved before claiming the complete demo works.
The POST success handler should deduplicate too, because the socket event may
arrive before the HTTP response.

## Evidence and remaining acceptance work

`note-events.test.js` runs two real Socket.IO servers against a temporary in-memory
database, with signed test JWTs and the real note-delivery module. It inserts a
committed note to simulate the missing backend endpoint, then confirms delivery
on the second server's browser-protocol clients. It covers `everyone`, `staff`,
`private`, denied patient rooms, no login, missing peer secret, duplicates and
role revocation. This is not a test of the rendered React frontend or POST route.

Before closing #41, connect the backend call above and PR #95's frontend, then
create a real note on server 1 and observe it on server 2 without reload. Repeat
with patient, staff and private visibility and after reconnect. This branch
depends on #90 (and thus #89 and #84); it does not depend on persistence #92.
