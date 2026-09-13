import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { fetchDirectorAlerts, fetchDirectorBenchmarking, fetchDirectorKpis, fetchDirectorTrend } from '../lib/queue';
import type { AlertSeverity, DirectorAlert, DirectorBenchmarkRow, DirectorKpis, DirectorPeriod, DirectorTrendPoint } from '../types';

const SLA_MINUTES = 15; // mesma meta usada no Dashboard do gestor

const PERIODS: { id: DirectorPeriod; label: string }[] = [
  { id: 'hoje', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

const SEVERITY_STYLE: Record<AlertSeverity, { label: string; color: string; bg: string }> = {
  critico: { label: 'Crítico', color: 'var(--fc-danger)', bg: 'var(--fc-danger-bg)' },
  atencao: { label: 'Atenção', color: 'var(--fc-orange)', bg: 'var(--fc-orange-bg)' },
  info: { label: 'Info', color: 'var(--fc-blue-dark)', bg: 'var(--fc-blue-light)' },
};

function fmtTrend(pct: number | null, higherIsBad: boolean): { text: string; color: string } {
  if (pct === null) return { text: '—', color: 'var(--fc-text-secondary)' };
  const sign = pct > 0 ? '+' : '';
  const bad = higherIsBad ? pct > 0 : pct < 0;
  const color = pct === 0 ? 'var(--fc-text-secondary)' : bad ? 'var(--fc-danger)' : 'var(--fc-green)';
  return { text: `${sign}${pct.toFixed(1)}%`, color };
}

function TrendChart({ points }: { points: DirectorTrendPoint[] }) {
  const W = 1000, H = 200, padL = 40, padR = 16, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = points.map((p) => p.avgWaitMinutes ?? 0);
  const rawMax = Math.max(SLA_MINUTES, ...vals, 1);
  const maxVal = Math.ceil((rawMax * 1.15) / 5) * 5;
  const n = points.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const scaleY = (v: number) => padT + plotH - (v / maxVal) * plotH;
  const pts = points.map((p, i) => ({ x: padL + i * xStep, y: scaleY(p.avgWaitMinutes ?? 0), label: p.label, value: p.avgWaitMinutes }));
  const pathD = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
  const metaY = scaleY(SLA_MINUTES);
  const yTicks = [0, maxVal / 2, maxVal];

  if (points.length === 0) {
    return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--fc-text-secondary)', fontSize: 13.5 }}>Sem dados suficientes neste período.</div>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 200, display: 'block' }}>
      {yTicks.map((tick) => (
        <g key={tick}>
          <line x1={padL} y1={scaleY(tick)} x2={W - padR} y2={scaleY(tick)} stroke="var(--fc-border)" strokeWidth={1} />
          <text x={2} y={scaleY(tick)} fontSize={10} fill="var(--fc-text-secondary)" dominantBaseline="middle">{Math.round(tick)} min</text>
        </g>
      ))}
      <line x1={padL} y1={metaY} x2={W - padR} y2={metaY} stroke="#94A3B8" strokeWidth={2} strokeDasharray="5 4" />
      <path d={pathD} stroke="var(--fc-blue)" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((pt) => (
        <g key={pt.label}>
          <circle cx={pt.x} cy={pt.y} r={4} fill="var(--fc-blue)" stroke="#fff" strokeWidth={1.5}>
            <title>{pt.label}: {pt.value ?? '—'} min</title>
          </circle>
          <text x={pt.x} y={H - 8} fontSize={10} fill="var(--fc-text-secondary)" textAnchor="middle">{pt.label}</text>
        </g>
      ))}
    </svg>
  );
}

function AlertCard({ alert }: { alert: DirectorAlert }) {
  const [expanded, setExpanded] = useState(false);
  const style = SEVERITY_STYLE[alert.severity];
  return (
    <div style={{ border: '1px solid var(--fc-border)', borderLeft: `4px solid ${style.color}`, borderRadius: 'var(--fc-radius-md)', padding: '14px 16px' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer' }}
      >
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: style.color, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{style.label}</div>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{alert.title}</div>
        </div>
        <span style={{ fontSize: 13, color: 'var(--fc-text-secondary)', flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--fc-border)', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--fc-text-secondary)', lineHeight: 1.5 }}>
          <div><strong style={{ color: 'var(--fc-text-primary)' }}>Causa provável:</strong> {alert.causa}</div>
          <div><strong style={{ color: 'var(--fc-text-primary)' }}>Previsão:</strong> {alert.previsao}</div>
          <div><strong style={{ color: 'var(--fc-text-primary)' }}>Recomendação:</strong> {alert.recomendacao}</div>
        </div>
      )}
    </div>
  );
}

export function DirectorScreen() {
  const { profile, logout } = useAuth();
  const [period, setPeriod] = useState<DirectorPeriod>('7d');
  const [kpis, setKpis] = useState<DirectorKpis | null>(null);
  const [trend, setTrend] = useState<DirectorTrendPoint[]>([]);
  const [ranking, setRanking] = useState<DirectorBenchmarkRow[]>([]);
  const [alerts, setAlerts] = useState<DirectorAlert[]>([]);
  const [alertFilter, setAlertFilter] = useState<'todos' | AlertSeverity>('todos');
  const [rankSort, setRankSort] = useState<'worst' | 'best'>('worst');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const institutionId = profile?.institutionId ?? '';

  useEffect(() => {
    if (!institutionId) return;
    let active = true;
    setLoading(true);
    Promise.all([
      fetchDirectorKpis(institutionId, period),
      fetchDirectorTrend(institutionId, period),
      fetchDirectorBenchmarking(institutionId, period),
      fetchDirectorAlerts(institutionId, period),
    ])
      .then(([k, t, r, a]) => {
        if (!active) return;
        setKpis(k);
        setTrend(t);
        setRanking(r);
        setAlerts(a);
        setError(null);
      })
      .catch((err) => {
        if (active) setError('Não foi possível carregar o painel. Tente novamente.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [institutionId, period]);

  const filteredAlerts = alertFilter === 'todos' ? alerts : alerts.filter((a) => a.severity === alertFilter);
  const criticalCount = alerts.filter((a) => a.severity === 'critico').length;
  const sortedRanking = useMemo(
    () => [...ranking].sort((a, b) => (rankSort === 'worst' ? a.score - b.score : b.score - a.score)),
    [ranking, rankSort],
  );

  if (!profile) return null;

  const waitTrend = fmtTrend(kpis?.avgWaitTrendPct ?? null, true);
  const satTrend = fmtTrend(kpis?.avgSatisfactionTrendPct ?? null, false);
  const abandonTrend = fmtTrend(kpis?.abandonmentTrendPct ?? null, true);
  const completedTrend = fmtTrend(kpis?.completedTrendPct ?? null, false);

  return (
    <div style={{ minHeight: '100vh', padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="fc-card" style={{ padding: '20px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Painel de Inteligência</div>
            <div style={{ fontSize: 13, color: 'var(--fc-text-secondary)' }}>{profile.institutionId} · Direcção Geral</div>
          </div>
          <div style={{ display: 'flex', gap: 4, background: 'var(--fc-bg)', borderRadius: 999, padding: 4 }}>
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                style={{ padding: '8px 16px', borderRadius: 999, fontSize: 13, fontWeight: 700, background: period === p.id ? 'var(--fc-blue-dark)' : 'transparent', color: period === p.id ? '#fff' : 'var(--fc-text-secondary)' }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => logout()} style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>
          Terminar sessão
        </button>
      </div>

      {error && (
        <div className="fc-card" style={{ background: 'var(--fc-danger-bg)', boxShadow: 'none', padding: '14px 20px', color: 'var(--fc-danger)', fontSize: 13.5, fontWeight: 600 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--fc-text-secondary)' }}>A carregar…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 20 }}>
            <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Tempo médio de espera</div>
              <div style={{ fontSize: 29, fontWeight: 800 }}>{kpis?.avgWaitMinutes ?? '—'} min</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: waitTrend.color }}>{waitTrend.text} <span style={{ color: 'var(--fc-text-secondary)', fontWeight: 400 }}>vs período anterior</span></div>
            </div>
            <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Satisfação média</div>
              <div style={{ fontSize: 29, fontWeight: 800 }}>{kpis?.avgSatisfaction?.toFixed(1) ?? '—'}/5</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: satTrend.color }}>{satTrend.text} <span style={{ color: 'var(--fc-text-secondary)', fontWeight: 400 }}>vs período anterior</span></div>
            </div>
            <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Taxa de abandono</div>
              <div style={{ fontSize: 29, fontWeight: 800 }}>{kpis?.abandonmentPct?.toFixed(1) ?? '—'}%</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: abandonTrend.color }}>{abandonTrend.text} <span style={{ color: 'var(--fc-text-secondary)', fontWeight: 400 }}>vs período anterior</span></div>
            </div>
            <div className="fc-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fc-text-secondary)' }}>Atendimentos concluídos</div>
              <div style={{ fontSize: 29, fontWeight: 800 }}>{kpis?.completedCount ?? 0}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: completedTrend.color }}>{completedTrend.text} <span style={{ color: 'var(--fc-text-secondary)', fontWeight: 400 }}>vs período anterior</span></div>
            </div>
          </div>

          <div className="fc-card" style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Tendência — tempo de espera vs meta SLA</div>
              <div style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--fc-text-secondary)' }}>
                <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'var(--fc-blue)', borderRadius: 2, marginRight: 6 }} />Tempo real</span>
                <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #94A3B8', marginRight: 6 }} />Meta SLA ({SLA_MINUTES} min)</span>
              </div>
            </div>
            <TrendChart points={trend} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20, alignItems: 'start' }}>
            <div className="fc-card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Alertas automáticos</div>
                {criticalCount > 0 && (
                  <span className="fc-pill" style={{ background: 'var(--fc-danger-bg)', color: 'var(--fc-danger)' }}>{criticalCount} crítico(s)</span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fc-text-secondary)', marginBottom: 14 }}>
                Gerados por regras sobre os dados reais das filiais (não é um modelo preditivo) — ver causa/recomendação em cada alerta.
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {(['todos', 'critico', 'atencao', 'info'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setAlertFilter(f)}
                    className="fc-pill"
                    style={{
                      cursor: 'pointer', border: '1px solid var(--fc-border)',
                      background: alertFilter === f ? 'var(--fc-blue-dark)' : '#fff',
                      color: alertFilter === f ? '#fff' : 'var(--fc-text-secondary)',
                    }}
                  >
                    {f === 'todos' ? 'Todos' : SEVERITY_STYLE[f].label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredAlerts.length === 0 ? (
                  <div style={{ fontSize: 13.5, color: 'var(--fc-text-secondary)' }}>Sem alertas neste período.</div>
                ) : (
                  filteredAlerts.map((a, i) => <AlertCard key={`${a.branchId}-${i}`} alert={a} />)
                )}
              </div>
            </div>

            <div className="fc-card" style={{ padding: '22px 24px' }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Benchmarking entre filiais</div>
              <div style={{ fontSize: 12.5, color: 'var(--fc-text-secondary)', marginBottom: 14 }}>Score composto: tempo de espera, satisfação e abandono</div>
              <button
                onClick={() => setRankSort((s) => (s === 'worst' ? 'best' : 'worst'))}
                className="fc-btn fc-btn--secondary"
                style={{ marginBottom: 14 }}
              >
                {rankSort === 'worst' ? 'Piores primeiro' : 'Melhores primeiro'}
              </button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {sortedRanking.length === 0 ? (
                  <div style={{ fontSize: 13.5, color: 'var(--fc-text-secondary)' }}>Sem dados neste período.</div>
                ) : (
                  sortedRanking.map((r, i) => {
                    const statusColor = r.score >= 80 ? 'var(--fc-green)' : r.score >= 60 ? 'var(--fc-orange)' : 'var(--fc-danger)';
                    return (
                      <div key={r.branchId} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ width: 14, paddingTop: 8, fontSize: 12, color: 'var(--fc-text-secondary)', fontWeight: 700 }}>{i + 1}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{r.branchName}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>{r.score}</div>
                          </div>
                          <div style={{ height: 6, background: 'var(--fc-bg)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${r.score}%`, background: statusColor, borderRadius: 4 }} />
                          </div>
                          <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 11, color: 'var(--fc-text-secondary)' }}>
                            <span>{r.avgWaitMinutes ?? '—'} min espera</span>
                            <span>{r.avgSatisfaction?.toFixed(1) ?? '—'}/5 satisfação</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
