import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import './PatientSearch.css';

export default function PatientSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [patients, setPatients] = useState([]);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Loading/error reset before a data fetch; both are followed by an async
    // request, so this doesn't cause redundant renders in practice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (query.trim()) params.set('search', query.trim());

    api.get(`/api/patients?${params.toString()}`)
      .then((data) => {
        setPatients(data);
        setIsLoading(false);
      })
      .catch(() => {
        setError('Could not load patients. Please try again.');
        setIsLoading(false);
      });
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

        {error && <p className="search-error">{error}</p>}

        {!error && !isLoading && patients.length === 0 && (
          <ul className="patient-list">
            <li className="patient-list-empty">No patients found.</li>
          </ul>
        )}

        {!error && patients.length > 0 && (
          <ul className="patient-list">
            {patients.map((patient) => (
              <li key={patient.id} className="patient-item">
                <button
                  type="button"
                  className="patient-item-button"
                  onClick={() => handleSelectPatient(patient.id)}
                >
                  <div className="patient-item-name">{patient.fullName}</div>
                  <div className="patient-item-id">{patient.personalId}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}