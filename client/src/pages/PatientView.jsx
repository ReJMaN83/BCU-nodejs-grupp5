import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../api/client';
import { mockPatientDetails } from '../api/mockPatientDetails';
import { socket } from '../api/socket';
import './PatientView.css';

const VISIBILITY_LABELS = {
  private: 'Only me',
  staff: 'Medical staff',
  everyone: 'Everyone',
};

const ROLE_LABELS = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  health_center: 'Health center',
  patient: 'Patient',
  unauthorized: 'Unauthorized',
};

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Determines whether a note is visible to the current user's role.
// TODO (backend integration): this filtering should ultimately happen
// server-side too, so the client never even receives notes it's not
// allowed to see.
function isNoteVisible(note, role) {
  if (note.visibility === 'everyone') return true;
  if (note.visibility === 'staff') {
    return ['doctor', 'nurse', 'health_center'].includes(role);
  }
  if (note.visibility === 'private') {
    // In the real implementation this should also check that the
    // current user is the note's author, not just their role.
    return ['doctor', 'nurse', 'health_center'].includes(role);
  }
  return false;
}

export default function PatientView({ patientIdOverride }) {
  const { id: idFromUrl } = useParams();
  const { user } = useAuth();
  const id = patientIdOverride || idFromUrl;

  const [noteText, setNoteText] = useState('');
  const [visibility, setVisibility] = useState('staff');
  const [saveError, setSaveError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // TODO (backend integration): replace with api.get(`/api/patients/${id}`)
  const [patient, setPatient] = useState(mockPatientDetails[id]);

  const [accessLog, setAccessLog] = useState(mockPatientDetails[id]?.accessLog || []);

  useEffect(() => {
    if (!id) return;

    api.get(`/api/patients/${id}/access-log`)
      .then(setAccessLog)
      .catch(() => {
        // Backend not available yet — keep using the mocked access log.
        console.warn('Could not fetch access log, using mock data.');
      });
  }, [id]);

  useEffect(() => {
  if (!id) return;

  socket.connect();

  // TODO: confirm the exact join-room event name/payload with the backend team.
  // The contract states the client "joins the room patient:<id> when a patient
  // view opens" but doesn't specify whether this happens automatically or via
  // an explicit emit. Assuming an explicit emit for now:
  socket.emit('join-patient-room', id);

  const handleNoteCreated = (payload) => {
    // payload = { originNodeId, note }
    const newNote = payload.note;

    if (String(newNote.patientId) !== String(id)) return; // safety check

    setPatient((prev) => {
      if (!prev) return prev;
      // Avoid duplicates if the note already exists (e.g. we sent it ourselves)
      if (prev.notes.some((n) => n.id === newNote.id)) return prev;
      return { ...prev, notes: [newNote, ...prev.notes] };
    });
  };

  socket.on('note:created', handleNoteCreated);

  return () => {
    socket.off('note:created', handleNoteCreated);
    // TODO: confirm if/how the client should leave the room on unmount.
    socket.disconnect();
  };
}, [id]);

  if (!patient) {
    return (
      <div className="patient-page">
        <div className="patient-container">
          <p className="not-found">Patient not found.</p>
        </div>
      </div>
    );
  }

  const role = user?.role || 'patient'; // fallback for local dev before auth is wired up
  const visibleNotes = patient.notes.filter((note) => isNoteVisible(note, role));

  const handleSaveNote = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setIsSaving(true);

    try {
      const newNote = await api.post(`/api/patients/${id}/notes`, {
        text: noteText,
        visibility,
      });

      // Prepend the new note so it appears at the top of the list immediately,
      // without needing to refetch the whole patient record.
      setPatient((prev) => ({
        ...prev,
        notes: [newNote, ...prev.notes],
      }));

      setNoteText('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setSaveError('Please write a note and select a valid visibility option.');
      } else if (err instanceof ApiError && err.status === 403) {
        setSaveError('You do not have permission to add notes.');
      } else {
        setSaveError('Something went wrong while saving the note. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="patient-page">
      <div className="patient-container">
        <Link to="/patients" className="back-link">
          &larr; Back to search
        </Link>

        <div className="patient-header">
          <div>
            <h1 className="patient-name">{patient.fullName}</h1>
            <p className="patient-meta">{patient.personalId}</p>
          </div>
          <span className="role-badge">
            Viewing as: {ROLE_LABELS[role] || role}
          </span>
        </div>

        <section className="section">
          <h2 className="section-title">Medical notes</h2>

          {visibleNotes.length === 0 && (
            <p className="notes-empty">No notes available.</p>
          )}

          {visibleNotes.map((note) => (
            <div className="note" key={note.id}>
              <div className="note-meta">
                <span className="note-author">{note.authorName}</span>
                <span className="note-time">{formatTimestamp(note.createdAt)}</span>
              </div>
              <p className="note-text">{note.text}</p>
              <span className={`visibility-tag ${note.visibility}`}>
                {VISIBILITY_LABELS[note.visibility]}
              </span>
            </div>
          ))}
        </section>

        <section className="section">
          <h2 className="section-title">Add a note</h2>
          <form className="add-note-form" onSubmit={handleSaveNote}>
            {saveError && <div className="add-note-error">{saveError}</div>}

            <textarea
              className="add-note-textarea"
              placeholder="Write a note..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              required
            />
            <div className="add-note-controls">
              <select
                className="visibility-select"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value)}
              >
                <option value="private">Visible to: Only me</option>
                <option value="staff">Visible to: Medical staff</option>
                <option value="everyone">Visible to: Everyone</option>
              </select>
              <button type="submit" className="save-note-button" disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save note'}
              </button>
            </div>
          </form>
        </section>

        <section className="section">
          <h2 className="section-title">Access log</h2>
          {accessLog.map((entry) => (
            <div className="log-entry" key={entry.id}>
              <span className="log-who">
                {entry.name}{' '}
                <span className="log-role">
                  ({ROLE_LABELS[entry.role] || entry.role})
                </span>
                {' · '}
                <span className="log-action">{entry.action}</span>
              </span>
              <span className="log-right">
                {entry.verified && (
                  <span className="verified-badge" title="Signature verified">
                    ✓
                  </span>
                )}
                <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}