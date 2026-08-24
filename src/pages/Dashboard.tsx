import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { subscribeCounters, subscribeTicketsToday } from '../lib/queue';
import type { Counter, Ticket } from '../types';

const SLA_MINUTES = 15;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function Dashboard() {
  const { profile, logout } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counters, setCounters] = useState<Counter[]>([]);

  const institutionId = profile?.institutionId ?? '';
  const branchId = profile?.branchId ?? '';

  useEffect(() => {
    if (!institutionId || !branchId) return;
    const unsubTickets = subscribeTicketsToday(institutionId, branchId, setTickets);
    const unsubCounters = subscribeCounters(institutionId, branchId, setCounters);
    return () => {
      unsubTickets();
      unsubCounters();
    };
  }, [institutionId, branchId]);

  if (!profile) return null;

  const waitingNow = tickets.filter((t) => t.status === 'waiting').length;
  const waitTimes = tickets
    .filter((t) => t.calledAt)
    .map((t) => Math.round((t.calledAt! - t.createdAt) / 60000));
  const avgWait = average(waitTimes);
  const activeCounters = counters.filter((c) => c.status !== 'paused').length;
  const slaBreaches = counters.filter((c) => {
    if (!c.currentTicketId) return false;
    const t = tickets.find((tk) => tk.id === c.currentTicketId);
    if (!t) return false;
    const waited = Math.round((Date.now() - t.createdAt) / 60000);
    return waited > SLA_MINUTES;
  });

  const perCounter = counters.map((c) => {
    const served = tickets.filter((t) => t.counterId === c.id && t.doneAt);
    const times = served
      .filter((t) => t.calledAt && t.doneAt)
      .map((t) => Math.round((t.doneAt! - t.calledAt!) / 60000));
    return { counter: c, count: served.length, avg: average(times) };
  });

  return (
    <div style={{ minHeight: '100vh', padding: '36px 40px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>Dashboard</div>
          <div style={{ fontSize: 14, color: 'var(--fc-text-secondary)', marginTop: 2 }}>Visão institucional — hoje</div>
        </div>
        <button onClick={() => logout()} style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
          Terminar sessão
        </button>
      </div>

      {slaBreaches.length > 0 && (
        <div className="fc-card" style={{ background: 'var(--fc-orange-bg)', boxShadow: 'none', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14 }}>
            <strong>Fila acima do SLA</strong> — {slaBreaches.map((c) => c.label).join(', ')}: tempo de espera acima de {SLA_MINUTES} min.
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 20 }}>
        <div className="fc-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Clientes em espera agora</div>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{waitingNow}</div>
        </div>
        <div className="fc-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Tempo médio de espera</div>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{avgWait ?? '—'} min</div>
        </div>
        <div className="fc-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Balcões activos</div>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>
            {activeCounters} <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>/ {counters.length}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Vista por Balcão / Agente</div>
        <div className="fc-card" style={{ overflow: 'hidden' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--fc-border)' }}>
                {['Balcão', 'Agente', 'Atendimentos hoje', 'Tempo médio', 'Estado'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '12px 14px', fontSize: 13.5, color: 'var(--fc-text-secondary)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perCounter.map(({ counter, count, avg }) => (
                <tr key={counter.id} style={{ borderBottom: '1px solid var(--fc-border)' }}>
                  <td style={{ padding: '12px 14px', fontWeight: 600 }}>{counter.label}</td>
                  <td style={{ padding: '12px 14px', color: 'var(--fc-text-secondary)' }}>{counter.agentName ?? '—'}</td>
                  <td style={{ padding: '12px 14px', color: 'var(--fc-text-secondary)' }}>{count}</td>
                  <td style={{ padding: '12px 14px', color: 'var(--fc-text-secondary)' }}>{avg ?? '—'} min</td>
                  <td style={{ padding: '12px 14px' }}>
                    <span
                      className="fc-pill"
                      style={{
                        background: counter.status === 'paused' ? 'var(--fc-orange-bg)' : 'var(--fc-green-light)',
                        color: counter.status === 'paused' ? 'var(--fc-orange)' : 'var(--fc-green)',
                      }}
                    >
                      {counter.status === 'paused' ? 'Pausa' : counter.status === 'serving' ? 'Em atendimento' : 'Disponível'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
