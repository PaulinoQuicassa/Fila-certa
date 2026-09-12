// Fase 12 (docs/migration-plan.md): dois cenários da secção de testes
// ainda não cobertos pelas Fases 9/10 -- concorrência (secção 21 do
// mandato) e isolamento entre instituições (RBAC/RLS por papel).
import { SUPABASE_URL as BASE_URL, SUPABASE_ANON_KEY as ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY, TEST_STAFF_PASSWORD } from './lib/test-env.mjs';

const AUTH_BASE = `${BASE_URL}/auth/v1`;
const REST_BASE = `${BASE_URL}/rest/v1`;

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e}`); };

async function signIn(email, password) {
  const res = await fetch(`${AUTH_BASE}/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}
async function createTestCustomer(email, password) {
  const res = await fetch(`${AUTH_BASE}/admin/users`, { method: 'POST', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.id;
}
async function deleteAuthUser(uid) {
  await fetch(`${AUTH_BASE}/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
}
async function rpc(token, fn, args) {
  const res = await fetch(`${REST_BASE}/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}
async function del(table, query) {
  await fetch(`${REST_BASE}/${table}?${query}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
}
async function patch(table, query, data) {
  await fetch(`${REST_BASE}/${table}?${query}`, { method: 'PATCH', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

async function main() {
  const email = `teste-p12-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(email, 'senha123456');
  const customerSession = await signIn(email, 'senha123456');

  // --- Cenário 1: concorrência -- dois balcões do mesmo branch a chamar
  // call_next ao mesmo tempo nunca podem ficar com a mesma senha.
  console.log('\n1. Concorrência: guiche-1 e guiche-2 do SIAC chamam em simultâneo');
  const agentSiac = await signIn('agente@siac.test', TEST_STAFF_PASSWORD);
  const t1 = (await rpc(customerSession.access_token, 'pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Registo Civil' })).body;
  const t2 = (await rpc(customerSession.access_token, 'pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'NIF — AGT' })).body;
  const [call1, call2] = await Promise.all([
    rpc(agentSiac.access_token, 'call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' }),
    rpc(agentSiac.access_token, 'call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-2' }),
  ]);
  const ids = [call1, call2].filter((c) => c.ok).map((c) => c.body.id);
  if (call1.ok && call2.ok && ids[0] !== ids[1] && new Set(ids).size === 2) {
    ok(`guiche-1 apanhou ${call1.body.code}, guiche-2 apanhou ${call2.body.code} -- nunca a mesma senha`);
  } else {
    fail('concorrência falhou -- balcões deviam ter apanhado senhas diferentes', JSON.stringify({ call1: call1.body, call2: call2.body }));
  }
  // limpeza deste cenário
  await patch('counters', 'institution_id=eq.siac&id=in.(guiche-1,guiche-2)', { status: 'available', current_ticket_id: null, current_agent_id: null });
  await del('ticket_calls', `ticket_id=in.(${t1.id},${t2.id})`);
  await del('tickets', `id=in.(${t1.id},${t2.id})`);

  // --- Cenário 2: RBAC entre instituições -- um agente do SIAC não pode
  // chamar/concluir/transferir senhas de outra instituição (banco-exemplo).
  console.log('\n2. RBAC entre instituições: agente do SIAC não pode operar no Banco Exemplo');
  const t3 = (await rpc(customerSession.access_token, 'pull_ticket', { p_institution_id: 'banco-exemplo', p_branch_id: 'agencia-maianga', p_service: 'Abertura de Conta' })).body;
  const crossCall = await rpc(agentSiac.access_token, 'call_next', { p_institution_id: 'banco-exemplo', p_branch_id: 'agencia-maianga', p_counter_id: 'guiche-1' });
  if (!crossCall.ok) {
    ok(`agente do SIAC foi recusado a chamar no Banco Exemplo (status ${crossCall.status}: ${crossCall.body?.message ?? ''})`);
  } else {
    fail('agente do SIAC NÃO devia conseguir chamar senhas do Banco Exemplo', JSON.stringify(crossCall));
  }
  const t3State = await fetch(`${REST_BASE}/tickets?id=eq.${t3.id}&select=status`, { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }).then((r) => r.json());
  if (t3State[0]?.status === 'waiting') {
    ok('a senha do Banco Exemplo continua em waiting -- a tentativa não teve nenhum efeito');
  } else {
    fail('a senha do Banco Exemplo não devia ter mudado de estado', JSON.stringify(t3State));
  }
  await del('tickets', `id=eq.${t3.id}`);

  // --- Cenário 3: um cliente não pode ler avaliações/agendamentos doutro customer_id
  console.log('\n3. Um cliente não vê agendamentos/avaliações doutro cliente (RLS)');
  const otherEmail = `teste-p12-other-${Date.now()}@example.com`;
  const otherId = await createTestCustomer(otherEmail, 'senha123456');
  await fetch(`${REST_BASE}/appointments`, {
    method: 'POST', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: `P12-${Date.now()}`, institution_id: 'siac', branch_id: 'balcao-talatona', customer_id: otherId, service: 'Passaporte e Residência', date: '2026-09-15', time: '09:00' }),
  });
  const seenByCustomer = await fetch(`${REST_BASE}/appointments?customer_id=eq.${otherId}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${customerSession.access_token}` } }).then((r) => r.json());
  if (Array.isArray(seenByCustomer) && seenByCustomer.length === 0) {
    ok('cliente A não consegue ler o agendamento do cliente B (RLS filtra para 0 linhas)');
  } else {
    fail('cliente A não devia ver o agendamento do cliente B', JSON.stringify(seenByCustomer));
  }
  await del('appointments', `customer_id=eq.${otherId}`);
  await deleteAuthUser(otherId);

  await deleteAuthUser(customerId);
  console.log(failures === 0 ? '\nTUDO OK -- cenários de concorrência e isolamento da Fase 12 validados.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
