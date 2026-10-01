import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { api, ApiError } from '../api/client';
import { socket } from '../api/socket';
import AppHeader from '../components/AppHeader';
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
  return date.toLocaleString('sv-SE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Determines whether a note is visible to the current user.
// The server already filters notes this way; this is a second line of defense
// so the UI never renders something the user shouldn't see, even briefly.
function isNoteVisible(note, user) {
  if (note.visibility === 'everyone') return true;
  if (note.visibility === 'staff') return STAFF_ROLES.includes(user.role);
  if (note.visibility === 'private') return note.authorId === user.id;
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

  const [patient, setPatient] = useState(null);
  const [patientError, setPatientError] = useState(null);

  const [accessLog, setAccessLog] = useState([]);
  const [accessLogError, setAccessLogError] = useState(false);

  useEffect(() => {
    if (!id) return;

    api.get(`/api/patients/${id}`)
      .then((data) => {
        setPatient(data);
        setPatientError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          navigate('/access-denied', { replace: true });
        } else if (err instanceof ApiError && err.status === 404) {
          setPatientError('Patient not found.');
        } else {
          setPatientError('Could not load patient data. Please try again.');
        }
      });
  }, [id, navigate]);

  useEffect(() => {
    if (!id) return;

    api.get(`/api/patients/${id}/access-log`)
      .then((data) => {
        setAccessLog(data);
        setAccessLogError(false);
      })
      .catch(() => {
        setAccessLogError(true);
      });
  }, [id]);

  useEffect(() => {
    if (!id) return;

    const joinRoom = () => {
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
      const newNote = payload.note;
      if (String(newNote.patientId) !== String(id)) return;

      setPatient((prev) => {
        if (!prev) return prev;
        if (prev.notes.some((n) => n.id === newNote.id)) return prev;
        return { ...prev, notes: [newNote, ...prev.notes] };
      });
    };

    socket.on('connect', joinRoom);
    socket.on('note:created', handleNoteCreated);
    socket.connect();

    return () => {
      socket.off('connect', joinRoom);
      socket.off('note:created', handleNoteCreated);
      socket.disconnect();
    };
  }, [id, navigate]);

  if (patientError) {
    return (
      <div className="patient-page">
        <div className="patient-container">
          <AppHeader />
          <p className="not-found">{patientError}</p>
        </div>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="patient-page">
        <div className="patient-container">
          <AppHeader />
          <p className="not-found">Loading patient data...</p>
        </div>
      </div>
    );
  }

  const role = user?.role || 'patient';
  const canWriteNotes = STAFF_ROLES.includes(role);
  const visibleNotes = patient.notes.filter((note) => isNoteVisible(note, user));

  const failedCount = accessLog.filter((entry) => entry.verified === false).length;
  const allVerified =
    accessLog.length > 0 && accessLog.every((entry) => entry.verified === true);

  const handleSaveNote = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setIsSaving(true);

    try {
      const newNote = await api.post(`/api/patients/${id}/notes`, {
        text: noteText,
        visibility,
      });

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
        <AppHeader />

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

        {canWriteNotes && (
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
        )}

        <section className="section">
          <h2 className="section-title">Access log</h2>

          {accessLogError && (
            <p className="access-log-notice">
              Could not load the access log. Please try again later.
            </p>
          )}

          {failedCount > 0 && (
            <div className="verification-summary failed">
              {failedCount} {failedCount === 1 ? 'entry' : 'entries'} failed
              verification. The log may have been tampered with.
            </div>
          )}
          {allVerified && (
            <div className="verification-summary ok">
              All entries verified against the blockchain.
            </div>
          )}

          {!accessLogError && accessLog.length === 0 && (
            <p className="notes-empty">No access log entries yet.</p>
          )}

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
                {entry.verified === true && (
                  <span
                    className="verification-badge ok"
                    title="Signature and chain verified"
                  >
                    ✓ Verified
                  </span>
                )}
                {entry.verified === false && (
                  <span
                    className="verification-badge failed"
                    title="Signature or chain could not be verified"
                  >
                    ✗ Not verified
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