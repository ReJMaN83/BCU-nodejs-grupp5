import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { mockPatients } from '../api/mockPatients';
import './PatientSearch.css';

export default function PatientSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  // TODO (backend integration): replace mockPatients with a fetched list
  // from GET /api/patients, e.g. via useEffect + api.get('/api/patients').
  const filteredPatients = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return mockPatients;
    return mockPatients.filter((p) =>
      p.fullName.toLowerCase().includes(term)
    );
  }, [query]);

  const handleSelectPatient = (patientId) => {
    navigate(`/patients/${patientId}`);
  };

  return (
    <div className="search-page">
      <div className="search-container">
        <div className="search-header">
          <h1 className="search-title">Patient Search</h1>
          <p className="search-subtitle">Search for a patient by name</p>
        </div>

        <input
          type="text"
          className="search-input"
          placeholder="Search by patient name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        <ul className="patient-list">
          {filteredPatients.length === 0 && (
            <li className="patient-list-empty">No patients found.</li>
          )}

          {filteredPatients.map((patient) => (
            <li
              key={patient.id}
              className="patient-item"
              onClick={() => handleSelectPatient(patient.id)}
            >
              <div className="patient-item-name">{patient.fullName}</div>
              <div className="patient-item-id">{patient.personalId}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}