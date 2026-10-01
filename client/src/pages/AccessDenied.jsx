import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import './AccessDenied.css';

// Only reads the current user from AuthContext, never patient data, route params or query values.
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