
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import PatientSearch from './pages/PatientSearch';
import PatientView from './pages/PatientView';
import AccessDenied from './pages/AccessDenied';

function ProtectedRoute({ children, roles }) {
  const { user, loading } = useAuth();

  if (loading) return <p>Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/access-denied" replace />;

  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/access-denied" element={<AccessDenied />} />

      <Route
        path="/patients"
        element={
          <ProtectedRoute>
            <PatientSearch />
          </ProtectedRoute>
        }
      />

      {/* :id = patient id. The backend must ALWAYS verify that the logged-in
          user is actually allowed to view this specific patient — see note below. */}
      <Route
        path="/patients/:id"
        element={
          <ProtectedRoute>
            <PatientView />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/patients" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}