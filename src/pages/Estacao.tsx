import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ensureStationSession } from '../supabase';
import { pullTicket } from '../lib/queue';
import { resolvePilotInstitution } from '../lib/pilotInstitutions';

// Depois de mostrar a senha, volta sozinho ao ecrã de escolha de
// serviço -- um quiosque físico não deve ficar preso à espera de
// alguém tocar num botão de "voltar".
const RESET_AFTER_MS = 15_000;

type Stage = 'loading' | 'ready' | 'pulling' | 'done' | 'error';

/** Estação de auto-atendimento (`/estacao`) -- para quem chega
 * fisicamente ao balcão sem telemóvel/conta própria. Pensada para
 * correr num tablet/quiosque fixo à entrada: sem login visível, sem
 * dados pessoais pedidos -- todas as senhas tiradas aqui ficam
 * associadas à conta técnica de estação (`ensureStationSession`), nunca
 * a uma pessoa identificável. */
export function Estacao() {
  // /estacao (sem parâmetro) continua a mostrar o Banco Exemplo, como
  // sempre -- /estacao/:institutionId escolhe qualquer uma das 6
  // instituições reais do piloto (ver lib/pilotInstitutions.ts).
  const { institutionId: routeInstitutionId } = useParams<{ institutionId?: string }>();
  const { institutionId: INSTITUTION_ID, branchId: BRANCH_ID, name: INSTITUTION_NAME, services: SERVICES } =
    resolvePilotInstitution(routeInstitutionId);

  const [stage, setStage] = useState<Stage>('loading');
  const [ticketCode, setTicketCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    ensureStationSession()
      .then(() => setStage('ready'))
      .catch((err: Error) => {
        setErrorMessage('Não foi possível preparar a estação. Tente novamente.');
        setStage('error');
      });
  }, []);

  useEffect(() => {
    if (stage !== 'done') return;
    const id = setTimeout(() => {
      setTicketCode(null);
      setStage('ready');
    }, RESET_AFTER_MS);
    return () => clearTimeout(id);
  }, [stage]);

  async function handleSelectService(service: string) {
    setStage('pulling');
    try {
      const code = await pullTicket(INSTITUTION_ID, BRANCH_ID, service);
      setTicketCode(code);
      setStage('done');
    } catch {
      // Nunca mostrar o erro técnico a quem está à frente do quiosque
      // (secção "UX de erros" do redesign) -- só o suficiente para
      // tentar de novo.
      setErrorMessage('Não foi possível emitir a senha. Tente novamente.');
      setStage('error');
    }
  }

  return (
    <div
      style={{
        width: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 48, boxSizing: 'border-box',
        background: '#FFFCF7', color: '#2C2C2A', fontFamily: 'system-ui, sans-serif', textAlign: 'center',
        gap: 28,
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color: '#5F5E5A' }}>{INSTITUTION_NAME}</div>

      {stage === 'loading' && <div style={{ fontSize: 22 }}>A preparar a estação…</div>}

      {stage === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#DC2626' }}>{errorMessage}</div>
          <button
            onClick={() => {
              setErrorMessage(null);
              setStage('loading');
              ensureStationSession()
                .then(() => setStage('ready'))
                .catch((err: Error) => {
                  setErrorMessage('Não foi possível preparar a estação. Tente novamente.');
                  setStage('error');
                });
            }}
            style={{ fontSize: 20, fontWeight: 700, padding: '16px 32px', borderRadius: 16, border: 'none', background: '#D85A30', color: '#fff', cursor: 'pointer' }}
          >
            Tentar novamente
          </button>
        </div>
      )}

      {(stage === 'ready' || stage === 'pulling') && (
        <>
          <div style={{ fontSize: 32, fontWeight: 800 }}>Que serviço pretende?</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 20, width: '100%', maxWidth: 640 }}>
            {SERVICES.map((service) => (
              <button
                key={service}
                onClick={() => handleSelectService(service)}
                disabled={stage === 'pulling'}
                style={{
                  fontSize: 22, fontWeight: 700, padding: '32px 20px', borderRadius: 20,
                  border: '1px solid #D3D1C7', background: '#fff', color: '#2C2C2A',
                  cursor: stage === 'pulling' ? 'default' : 'pointer', opacity: stage === 'pulling' ? 0.6 : 1,
                }}
              >
                {service}
              </button>
            ))}
          </div>
          {stage === 'pulling' && <div style={{ fontSize: 18, color: '#5F5E5A' }}>A emitir a sua senha…</div>}
        </>
      )}

      {stage === 'done' && ticketCode && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 600, color: '#5F5E5A' }}>A sua senha é</div>
          <div style={{ fontSize: 140, fontWeight: 800, lineHeight: 1, fontFamily: 'monospace', color: '#D85A30' }}>{ticketCode}</div>
          <div style={{ fontSize: 20, color: '#5F5E5A' }}>Aguarde a chamada no painel.</div>
        </div>
      )}
    </div>
  );
}
