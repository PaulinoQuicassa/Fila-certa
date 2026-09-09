import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Login } from './pages/Login';
import { AgentScreen } from './pages/AgentScreen';
import { Dashboard } from './pages/Dashboard';
import { PublicDisplay } from './pages/PublicDisplay';
import { Estacao } from './pages/Estacao';

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

function CrashFallback() {
  return (
    <div style={{ padding: 40, textAlign: 'center', fontFamily: 'sans-serif' }}>
      <h2>Ocorreu um erro inesperado.</h2>
      <p>A equipa técnica já foi notificada. Recarregue a página para continuar.</p>
      <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '10px 20px' }}>
        Recarregar
      </button>
    </div>
  );
}

export default function App() {
  return (
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            {/* Ecrã público de chamada — sem login de equipa, autenticação
                anónima própria; é o que fica ligado permanentemente na TV.
                /painel sozinho continua a mostrar o Banco Exemplo (como
                sempre); /painel/:institutionId escolhe outra das 6
                instituições reais do piloto (ver lib/pilotInstitutions.ts). */}
            <Route path="/painel" element={<PublicDisplay />} />
            <Route path="/painel/:institutionId" element={<PublicDisplay />} />

            {/* Estação de auto-atendimento -- para quem chega
                fisicamente ao balcão sem telemóvel/conta própria. Sem
                login visível (sessão técnica própria, ver supabase.ts).
                Mesmo critério de /painel para escolher a instituição. */}
            <Route path="/estacao" element={<Estacao />} />
            <Route path="/estacao/:institutionId" element={<Estacao />} />

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
    </Sentry.ErrorBoundary>
  );
}
