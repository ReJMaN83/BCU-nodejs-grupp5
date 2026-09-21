import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
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
    return ['doctor', 'nurse', 'clinic'].includes(role);
  }
  if (note.visibility === 'private') {
    // In the real implementation this should also check that the
    // current user is the note's author, not just their role.
    return ['doctor', 'nurse', 'clinic'].includes(role);
  }
  return false;
}

export default function PatientView() {
  const { id } = useParams();
  const { user } = useAuth();

  const [noteText, setNoteText] = useState('');
  const [visibility, setVisibility] = useState('staff');

  // TODO (backend integration): replace with api.get(`/api/patients/${id}`)
  const patient = mockPatientDetails[id];

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

  const handleSaveNote = (e) => {
    e.preventDefault();
    // TODO (backend integration): POST /api/patients/:id/notes
    // Should also trigger an access log entry on the blockchain.
    console.log('Saving note:', { patientId: id, text: noteText, visibility });
    setNoteText('');
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
              <button type="submit" className="save-note-button">
                Save note
              </button>
            </div>
          </form>
        </section>

        <section className="section">
          <h2 className="section-title">Access log</h2>
          {patient.accessLog.map((entry) => (
            <div className="log-entry" key={entry.id}>
              <span className="log-who">
                {entry.name}{' '}
                <span className="log-role">
                  ({ROLE_LABELS[entry.role] || entry.role})
                </span>
              </span>
              <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}