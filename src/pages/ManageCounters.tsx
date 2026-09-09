import { useEffect, useState } from 'react';
import { assignCounterAgent, listBranchStaff, setCounterServices } from '../lib/queue';
import { resolvePilotInstitution } from '../lib/pilotInstitutions';
import type { Counter, StaffMember } from '../types';

/** Secção "Gerir Balcões" do Dashboard -- autonomia pedida pelo gestor
 * para definir, por balcão: quem o atende (colaborador) e que serviços
 * chama. Sem isto, todos os balcões chamavam qualquer senha em espera,
 * o que não reflecte a realidade de um balcão físico só atender alguns
 * serviços. */
export function ManageCounters({
  institutionId,
  branchId,
  counters,
}: {
  institutionId: string;
  branchId: string;
  counters: Counter[];
}) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [busyCounterId, setBusyCounterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = resolvePilotInstitution(institutionId).services;

  async function refetchStaff() {
    try {
      setStaff(await listBranchStaff(institutionId, branchId));
    } catch {
      // Não crítico para o resto do dashboard continuar a funcionar.
    }
  }

  useEffect(() => {
    refetchStaff();
  }, [institutionId, branchId]);

  const agents = staff.filter((s) => s.role === 'agent');

  async function toggleService(counter: Counter, service: string) {
    const current = counter.services ?? [];
    const next = current.includes(service) ? current.filter((s) => s !== service) : [...current, service];
    setBusyCounterId(counter.id);
    setError(null);
    try {
      await setCounterServices(institutionId, branchId, counter.id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível guardar os serviços.');
    } finally {
      setBusyCounterId(null);
    }
  }

  async function changeAgent(counter: Counter, agentId: string) {
    setBusyCounterId(counter.id);
    setError(null);
    try {
      await assignCounterAgent(institutionId, branchId, counter.id, agentId || null);
      await refetchStaff();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível atribuir o balcão.');
    } finally {
      setBusyCounterId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 17, fontWeight: 700 }}>Gerir Balcões</div>
      <div style={{ fontSize: 13, color: 'var(--fc-text-secondary)' }}>
        Defina que serviços cada balcão atende e quem o opera. Um balcão sem serviços seleccionados continua a chamar
        qualquer senha em espera.
      </div>
      {error && (
        <div className="fc-card" style={{ background: 'var(--fc-orange-bg)', boxShadow: 'none', padding: '12px 16px', fontSize: 13.5 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {counters.map((counter) => {
          const assignedAgent = agents.find((a) => a.counterId === counter.id);
          const busy = busyCounterId === counter.id;
          return (
            <div
              key={counter.id}
              className="fc-card"
              style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, opacity: busy ? 0.6 : 1 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontWeight: 700 }}>{counter.label}</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  Colaborador atribuído
                  <select
                    value={assignedAgent?.id ?? ''}
                    disabled={busy}
                    onChange={(e) => changeAgent(counter, e.target.value)}
                    style={{ fontSize: 13, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--fc-border)' }}
                  >
                    <option value="">— nenhum —</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fc-text-secondary)', marginBottom: 8 }}>
                  Serviços atendidos
                  {counter.services === null || counter.services.length === 0 ? ' — todos (sem restrição)' : ''}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {catalog.map((service) => {
                    const active = counter.services?.includes(service) ?? false;
                    return (
                      <button
                        key={service}
                        type="button"
                        disabled={busy}
                        onClick={() => toggleService(counter, service)}
                        className="fc-pill"
                        style={{
                          cursor: busy ? 'default' : 'pointer',
                          border: 'none',
                          background: active ? 'var(--fc-blue-light)' : 'var(--fc-border)',
                          color: active ? 'var(--fc-blue-dark)' : 'var(--fc-text-secondary)',
                        }}
                      >
                        {service}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
