
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth';
import Login from './pages/Login';
import PatientSearch from './pages/PatientSearch';
import PatientView from './pages/PatientView';
import AccessDenied from './pages/AccessDenied';
import Journal from './pages/Journal';


// Route protection (issue #38): ProtectedRoute below redirects unauthenticated
// users to /login and users with the wrong role to /access-denied.

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
          <ProtectedRoute roles={['doctor', 'nurse', 'clinic']}>
            <PatientSearch />
          </ProtectedRoute>
        }
      />

      {/* :id = patient id. The backend always verifies that the logged-in user
          is actually allowed to view this specific patient (requirePatientAccess
          in server/src/routes/patients.js), so a manipulated URL never leaks
          another patient's data even if the client-side check were bypassed. */}
      <Route
        path="/patients/:id"
        element={
          <ProtectedRoute roles={['doctor', 'nurse', 'clinic']}>
            <PatientView />
          </ProtectedRoute>
        }
      />
      <Route
        path="/journal"
        element={
          <ProtectedRoute roles={['patient']}>
            <Journal />
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