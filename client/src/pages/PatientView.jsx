import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, ApiError } from '../api/client';
import { socket } from '../api/socket';
import { mockPatientDetails } from '../api/mockPatientDetails';
import './PatientView.css';

const VISIBILITY_LABELS = {
  private: 'Only me',
  staff: 'Medical staff',
  everyone: 'Everyone',
};

const ROLE_LABELS = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  clinic: 'Health center',
  patient: 'Patient',
  unauthorized: 'Unauthorized',
};

const STAFF_ROLES = ['doctor', 'nurse', 'clinic'];

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
// The server already filters notes by visibility; this is a second line of defense.
// TODO: private notes should also be checked against the note's author, not just the role.
function isNoteVisible(note, role) {
  if (note.visibility === 'everyone') return true;
  if (note.visibility === 'staff' || note.visibility === 'private') {
    return STAFF_ROLES.includes(role);
  }
  return false;
}

export default function PatientView({ patientIdOverride }) {
  const { id: idFromUrl } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const id = patientIdOverride || idFromUrl;

  const [noteText, setNoteText] = useState('');
  const [visibility, setVisibility] = useState('staff');
  const [saveError, setSaveError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // TODO (backend integration): replace with api.get(`/api/patients/${id}`)
  const [patient, setPatient] = useState(mockPatientDetails[id]);

  const [accessLog, setAccessLog] = useState(mockPatientDetails[id]?.accessLog || []);

  // Fetch the access log; fall back to mock data if the backend isn't reachable
  useEffect(() => {
    if (!id) return;

    api.get(`/api/patients/${id}/access-log`)
      .then(setAccessLog)
      .catch(() => {
        console.warn('Could not fetch access log, using mock data.');
      });
  }, [id]);

  // Live updates: join the patient room and listen for new notes
  useEffect(() => {
    if (!id) return;

    const joinRoom = () => {
      // The server replies with { ok: true, patientId } or { ok: false, status }
      socket.timeout(2000).emit('join-patient-room', id, (err, response) => {
        if (err) {
          console.warn('Timed out while joining the patient room.');
          return;
        }
        if (!response.ok && response.status === 403) {
          navigate('/access-denied', { replace: true });
        } else if (!response.ok) {
          console.warn('Could not join the patient room:', response.status);
        }
      });
    };

    const handleNoteCreated = (payload) => {
      // payload = { originNodeId, note }
      const newNote = payload.note;

      if (String(newNote.patientId) !== String(id)) return; // safety check

      setPatient((prev) => {
        if (!prev) return prev;
        // Avoid duplicates (e.g. a note this user just created themselves)
        if (prev.notes.some((n) => n.id === newNote.id)) return prev;
        return { ...prev, notes: [newNote, ...prev.notes] };
      });
    };

    // Joining on 'connect' also re-joins the room after a reconnect
    socket.on('connect', joinRoom);
    socket.on('note:created', handleNoteCreated);
    socket.connect();

    return () => {
      socket.off('connect', joinRoom);
      socket.off('note:created', handleNoteCreated);
      socket.disconnect();
    };
  }, [id, navigate]);

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

      // Prepend the new note so it appears immediately, without refetching
      setPatient((prev) => {
        if (prev.notes.some((n) => n.id === newNote.id)) return prev;
        return { ...prev, notes: [newNote, ...prev.notes] };
      });

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