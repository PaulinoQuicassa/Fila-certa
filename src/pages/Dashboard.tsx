import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { subscribeAppointmentsToday, subscribeCounters, subscribeRatingsToday, subscribeTicketsToday } from '../lib/queue';
import type { Appointment, Counter, Rating, RatingAspects, Ticket } from '../types';

const SLA_MINUTES = 15;

const ASPECT_LABELS: Record<keyof RatingAspects, string> = {
  atendimento: 'Atendimento do colaborador',
  tempoEspera: 'Tempo de espera',
  organizacao: 'Organização do serviço',
  instalacoes: 'Instalações e ambiente',
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function averageFloat(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function Dashboard() {
  const { profile, logout } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counters, setCounters] = useState<Counter[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [ratings, setRatings] = useState<Rating[]>([]);

  const institutionId = profile?.institutionId ?? '';
  const branchId = profile?.branchId ?? '';

  useEffect(() => {
    if (!institutionId || !branchId) return;
    const unsubTickets = subscribeTicketsToday(institutionId, branchId, setTickets);
    const unsubCounters = subscribeCounters(institutionId, branchId, setCounters);
    const unsubAppointments = subscribeAppointmentsToday(institutionId, branchId, setAppointments);
    const unsubRatings = subscribeRatingsToday(institutionId, branchId, setRatings);
    return () => {
      unsubTickets();
      unsubCounters();
      unsubAppointments();
      unsubRatings();
    };
  }, [institutionId, branchId]);

  if (!profile) return null;

  const waitingNow = tickets.filter((t) => t.status === 'waiting').length;
  const waitTimes = tickets
    .filter((t) => t.calledAt)
    .map((t) => Math.round((t.calledAt! - t.createdAt) / 60000));
  const avgWait = average(waitTimes);
  const activeCounters = counters.filter((c) => c.status !== 'paused').length;
  const appointmentsToday = appointments.filter((a) => a.status !== 'cancelled').length;
  const customerCancelled = tickets.filter((t) => t.noShowReason === 'customer_cancelled').length;
  const staffMarkedNoShow = tickets.filter((t) => t.noShowReason === 'staff_marked').length;
  const transferredCount = tickets.filter((t) => t.wasTransferred).length;
  const onTheWayCount = tickets.filter((t) => t.customerOnTheWay).length;
  const arrivedCount = tickets.filter((t) => t.customerArrivedAt !== null).length;
  const delayReportedCount = tickets.filter((t) => t.customerDelayReportedAt !== null).length;
  // Quanto tempo os clientes que confirmaram "Cheguei" demoram, desde
  // serem chamados, a chegar mesmo ao balcão -- indicador real de
  // qualidade da estimativa de tempo dada pela app (não existia nenhum
  // sinal disto antes de "Cheguei" passar a gravar no servidor).
  const arrivalTimes = tickets
    .filter((t) => t.calledAt && t.customerArrivedAt)
    .map((t) => Math.round((t.customerArrivedAt! - t.calledAt!) / 60000));
  const avgArrivalTime = average(arrivalTimes);
  const avgOverallRating = averageFloat(ratings.map((r) => r.overall));
  const recommendPct = ratings.length
    ? Math.round((100 * ratings.filter((r) => r.recommend).length) / ratings.length)
    : null;
  const aspectKeys = Object.keys(ASPECT_LABELS) as Array<keyof RatingAspects>;
  const aspectAverages = aspectKeys
    .map((key) => ({ key, avg: averageFloat(ratings.map((r) => r.aspects[key])) }))
    .filter((a): a is { key: keyof RatingAspects; avg: number } => a.avg !== null)
    .sort((a, b) => b.avg - a.avg);
  const strengths = aspectAverages.slice(0, 2);
  const improvements = [...aspectAverages].reverse().slice(0, 2);
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 20 }}>
        <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Senhas emitidas hoje</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{tickets.length}</div>
        </div>
        <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Agendamentos hoje</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{appointmentsToday}</div>
        </div>
        <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Cancelamentos (cliente)</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-danger)' }}>{customerCancelled}</div>
        </div>
        <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Não compareceram</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-danger)' }}>{staffMarkedNoShow}</div>
        </div>
        <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Reencaminhados</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-orange)' }}>{transferredCount}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Comportamento do cliente durante a fila (hoje)</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 20 }}>
          <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Avisaram "a caminho"</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-green)' }}>{onTheWayCount}</div>
          </div>
          <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Confirmaram chegada</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{arrivedCount}</div>
          </div>
          <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Avisaram atraso</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-orange)' }}>{delayReportedCount}</div>
          </div>
          <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Tempo médio até chegar (após chamada)</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{avgArrivalTime ?? '—'} min</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Qualidade do Atendimento (avaliações de hoje)</div>
        <div className="fc-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {ratings.length === 0 ? (
            <div style={{ fontSize: 13.5, color: 'var(--fc-text-secondary)' }}>Ainda sem avaliações hoje.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Nota média</div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>
                    {avgOverallRating?.toFixed(1)} <span style={{ fontSize: 18 }}>★</span>{' '}
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
                      ({ratings.length} avaliaç{ratings.length === 1 ? 'ão' : 'ões'})
                    </span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Recomendariam</div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--fc-blue-dark)' }}>{recommendPct}%</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fc-green)' }}>Pontos fortes</div>
                  {strengths.map((a) => (
                    <div key={a.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{ASPECT_LABELS[a.key]}</span>
                      <span className="fc-pill" style={{ background: 'var(--fc-green-light)', color: 'var(--fc-green)' }}>{a.avg.toFixed(1)} ★</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fc-orange)' }}>Pontos a melhorar</div>
                  {improvements.map((a) => (
                    <div key={a.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{ASPECT_LABELS[a.key]}</span>
                      <span className="fc-pill" style={{ background: 'var(--fc-orange-bg)', color: 'var(--fc-orange)' }}>{a.avg.toFixed(1)} ★</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
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
