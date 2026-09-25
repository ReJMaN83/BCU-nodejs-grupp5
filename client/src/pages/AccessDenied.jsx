import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './AccessDenied.css';

// IMPORTANT: this page must never receive or render any patient data,
// route params, or query values. It only reads the current user's own
// role/name from AuthContext — nothing patient-related — so there is
// nothing here that could leak information to an unauthorized viewer.
export default function AccessDenied() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="access-denied-page">
      <div className="access-denied-card">
        <div className="access-denied-icon">
          <div className="access-denied-icon-bar" />
        </div>

        <h1 className="access-denied-title">Access Denied</h1>
        <p className="access-denied-text">
          {user
            ? "You don't have permission to view this page with your current account."
            : 'You need to sign in to view this page.'}
        </p>

        {user ? (
          <button className="access-denied-secondary" onClick={handleLogout}>
            Sign out and try a different account
          </button>
        ) : (
          <a href="/login" className="access-denied-button">
            Go to login
          </a>
        )}
      </div>
    </div>
  );
}