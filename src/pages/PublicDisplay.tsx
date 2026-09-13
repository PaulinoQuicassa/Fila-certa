import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureAnonymousSession } from '../supabase';
import { subscribeBranchWaitStats, subscribeLiveBoard } from '../lib/queue';
import { resolvePilotInstitution } from '../lib/pilotInstitutions';
import type { LiveBoard } from '../types';

function getAudioCtxCtor() {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** Toca um sinal sonoro de duas notas (ding-dong) sem depender de um
 * ficheiro de áudio — gerado via Web Audio API, no [AudioContext]
 * partilhado (persistente) passado por quem chama -- criar um novo de
 * cada vez, como acontecia antes, arrisca ficar sempre "suspended" (a
 * política de autoplay dos browsers só desbloqueia áudio depois de uma
 * interacção do utilizador na página; um painel de TV sem ninguém a
 * tocar nunca teria essa interacção). */
function playCallChime(ctx: AudioContext) {
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
}

export function PublicDisplay() {
  // /painel (sem parâmetro) continua a mostrar o Banco Exemplo, como
  // sempre -- /painel/:institutionId escolhe qualquer uma das 6
  // instituições reais do piloto (ver lib/pilotInstitutions.ts).
  const { institutionId: routeInstitutionId } = useParams<{ institutionId?: string }>();
  const { institutionId: INSTITUTION_ID, branchId: BRANCH_ID, name: INSTITUTION_NAME } = resolvePilotInstitution(routeInstitutionId);

  const [board, setBoard] = useState<LiveBoard>({ current: null, history: [], updatedAt: null });
  const [avg, setAvg] = useState<number | null>(null);
  const [time, setTime] = useState(() => new Date());
  const [ready, setReady] = useState(false);
  const [needsSoundUnlock, setNeedsSoundUnlock] = useState(false);
  const lastCalledAt = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Um só AudioContext para todo o tempo de vida do painel (não um novo
  // por chamada) -- criado logo ao carregar para se conseguir saber
  // desde já se o browser o deixou correr ('running') ou se está à
  // espera de uma interacção ('suspended'), e mostrar o aviso de
  // desbloqueio de som só quando for mesmo preciso.
  useEffect(() => {
    const AudioCtx = getAudioCtxCtor();
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    setNeedsSoundUnlock(ctx.state !== 'running');
    return () => {
      ctx.close();
    };
  }, []);

  function unlockSound() {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    ctx.resume().then(() => setNeedsSoundUnlock(ctx.state !== 'running'));
  }

  useEffect(() => {
    ensureAnonymousSession()
      .catch((err) => console.error('falha ao iniciar sessão anónima do painel público', err))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (board.updatedAt === null) return;
    if (lastCalledAt.current !== null && board.updatedAt !== lastCalledAt.current && audioCtxRef.current) {
      playCallChime(audioCtxRef.current);
    }
    lastCalledAt.current = board.updatedAt;
  }, [board.updatedAt]);

  useEffect(() => {
    if (!ready) return;
    const unsubBoard = subscribeLiveBoard(INSTITUTION_ID, BRANCH_ID, setBoard);
    const unsubStats = subscribeBranchWaitStats(INSTITUTION_ID, BRANCH_ID, setAvg);
    return () => {
      unsubBoard();
      unsubStats();
    };
  }, [ready, INSTITUTION_ID, BRANCH_ID]);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);

  const timeLabel = time.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      style={{
        width: '100%', minHeight: '100vh', color: '#fff', display: 'flex', flexDirection: 'column',
        padding: '44px 64px', position: 'relative', overflow: 'hidden',
        background: 'radial-gradient(120% 140% at 50% -10%, #163a63 0%, #0c2138 55%, #081729 100%)',
      }}
    >
      {needsSoundUnlock && (
        <button
          onClick={unlockSound}
          style={{
            position: 'absolute', inset: 0, zIndex: 10, width: '100%', height: '100%', border: 'none',
            background: 'rgba(8,23,41,0.92)', color: '#fff', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
          }}
        >
          <span style={{ fontSize: 48 }}>🔊</span>
          <span style={{ fontSize: 24, fontWeight: 700 }}>Toque para activar o som das chamadas</span>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
            Só é preciso uma vez -- o browser bloqueia som até haver uma interacção nesta página.
          </span>
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{INSTITUTION_NAME}</span>
        <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
          Chamando agora
        </div>
        <div
          aria-live="assertive"
          aria-atomic="true"
          style={{ fontSize: 180, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}
        >
          {board.current?.code ?? '—'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(255,255,255,0.08)', padding: '14px 32px', borderRadius: 999 }}>
          <span aria-live="polite" style={{ fontSize: 30, fontWeight: 700 }}>{board.current?.counterLabel ?? 'A aguardar'}</span>
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
          Espera média hoje · <strong style={{ color: '#fff' }}>{avg ?? '—'} min</strong>
        </div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>Fila Certa</div>
      </div>
    </div>
  );
}
