import { useAuth } from '../context/AuthContext';
import PatientView from './PatientView';

// Used for the /journal route: patients are routed here directly after
// login instead of going through the search page. It resolves the
// logged-in patient's own record via their linkedPatientId, so the
// patient can never view someone else's data through this route.
export default function Journal() {
  const { user } = useAuth();

  if (!user?.linkedPatientId) {
    return (
      <div className="patient-page">
        <div className="patient-container">
          <p className="not-found">No linked patient record found for this account.</p>
        </div>
      </div>
    );
  }

  return <PatientView patientIdOverride={user.linkedPatientId} />;
}