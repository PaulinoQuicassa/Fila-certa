import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'no-staff-profile'
          ? 'Esta conta não tem um perfil de equipa associado.'
          : 'Email ou palavra-passe incorrectos.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <form
        onSubmit={handleSubmit}
        className="fc-card"
        style={{ width: 380, padding: 36, display: 'flex', flexDirection: 'column', gap: 20 }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>Fila Certa</div>
          <div style={{ fontSize: 14, color: 'var(--fc-text-secondary)', marginTop: 4 }}>Acesso de equipa</div>
        </div>

        <label htmlFor="staff-email" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
          Email
          <input
            id="staff-email"
            type="email"
            required
            autoComplete="username"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'staff-login-error' : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: '12px 14px', borderRadius: 'var(--fc-radius-md)', border: '1.5px solid var(--fc-border)', fontSize: 15, minHeight: 'var(--fc-touch)' }}
          />
        </label>

        <label htmlFor="staff-password" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
          Palavra-passe
          <input
            id="staff-password"
            type="password"
            required
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'staff-login-error' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ padding: '12px 14px', borderRadius: 'var(--fc-radius-md)', border: '1.5px solid var(--fc-border)', fontSize: 15, minHeight: 'var(--fc-touch)' }}
          />
        </label>

        {error && <div id="staff-login-error" role="alert" style={{ fontSize: 13, color: 'var(--fc-danger)' }}>{error}</div>}

        <button type="submit" disabled={busy} className="fc-btn fc-btn--primary">
          {busy ? 'A entrar…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
