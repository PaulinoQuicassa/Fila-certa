import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Login } from './pages/Login';
import { AgentScreen } from './pages/AgentScreen';
import { Dashboard } from './pages/Dashboard';
import { PublicDisplay } from './pages/PublicDisplay';

function RequireRole({ role, children }: { role: 'agent' | 'manager'; children: React.ReactNode }) {
  const { user, profile, loading } = useAuth();

  if (loading) return null;
  if (!user || !profile) return <Navigate to="/login" replace />;
  if (profile.role !== role) {
    return <Navigate to={profile.role === 'manager' ? '/dashboard' : '/agente'} replace />;
  }
  return <>{children}</>;
}

function LoginRoute() {
  const { user, profile, loading } = useAuth();
  if (loading) return null;
  if (user && profile) {
    return <Navigate to={profile.role === 'manager' ? '/dashboard' : '/agente'} replace />;
  }
  return <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          {/* Ecrã público de chamada — sem login de equipa, autenticação
              anónima própria; é o que fica ligado permanentemente na TV. */}
          <Route path="/painel" element={<PublicDisplay />} />

          <Route path="/login" element={<LoginRoute />} />
          <Route
            path="/agente"
            element={
              <RequireRole role="agent">
                <AgentScreen />
              </RequireRole>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireRole role="manager">
                <Dashboard />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
