// Hardening de segurança pedido antes da Fase 10 (least privilege em
// tickets/counters/ticket_calls). Cobre exactamente os 10 cenários
// pedidos, testando SEMPRE os dois planos: REST (SELECT directo) e
// Realtime (entrega de eventos) -- nunca só um dos dois.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL as URL, SUPABASE_ANON_KEY as ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY, TEST_STAFF_PASSWORD } from './lib/test-env.mjs';

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

function client() {
  return createClient(URL, ANON_KEY);
}
const svc = createClient(URL, SERVICE_ROLE_KEY);

async function createTestCustomer(email, password) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.id;
}
async function deleteAuthUser(uid) {
  await fetch(`${URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
}
function subscribed(channel) {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      // Folga curta pós-SUBSCRIBED -- ver nota em test-realtime-delivery.mjs.
      if (status === 'SUBSCRIBED') setTimeout(resolve, 300);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status));
    });
  });
}
function waitForEvent(channel, table, match, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      if (match(payload)) { clearTimeout(timer); resolve(payload); }
    });
  });
}
/** Confirma ausência de evento durante `ms` -- não basta um timeout único
 * de `waitForEvent` (que só prova "não chegou dentro do timeout", não
 * distingue de "chegou tarde"); aqui o objectivo é mesmo provar ausência. */
function expectNoEvent(channel, table, match, ms = 4000) {
  return new Promise((resolve) => {
    let saw = false;
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      if (match(payload)) saw = true;
    });
    setTimeout(() => resolve(!saw), ms);
  });
}

async function main() {
  // --- Fixtures ---
  const emailA = `teste-sec-a-${Date.now()}@example.com`;
  const emailB = `teste-sec-b-${Date.now()}@example.com`;
  const customerAId = await createTestCustomer(emailA, 'senha123456');
  const customerBId = await createTestCustomer(emailB, 'senha123456');
  const customerA = client();
  const customerB = client();
  await customerA.auth.signInWithPassword({ email: emailA, password: 'senha123456' });
  await customerB.auth.signInWithPassword({ email: emailB, password: 'senha123456' });
  const agentSiac = client();
  const managerSiac = client();
  await agentSiac.auth.signInWithPassword({ email: 'agente@siac.test', password: TEST_STAFF_PASSWORD });
  await managerSiac.auth.signInWithPassword({ email: 'gestor@siac.test', password: TEST_STAFF_PASSWORD });

  // Filial temporária na mesma instituição (SIAC), para testar isolamento
  // entre filiais -- os dados de seed só tinham 1 filial por instituição.
  await svc.from('branches').insert({ id: 'balcao-viana-teste', institution_id: 'siac', name: 'Balcão Viana (teste)' });
  await svc.from('counters').insert({ id: 'guiche-1', branch_id: 'balcao-viana-teste', institution_id: 'siac', label: 'Balcão 1' });

  // Senha do cliente A na sua filial normal (siac/balcao-talatona).
  const { data: ticketA } = await customerA.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Registo Civil' });
  // Senha "de outra instituição" -- criada directamente via service role
  // (não pertence a A nem B), só para os testes de leitura cruzada.
  const { data: ticketOther } = await svc.from('tickets').insert({ institution_id: 'banco-exemplo', branch_id: 'agencia-maianga', code: 'SECX01', service: 'Abertura de Conta', status: 'waiting' }).select().single();
  // Senha na filial temporária (mesma instituição do agente/gestor SIAC, filial diferente).
  const { data: ticketOtherBranch } = await svc.from('tickets').insert({ institution_id: 'siac', branch_id: 'balcao-viana-teste', code: 'SECX02', service: 'Registo Civil', status: 'waiting' }).select().single();

  console.log('\n1. Cliente A lê a própria senha (REST)');
  const own = await customerA.from('tickets').select('id').eq('id', ticketA.id).maybeSingle();
  if (own.data?.id === ticketA.id) ok('cliente A lê a própria senha'); else fail('cliente A devia ler a própria senha', JSON.stringify(own));

  // ticketA já não é preciso -- concluída aqui para nunca voltar a ser a
  // mais antiga em espera e distorcer qual das senhas o call_next apanha
  // nos passos seguintes (SKIP LOCKED ordena por created_at asc).
  await svc.from('tickets').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', ticketA.id);

  console.log('\n2. Cliente A NÃO lê a senha do Cliente B (REST + Realtime)');
  const { data: ticketB } = await customerB.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'NIF — AGT' });
  const readB = await customerA.from('tickets').select('id').eq('id', ticketB.id).maybeSingle();
  if (readB.data === null) ok('REST: cliente A não lê a senha do cliente B (0 linhas)'); else fail('cliente A leu a senha do cliente B', JSON.stringify(readB));
  const chanAonB = customerA.channel('sec-test-a-on-b');
  const noEventB = expectNoEvent(chanAonB, 'tickets', (p) => p.new?.id === ticketB.id);
  await subscribed(chanAonB);
  const call2 = await agentSiac.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  if (call2.data?.id !== ticketB.id) fail('teste inconsistente: call_next devia ter apanhado ticketB', JSON.stringify(call2));
  if (await noEventB) ok('Realtime: cliente A não recebe eventos da senha do cliente B'); else fail('cliente A recebeu um evento da senha do cliente B -- FUGA', '');
  await customerA.removeChannel(chanAonB);
  await agentSiac.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });

  console.log('\n3. Cliente A NÃO lê senha de outra instituição (não é dele) (REST)');
  const readOther = await customerA.from('tickets').select('id').eq('id', ticketOther.id).maybeSingle();
  if (readOther.data === null) ok('cliente A não lê senha alheia de outra instituição'); else fail('cliente A leu senha alheia de outra instituição', JSON.stringify(readOther));

  console.log('\n4. Cliente A NÃO lê senha alheia de outra filial da mesma instituição (REST)');
  const readOtherBranch = await customerA.from('tickets').select('id').eq('id', ticketOtherBranch.id).maybeSingle();
  if (readOtherBranch.data === null) ok('cliente A não lê senha alheia da filial Viana (teste)'); else fail('cliente A leu senha alheia doutra filial', JSON.stringify(readOtherBranch));

  console.log('\n5. Atendente (SIAC/balcao-talatona) lê senhas da própria filial (REST)');
  const agentOwnBranch = await agentSiac.from('tickets').select('id').eq('institution_id', 'siac').eq('branch_id', 'balcao-talatona').eq('id', ticketA.id).maybeSingle();
  if (agentOwnBranch.data?.id === ticketA.id) ok('atendente lê senhas da própria filial'); else fail('atendente devia ler senhas da própria filial', JSON.stringify(agentOwnBranch));

  console.log('\n6. Atendente (SIAC/balcao-talatona) NÃO lê nem opera na filial Viana (teste) (REST + RPC)');
  const agentOtherBranch = await agentSiac.from('tickets').select('id').eq('id', ticketOtherBranch.id).maybeSingle();
  if (agentOtherBranch.data === null) ok('REST: atendente não lê a senha da filial Viana (teste)'); else fail('atendente leu senha de outra filial', JSON.stringify(agentOtherBranch));
  const crossBranchCall = await agentSiac.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-viana-teste', p_counter_id: 'guiche-1' });
  if (crossBranchCall.error) ok(`RPC: call_next recusado para a filial Viana (teste) -- ${crossBranchCall.error.message}`); else fail('atendente conseguiu chamar senha noutra filial -- FALHA GRAVE', '');

  console.log('\n7. Gestor (SIAC/balcao-talatona) lê dados do seu âmbito (REST)');
  const managerOwn = await managerSiac.from('counters').select('id').eq('institution_id', 'siac').eq('branch_id', 'balcao-talatona');
  if (Array.isArray(managerOwn.data) && managerOwn.data.length > 0) ok(`gestor lê os ${managerOwn.data.length} balcões da própria filial`); else fail('gestor devia ler os balcões da própria filial', JSON.stringify(managerOwn));

  console.log('\n8. Gestor (SIAC/balcao-talatona) NÃO lê dados fora do seu âmbito (outra filial/instituição) (REST)');
  const managerOtherBranch = await managerSiac.from('tickets').select('id').eq('id', ticketOtherBranch.id).maybeSingle();
  const managerOtherInst = await managerSiac.from('tickets').select('id').eq('id', ticketOther.id).maybeSingle();
  if (managerOtherBranch.data === null && managerOtherInst.data === null) {
    ok('gestor não lê senhas de outra filial nem de outra instituição');
  } else {
    fail('gestor leu dados fora do seu âmbito', JSON.stringify({ managerOtherBranch: managerOtherBranch.data, managerOtherInst: managerOtherInst.data }));
  }

  console.log('\n9. Realtime -- evento autorizado (cliente A recebe a sua própria chamada)');
  const { data: ticketA2 } = await customerA.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Cartão de Residente' });
  const authorizedChannel = customerA.channel('sec-test-authorized');
  const authorizedEvent = waitForEvent(authorizedChannel, 'tickets', (p) => p.new.id === ticketA2.id && p.new.status === 'serving');
  await subscribed(authorizedChannel);
  const call9 = await agentSiac.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  if (call9.error) console.log('  [debug] call_next erro:', call9.error.message);
  else console.log('  [debug] call_next devolveu ticket id=', call9.data?.id, 'esperado=', ticketA2.id, 'status=', call9.data?.status);
  try { await authorizedEvent; ok('cliente A recebeu o evento autorizado da própria senha'); } catch (e) { fail('cliente A não recebeu o seu próprio evento', e.message); }
  await customerA.removeChannel(authorizedChannel);

  console.log('\n10. Realtime -- evento não autorizado (cliente B não recebe a chamada da senha do cliente A)');
  const unauthorizedChannel = customerB.channel('sec-test-unauthorized');
  const noUnauthorizedEvent = expectNoEvent(unauthorizedChannel, 'tickets', (p) => p.new?.id === ticketA2.id);
  await subscribed(unauthorizedChannel);
  await agentSiac.rpc('recall_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  await agentSiac.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  if (await noUnauthorizedEvent) ok('cliente B não recebeu nenhum evento da senha do cliente A'); else fail('cliente B recebeu um evento que não devia -- FUGA', '');
  await customerB.removeChannel(unauthorizedChannel);

  // --- limpeza ---
  await svc.from('ticket_calls').delete().in('ticket_id', [ticketA.id, ticketB.id, ticketA2.id]);
  await svc.from('tickets').delete().in('id', [ticketA.id, ticketB.id, ticketOther.id, ticketOtherBranch.id, ticketA2.id]);
  await svc.from('counters').update({ status: 'available', current_ticket_id: null, current_agent_id: null }).eq('institution_id', 'siac').eq('branch_id', 'balcao-talatona').eq('id', 'guiche-1');
  await svc.from('counters').delete().eq('institution_id', 'siac').eq('branch_id', 'balcao-viana-teste');
  await svc.from('branches').delete().eq('institution_id', 'siac').eq('id', 'balcao-viana-teste');
  await deleteAuthUser(customerAId);
  await deleteAuthUser(customerBId);

  console.log(failures === 0 ? '\nTUDO OK -- hardening de segurança (least privilege) validado nos 10 cenários pedidos.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
