import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import './AppHeader.css';

export default function AppHeader() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  if (!user) return null;

  return (
    <div className="app-header">
      <span className="app-header-user">
        Signed in as <strong>{user.displayName}</strong>
      </span>
      <button type="button" className="app-header-logout" onClick={handleLogout}>
        Sign out
      </button>
    </div>
  );
}