import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { reportError } from '../sentry';
import {
  callNext,
  completeCurrent,
  markNoShow,
  recallCurrent,
  setCounterPaused,
  subscribeCounter,
  subscribeCounters,
  subscribeTicket,
  subscribeWaitingQueue,
  transferTicket,
} from '../lib/queue';
import type { Counter, Ticket } from '../types';
import { humanError } from '../lib/humanError';

function minutesAgo(ts: number | null) {
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

export function AgentScreen() {
  const { profile, logout } = useAuth();
  const [counter, setCounter] = useState<Counter | null>(null);
  const [currentTicket, setCurrentTicket] = useState<Ticket | null>(null);
  const [queue, setQueue] = useState<Ticket[]>([]);
  const [counters, setCounters] = useState<Counter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const institutionId = profile?.institutionId ?? '';
  const branchId = profile?.branchId ?? '';
  const counterId = profile?.counterId ?? '';

  useEffect(() => {
    if (!institutionId || !branchId || !counterId) return;
    return subscribeCounter(institutionId, branchId, counterId, setCounter);
  }, [institutionId, branchId, counterId]);

  useEffect(() => {
    if (!institutionId || !branchId) return;
    return subscribeWaitingQueue(institutionId, branchId, setQueue);
  }, [institutionId, branchId]);

  useEffect(() => {
    if (!institutionId || !branchId) return;
    return subscribeCounters(institutionId, branchId, setCounters);
  }, [institutionId, branchId]);

  useEffect(() => {
    if (!institutionId || !branchId || !counter?.currentTicketId) {
      setCurrentTicket(null);
      return;
    }
    return subscribeTicket(institutionId, branchId, counter.currentTicketId, setCurrentTicket);
  }, [institutionId, branchId, counter?.currentTicketId]);

  if (!profile) return null;

  if (!counterId) {
    return (
      <div style={{ minHeight: '100vh', padding: 32, display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center', justifyContent: 'center' }}>
        <div className="fc-card" style={{ padding: 32, maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Sem balcão atribuído</div>
          <div style={{ fontSize: 13.5, color: 'var(--fc-text-secondary)', marginBottom: 20 }}>
            O seu gestor ainda não o atribuiu a nenhum balcão. Fale com o gestor da filial em "Gerir Balcões" para poder atender.
          </div>
          <button onClick={() => logout()} className="fc-btn fc-btn--secondary">Terminar sessão</button>
        </div>
      </div>
    );
  }

  const waitMin = minutesAgo(currentTicket?.createdAt ?? null);
  const isPaused = counter?.status === 'paused';

  // Senhas que este balcão pode chamar: as transferidas especificamente
  // para aqui (essas vêm sempre primeiro, ver call_next() -- uma
  // transferência é uma decisão humana explícita, ignora a configuração
  // de serviços do balcão), mais as da fila geral cujo serviço este
  // balcão atende (counter.services nulo/vazio = atende todos, igual ao
  // comportamento antes de existir esta configuração).
  const eligibleQueue = queue
    .filter((t) => {
      if (t.transferredToCounterId !== null) return t.transferredToCounterId === counterId;
      const services = counter?.services;
      return !services || services.length === 0 || services.includes(t.service);
    })
    .sort((a, b) => {
      const aMine = a.transferredToCounterId === counterId ? 0 : 1;
      const bMine = b.transferredToCounterId === counterId ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
  const otherCounters = counters.filter((c) => c.id !== counterId);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      console.error(err);
      reportError(err, { institutionId, branchId, counterId, screen: 'AgentScreen' });
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = isPaused ? 'Em pausa' : currentTicket ? 'Em atendimento' : 'Disponível';

  return (
    <div style={{ minHeight: '100vh', padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div className="fc-card" style={{ padding: '20px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 999, background: 'var(--fc-blue-light)', color: 'var(--fc-blue-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>
            {profile.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{profile.name}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fc-text-secondary)' }}>{counter?.label ?? '—'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              className="fc-pill"
              aria-live="polite"
              style={{ background: isPaused ? 'var(--fc-orange-bg)' : 'var(--fc-green-light)', color: isPaused ? 'var(--fc-orange)' : 'var(--fc-green)' }}
            >
              {statusLabel}
            </span>
            <div role="group" aria-label="Estado do balcão" style={{ display: 'flex', gap: 4, background: 'var(--fc-bg)', borderRadius: 999, padding: 4 }}>
              <button
                type="button"
                disabled={busy || !isPaused}
                onClick={() => run(() => setCounterPaused(institutionId, branchId, counterId, false))}
                style={{
                  padding: '8px 16px', borderRadius: 999, fontSize: 13, fontWeight: 700, minHeight: 36,
                  background: !isPaused ? 'var(--fc-blue-dark)' : 'transparent',
                  color: !isPaused ? '#fff' : 'var(--fc-text-secondary)',
                }}
              >
                Disponível
              </button>
              <button
                type="button"
                disabled={busy || isPaused}
                onClick={() => run(() => setCounterPaused(institutionId, branchId, counterId, true))}
                style={{
                  padding: '8px 16px', borderRadius: 999, fontSize: 13, fontWeight: 700, minHeight: 36,
                  background: isPaused ? 'var(--fc-blue-dark)' : 'transparent',
                  color: isPaused ? '#fff' : 'var(--fc-text-secondary)',
                }}
              >
                Pausa
              </button>
            </div>
          </div>
          <button onClick={() => logout()} style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
            Terminar sessão
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="fc-card" style={{ background: 'var(--fc-danger-bg, #fdecea)', boxShadow: 'none', padding: '14px 20px', color: 'var(--fc-danger)', fontSize: 13.5, fontWeight: 600 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24, alignItems: 'start' }}>
        {/* Ticket panel */}
        <div className="fc-card" style={{ padding: 40, display: 'flex', flexDirection: 'column', gap: 28 }}>
          {currentTicket ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--fc-text-secondary)', textTransform: 'uppercase' }}>
                  Senha em atendimento
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
                  <div style={{ fontSize: 64, fontWeight: 800, color: 'var(--fc-blue-dark)', lineHeight: 1 }}>{currentTicket.code}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>{currentTicket.service}</div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <span className="fc-pill" style={{ background: 'var(--fc-blue-light)', color: 'var(--fc-blue-dark)' }}>
                    Tempo de espera: {waitMin ?? '—'} min
                  </span>
                  {currentTicket.priority && (
                    <span className="fc-pill" style={{ background: 'var(--fc-orange-bg)', color: 'var(--fc-orange)' }}>
                      Prioridade
                    </span>
                  )}
                  {currentTicket.customerOnTheWay && (
                    <span className="fc-pill" style={{ background: 'var(--fc-green-light)', color: 'var(--fc-green)' }}>
                      Cliente a caminho
                    </span>
                  )}
                  {currentTicket.customerArrivedAt && (
                    <span className="fc-pill" style={{ background: 'var(--fc-blue-light)', color: 'var(--fc-blue-dark)' }}>
                      Cliente chegou ao local
                    </span>
                  )}
                  {currentTicket.customerDelayReportedAt && !currentTicket.customerArrivedAt && (
                    <span className="fc-pill" style={{ background: 'var(--fc-orange-bg)', color: 'var(--fc-orange)' }}>
                      Cliente avisou atraso
                    </span>
                  )}
                </div>
              </div>

              {currentTicket.noShowReason === 'customer_cancelled' && (
                <div
                  className="fc-card"
                  style={{ background: 'var(--fc-danger-bg, #fdecea)', boxShadow: 'none', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fc-danger)' }}>
                    O cliente avisou que não vai comparecer.
                  </span>
                  <button
                    className="fc-btn fc-btn--secondary"
                    disabled={busy}
                    onClick={() => run(() => markNoShow(institutionId, branchId, counterId))}
                  >
                    Libertar Balcão
                  </button>
                </div>
              )}

              <div style={{ height: 1, background: 'var(--fc-border)' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <button
                  className="fc-btn fc-btn--success"
                  disabled={busy}
                  onClick={() => run(() => completeCurrent(institutionId, branchId, counterId))}
                >
                  Concluir Atendimento
                </button>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 }}>
                  <button
                    className="fc-btn fc-btn--secondary"
                    disabled={busy}
                    onClick={() => run(() => recallCurrent(institutionId, branchId, counterId))}
                  >
                    Chamar Novamente
                  </button>
                  <button
                    className="fc-btn fc-btn--secondary"
                    style={{ color: 'var(--fc-danger)' }}
                    disabled={busy}
                    onClick={() => run(() => markNoShow(institutionId, branchId, counterId))}
                  >
                    Não Compareceu
                  </button>
                  <div style={{ position: 'relative' }}>
                    <button
                      className="fc-btn fc-btn--secondary"
                      style={{ width: '100%' }}
                      disabled={busy || otherCounters.length === 0}
                      onClick={() => setTransferOpen((open) => !open)}
                    >
                      Transferir
                    </button>
                    {transferOpen && (
                      <div
                        className="fc-card"
                        style={{
                          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 10,
                          padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
                        }}
                      >
                        {otherCounters.map((c) => (
                          <button
                            key={c.id}
                            disabled={busy}
                            onClick={() => {
                              setTransferOpen(false);
                              run(() => transferTicket(institutionId, branchId, counterId, c.id));
                            }}
                            style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--fc-radius-md)', fontSize: 13.5, fontWeight: 600 }}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className="fc-btn fc-btn--secondary"
                    disabled={busy}
                    onClick={() => run(() => setCounterPaused(institutionId, branchId, counterId, !isPaused))}
                  >
                    {isPaused ? 'Retomar Fila' : 'Pausar Fila'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center', padding: '40px 0' }}>
              <div style={{ fontSize: 16, color: 'var(--fc-text-secondary)' }}>
                {isPaused
                  ? 'A fila está em pausa. Retome quando estiver pronto a atender.'
                  : eligibleQueue.length === 0
                    ? 'Não há ninguém à espera neste balcão.'
                    : 'Pronto a atender. Chame a próxima senha.'}
              </div>
              <button
                className="fc-btn fc-btn--primary"
                style={{ maxWidth: 280 }}
                disabled={busy || isPaused || eligibleQueue.length === 0}
                onClick={() => run(() => callNext(institutionId, branchId, counterId))}
              >
                Chamar Próxima →
              </button>
            </div>
          )}
        </div>

        {/* Queue sidebar */}
        <div className="fc-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Fila em Espera</div>
            <div className="fc-pill" style={{ background: 'var(--fc-blue-light)', color: 'var(--fc-blue-dark)' }}>{eligibleQueue.length}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {eligibleQueue.slice(0, 6).map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1.5px solid var(--fc-border)', borderRadius: 'var(--fc-radius-lg)', padding: '12px 14px' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{t.code}{t.priority ? ' ★' : ''}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fc-text-secondary)' }}>{t.service}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {t.transferredToCounterId === counterId && (
                    <span className="fc-pill" style={{ background: 'var(--fc-orange-bg)', color: 'var(--fc-orange)' }}>Transferida</span>
                  )}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
                    {minutesAgo(t.createdAt)} min
                  </span>
                </div>
              </div>
            ))}
            {eligibleQueue.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--fc-text-secondary)' }}>Ninguém à espera. A fila está vazia neste momento.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
