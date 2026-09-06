import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import { subscribeLiveBoard, subscribeTicketsToday } from '../lib/queue';
import type { LiveBoard, Ticket } from '../types';

/** Toca um sinal sonoro de duas notas (ding-dong) sem depender de um
 * ficheiro de áudio — gerado via Web Audio API. */
function playCallChime() {
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  const notes: Array<[frequency: number, start: number]> = [[880, 0], [660, 0.22]];
  notes.forEach(([frequency, start]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime + start;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  });
  setTimeout(() => ctx.close(), 1000);
}

// Institution/branch fixas para o piloto — ver README para como isto
// deixa de ser hardcoded quando houver mais do que uma agência.
const INSTITUTION_ID = import.meta.env.VITE_INSTITUTION_ID ?? 'banco-exemplo';
const BRANCH_ID = import.meta.env.VITE_BRANCH_ID ?? 'agencia-maianga';
const INSTITUTION_NAME = import.meta.env.VITE_INSTITUTION_NAME ?? 'Banco Exemplo · Agência Maianga';

function average(tickets: Ticket[]): number | null {
  const done = tickets.filter((t) => t.calledAt && t.createdAt);
  if (done.length === 0) return null;
  const total = done.reduce((sum, t) => sum + (t.calledAt! - t.createdAt), 0);
  return Math.round(total / done.length / 60000);
}

export function PublicDisplay() {
  const [board, setBoard] = useState<LiveBoard>({ current: null, history: [], updatedAt: null });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [time, setTime] = useState(() => new Date());
  const [ready, setReady] = useState(false);
  const lastCalledAt = useRef<number | null>(null);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => (data.session ? null : supabase.auth.signInAnonymously()))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (board.updatedAt === null) return;
    if (lastCalledAt.current !== null && board.updatedAt !== lastCalledAt.current) {
      playCallChime();
    }
    lastCalledAt.current = board.updatedAt;
  }, [board.updatedAt]);

  useEffect(() => {
    if (!ready) return;
    const unsubBoard = subscribeLiveBoard(INSTITUTION_ID, BRANCH_ID, setBoard);
    const unsubTickets = subscribeTicketsToday(INSTITUTION_ID, BRANCH_ID, setTickets);
    return () => {
      unsubBoard();
      unsubTickets();
    };
  }, [ready]);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);

  const avg = average(tickets);
  const timeLabel = time.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      style={{
        width: '100%', minHeight: '100vh', color: '#fff', display: 'flex', flexDirection: 'column',
        padding: '44px 64px', position: 'relative', overflow: 'hidden',
        background: 'radial-gradient(120% 140% at 50% -10%, #163a63 0%, #0c2138 55%, #081729 100%)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{INSTITUTION_NAME}</span>
        <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
          Chamando agora
        </div>
        <div style={{ fontSize: 180, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em' }}>
          {board.current?.code ?? '—'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(255,255,255,0.08)', padding: '14px 32px', borderRadius: 999 }}>
          <span style={{ fontSize: 30, fontWeight: 700 }}>{board.current?.counterLabel ?? 'Aguardando'}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, paddingBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.45)', marginRight: 8 }}>Chamadas anteriores</span>
        {board.history.map((h, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 999, padding: '8px 18px' }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{h.code}</span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>{h.counterLabel}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.6)' }}>
          Tempo médio de espera hoje: <strong style={{ color: '#fff' }}>{avg ?? '—'} min</strong>
        </div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>Fila Certa</div>
      </div>
    </div>
  );
}
