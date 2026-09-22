import { Router } from 'express';
import { accessLogFor, auditLogger } from '../audit-logger.js';
import { db } from '../db.js';
import { requireAuth, requireRole, STAFF_ROLES } from '../middleware.js';

export const patientsRouter = Router();

const searchPatients = db.prepare(`
  SELECT id, full_name AS fullName, personal_id AS personalId
  FROM patients
  WHERE ? = '' OR lower(full_name) LIKE '%' || lower(?) || '%' OR personal_id LIKE '%' || ? || '%'
  ORDER BY full_name
`);

const selectPatient = db.prepare(
  'SELECT id, full_name AS fullName, personal_id AS personalId FROM patients WHERE id = ?',
);

// Filtreringen på synlighet görs i SQL, så anteckningar användaren inte får se
// aldrig lämnar servern. private: bara författaren, staff: all personal,
// everyone: alla som får se journalen.
const selectNotes = db.prepare(`
  SELECT n.id, n.patient_id AS patientId, n.author_id AS authorId,
         u.display_name AS authorName, u.role AS authorRole,
         n.text, n.visibility, n.created_at AS createdAt
  FROM notes n
  JOIN users u ON u.id = n.author_id
  WHERE n.patient_id = @patientId
    AND (n.visibility = 'everyone'
         OR (n.visibility = 'staff' AND @isStaff = 1)
         OR (n.visibility = 'private' AND n.author_id = @userId))
  ORDER BY n.created_at DESC, n.id DESC
`);

// Allt under /api/patients kräver inloggning. Rollen unauthorized får 403 överallt,
// och patient bara på sin egen journal (kontrollen i requirePatientAccess).
patientsRouter.use(requireAuth, requireRole(...STAFF_ROLES, 'patient'));

function requirePatientAccess(req, res, next) {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId)) {
    return res.status(400).json({ message: 'Invalid patient id' });
  }

  const { role, linked_patient_id: linkedPatientId } = req.user;
  if (role === 'patient' && patientId !== linkedPatientId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  req.patientId = patientId;
  return next();
}

function notesFor(patientId, user) {
  return selectNotes.all({
    patientId,
    userId: user.id,
    isStaff: STAFF_ROLES.includes(user.role) ? 1 : 0,
  });
}

// Sökning är personalens vy. En patient har ingen lista att söka i (#32).
patientsRouter.get('/', requireRole(...STAFF_ROLES), (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  res.json(searchPatients.all(search, search, search));
});

// Varje lyckad läsning blir ett signerat read-block i nodens egen kedja.
patientsRouter.get('/:id', requirePatientAccess, auditLogger('read'), (req, res) => {
  const patient = selectPatient.get(req.patientId);
  if (!patient) return res.status(404).json({ message: 'Patient not found' });

  res.json({ ...patient, notes: notesFor(req.patientId, req.user) });
});

patientsRouter.get('/:id/notes', requirePatientAccess, (req, res) => {
  if (!selectPatient.get(req.patientId)) {
    return res.status(404).json({ message: 'Patient not found' });
  }

  res.json(notesFor(req.patientId, req.user));
});

// Skapar inga block (docs/kontrakt.md).
patientsRouter.get('/:id/access-log', requirePatientAccess, (req, res) => {
  if (!selectPatient.get(req.patientId)) {
    return res.status(404).json({ message: 'Patient not found' });
  }

  res.json(accessLogFor(req.patientId));
});
