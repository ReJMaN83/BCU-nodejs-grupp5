const staff = new Set(['doctor', 'nurse', 'clinic']);

export function canReadPatient(user, patientId) {
  return Boolean(user && (staff.has(user.role)
    || (user.role === 'patient' && user.linked_patient_id === patientId)));
}

export function canReadNote(user, note) {
  return canReadPatient(user, note.patientId) && (note.visibility === 'everyone'
    || (note.visibility === 'staff' && staff.has(user.role))
    || (note.visibility === 'private' && note.authorId === user.id));
}

// Database rows are authoritative; never forward peer-supplied note text.
export function createNoteEvents({ nodeId, db, authenticate }) {
  const select = db.prepare(`SELECT n.id, n.patient_id AS patientId,
    n.author_id AS authorId, u.display_name AS authorName, u.role AS authorRole,
    n.text, n.visibility, n.created_at AS createdAt
    FROM notes n JOIN users u ON u.id = n.author_id WHERE n.id = ?`);
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?');
  let clients;
  let broadcast = () => {};
  const delivered = new Set();

  function deliver(originNodeId, note) {
    const key = `${originNodeId}:${note.id}`;
    if (delivered.has(key)) return false;
    delivered.add(key);
    if (delivered.size > 1000) delivered.delete(delivered.values().next().value);
    for (const socket of clients?.sockets.values() ?? []) {
      const user = authenticate(socket.request);
      if (!user) { socket.disconnect(true); continue; }
      if (socket.rooms.has(`patient:${note.patientId}`) && canReadNote(user, note)) {
        socket.emit('note:created', { originNodeId, note });
      }
    }
    return true;
  }

  return {
    attach(namespace) {
      clients = namespace;
      namespace.use((socket, next) => {
        if (!authenticate(socket.request)) return next(new Error('Not authenticated'));
        next();
      });
      namespace.on('connection', (socket) => {
        socket.on('join-patient-room', (value, acknowledge) => {
          const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
          const patientId = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
          const user = authenticate(socket.request);
          if (!user) { reply({ ok: false, status: 401 }); socket.disconnect(true); return; }
          if (!Number.isSafeInteger(patientId) || patientId < 1) { reply({ ok: false, status: 400 }); return; }
          if (!canReadPatient(user, patientId)) { reply({ ok: false, status: 403 }); return; }
          if (!patient.get(patientId)) { reply({ ok: false, status: 404 }); return; }
          for (const room of socket.rooms) if (room.startsWith('patient:')) socket.leave(room);
          socket.join(`patient:${patientId}`);
          reply({ ok: true, patientId });
        });
        socket.on('leave-patient-room', () => {
          for (const room of socket.rooms) if (room.startsWith('patient:')) socket.leave(room);
        });
      });
    },
    setBroadcaster(fn) { broadcast = fn; },
    publish(noteId) {
      const note = select.get(noteId);
      if (!note) throw new Error('Publish only an already committed note');
      if (deliver(nodeId, note)) broadcast({ originNodeId: nodeId, note });
    },
    receive(message, sender) {
      if (!message || message.originNodeId !== sender || sender === nodeId
        || !Number.isSafeInteger(message.note?.id)) return;
      const note = select.get(message.note.id);
      if (note) deliver(sender, note);
    },
  };
}
