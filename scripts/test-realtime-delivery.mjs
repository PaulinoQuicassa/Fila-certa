// Fase 8: prova real de ENTREGA via Supabase Realtime (não só o estado
// final na base de dados via REST, que já foi validado nas Fases 9/10/12).
// Usa @supabase/supabase-js directamente (mesmo pacote da app React),
// um cliente por papel, cada um autenticado a sério e a subscrever
// canais postgres_changes, exactamente como queue.ts/ticket_service.dart
// fazem hoje.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'https://qdfpqispcntitvczybfl.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_HLelr-FOPvSL9a5w8_feUw_FfKIrOoQ';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

function client() {
  return createClient(URL, ANON_KEY, { realtime: { params: { eventsPerSecond: 10 } } });
}

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

/** Espera um evento postgres_changes que satisfaça `match`, com timeout. */
function waitForEvent(channel, table, match, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout à espera de evento em ${table}`)), timeoutMs);
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      if (match(payload)) {
        clearTimeout(timer);
        resolve(payload);
      }
    });
  });
}

function subscribed(channel) {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status));
    });
  });
}

async function main() {
  const email = `teste-realtime-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(email, 'senha123456');

  const customer = client();
  const agent = client();
  const manager = client();
  await customer.auth.signInWithPassword({ email, password: 'senha123456' });
  await agent.auth.signInWithPassword({ email: 'agente@siac.test', password: 'teste123' });
  await manager.auth.signInWithPassword({ email: 'gestor@siac.test', password: 'teste123' });

  // --- Cenário: cliente A entra na fila -> atendente recebe a nova senha em tempo real
  console.log('\n1. Atendente recebe INSERT em tickets (SIAC, balcao-talatona) via Realtime quando o cliente tira uma senha');
  const agentChannel = agent.channel('rt-test-agent-tickets');
  const newTicketEvent = waitForEvent(agentChannel, 'tickets', (p) => p.eventType === 'INSERT' && p.new.institution_id === 'siac');
  await subscribed(agentChannel);
  const { data: pulled, error: pullErr } = await customer.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Registo Civil' });
  if (pullErr) fail('pull_ticket falhou', pullErr.message);
  try {
    const ev = await newTicketEvent;
    ok(`atendente recebeu INSERT via Realtime: código ${ev.new.code}`);
  } catch (e) {
    fail('atendente não recebeu o INSERT via Realtime', e.message);
  }
  await agent.removeChannel(agentChannel);
  const ticketId = pulled.id;

  // --- Cenário: atendente chama a senha -> cliente recebe a chamada em tempo real (UPDATE no seu próprio ticket)
  console.log('\n2. Cliente recebe UPDATE no seu ticket via Realtime quando o atendente chama (call_next)');
  const customerTicketChannel = customer.channel(`rt-test-customer-ticket-${ticketId}`);
  const calledEvent = waitForEvent(customerTicketChannel, 'tickets', (p) => p.new.id === ticketId && p.new.status === 'serving');
  await subscribed(customerTicketChannel);
  const { error: callErr } = await agent.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  if (callErr) fail('call_next falhou', callErr.message);
  try {
    await calledEvent;
    ok('cliente recebeu status=serving via Realtime assim que o atendente chamou');
  } catch (e) {
    fail('cliente não recebeu a chamada via Realtime', e.message);
  }

  // --- Cenário: cliente avisa "estou a caminho" -> atendente vê em tempo real (mesmo canal do balcão)
  console.log('\n3. Atendente recebe customer_on_the_way=true via Realtime');
  const agentCounterChannel = manager.channel('rt-test-manager-tickets-2');
  const onTheWayEvent = waitForEvent(agentCounterChannel, 'tickets', (p) => p.new.id === ticketId && p.new.customer_on_the_way === true);
  await subscribed(agentCounterChannel);
  const { error: otwErr } = await customer.rpc('set_on_the_way', { p_ticket_id: ticketId });
  if (otwErr) fail('set_on_the_way falhou', otwErr.message);
  try {
    await onTheWayEvent;
    ok('"estou a caminho" chegou via Realtime');
  } catch (e) {
    fail('"estou a caminho" não chegou via Realtime', e.message);
  }
  await manager.removeChannel(agentCounterChannel);

  // --- Cenário: atendimento concluído -> painel/gestor vê counters mudar via Realtime
  console.log('\n4. Conclusão do atendimento reflecte-se em counters via Realtime (painel/gestor)');
  const countersChannel = manager.channel('rt-test-counters');
  const counterFreedEvent = waitForEvent(countersChannel, 'counters', (p) => p.new.id === 'guiche-1' && p.new.institution_id === 'siac' && p.new.status === 'available');
  await subscribed(countersChannel);
  const { error: completeErr } = await agent.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  if (completeErr) fail('complete_current falhou', completeErr.message);
  try {
    await counterFreedEvent;
    ok('balcão voltou a status=available via Realtime assim que o atendimento foi concluído');
  } catch (e) {
    fail('balcão não actualizou via Realtime', e.message);
  }
  await manager.removeChannel(countersChannel);

  // --- Cenário: transferência -- 2ª senha, atendente chama e transfere, cliente vê voltar a waiting
  console.log('\n5. Transferência: cliente vê a sua senha voltar a "waiting" via Realtime');
  const { data: pulled2 } = await customer.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'NIF — AGT' });
  const ticketId2 = pulled2.id;
  await agent.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  const transferChannel = customer.channel(`rt-test-transfer-${ticketId2}`);
  const transferredEvent = waitForEvent(transferChannel, 'tickets', (p) => p.new.id === ticketId2 && p.new.status === 'waiting' && p.new.transferred_to_counter_id === 'guiche-2');
  await subscribed(transferChannel);
  const { error: transferErr } = await agent.rpc('transfer_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1', p_target_counter_id: 'guiche-2' });
  if (transferErr) fail('transfer_ticket falhou', transferErr.message);
  try {
    await transferredEvent;
    ok('cliente viu a transferência (voltou a waiting, reservada a guiche-2) via Realtime');
  } catch (e) {
    fail('cliente não viu a transferência via Realtime', e.message);
  }
  await customer.removeChannel(transferChannel);

  // --- Cenário: cliente cancela -- atendente/gestor vê no_show em tempo real
  console.log('\n6. Cancelamento pelo cliente aparece via Realtime para o gestor');
  const cancelChannel = manager.channel('rt-test-cancel');
  const cancelledEvent = waitForEvent(cancelChannel, 'tickets', (p) => p.new.id === ticketId2 && p.new.status === 'no_show' && p.new.no_show_reason === 'customer_cancelled');
  await subscribed(cancelChannel);
  const { error: cancelErr } = await customer.rpc('cancel_ticket', { p_ticket_id: ticketId2 });
  if (cancelErr) fail('cancel_ticket falhou', cancelErr.message);
  try {
    await cancelledEvent;
    ok('cancelamento do cliente chegou via Realtime');
  } catch (e) {
    fail('cancelamento não chegou via Realtime', e.message);
  }
  await manager.removeChannel(cancelChannel);

  // --- Cenário: pausar/retomar balcão -- cliente que está a ser atendido vê o balcão pausar
  console.log('\n7. Pausar/retomar balcão: quem está a ser atendido recebe via Realtime');
  const { data: pulled3 } = await customer.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Cartão de Residente' });
  await agent.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  const pauseChannel = customer.channel('rt-test-pause');
  const pausedEvent = waitForEvent(pauseChannel, 'counters', (p) => p.new.id === 'guiche-1' && p.new.institution_id === 'siac' && p.new.status === 'paused');
  await subscribed(pauseChannel);
  const { error: pauseErr } = await agent.rpc('set_counter_paused', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1', p_paused: true });
  if (pauseErr) fail('set_counter_paused falhou', pauseErr.message);
  try {
    await pausedEvent;
    ok('cliente recebeu status=paused do balcão via Realtime');
  } catch (e) {
    fail('cliente não recebeu a pausa via Realtime', e.message);
  }
  await customer.removeChannel(pauseChannel);
  await agent.rpc('set_counter_paused', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1', p_paused: false });
  await agent.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });

  // --- Cenário 8a (actualizado pelo hardening de segurança -- ver
  // supabase/migrations/20260906220000_least_privilege_hardening.sql e
  // docs/security-rls.md): `tickets` deixou de ter leitura aberta a
  // qualquer autenticado. Um segundo cliente já NÃO deve receber, via
  // Realtime, eventos de uma senha que não é dele. Cobertura mais
  // extensa (cruzando instituição/filial/papel) em
  // scripts/test-security-hardening.mjs.
  console.log('\n8a. tickets: least privilege -- cliente B NÃO recebe eventos de uma senha de outro cliente (antes desta fase, recebia)');
  const email2 = `teste-realtime-b-${Date.now()}@example.com`;
  const customerBId = await createTestCustomer(email2, 'senha123456');
  const customerB = client();
  await customerB.auth.signInWithPassword({ email: email2, password: 'senha123456' });
  const { data: pulledA } = await customer.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Passaporte e Residência' });
  const openReadChannel = customerB.channel(`rt-test-open-read-${pulledA.id}`);
  let sawOpenReadEvent = false;
  openReadChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `id=eq.${pulledA.id}` }, () => { sawOpenReadEvent = true; });
  await subscribed(openReadChannel);
  await agent.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  await new Promise((r) => setTimeout(r, 4000));
  if (!sawOpenReadEvent) {
    ok('cliente B não recebeu nenhum evento da senha do cliente A -- hardening confirmado também via Realtime');
  } else {
    fail('cliente B recebeu um evento de tickets que não devia ver -- FUGA DE DADOS', '');
  }
  await customerB.removeChannel(openReadChannel);
  await agent.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });

  // --- Cenário 8b: `appointments` É isolado por customer_id (RLS
  // dual-audience, security.md Decisão 3) -- este sim tem de bloquear.
  console.log('\n8b. appointments: isolamento real por customer_id -- cliente B não pode ver um agendamento do cliente A');
  const apptCode = `RTB-${Date.now()}`;
  const svcForInsert = createClient(URL, SERVICE_ROLE_KEY);
  await svcForInsert.from('appointments').insert({ code: apptCode, institution_id: 'siac', branch_id: 'balcao-talatona', customer_id: customerId, service: 'Registo Civil', date: '2026-09-20', time: '09:00' });
  const apptChannel = customerB.channel(`rt-test-appt-isolation-${apptCode}`);
  let sawApptEvent = false;
  apptChannel.on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `code=eq.${apptCode}` }, () => { sawApptEvent = true; });
  await subscribed(apptChannel);
  await svcForInsert.from('appointments').update({ status: 'cancelled' }).eq('code', apptCode);
  await new Promise((r) => setTimeout(r, 4000));
  if (!sawApptEvent) {
    ok('cliente B não recebeu o evento do agendamento do cliente A (RLS isola appointments por customer_id, também via Realtime)');
  } else {
    fail('cliente B recebeu um evento de appointments que não devia ver -- FUGA DE DADOS', '');
  }
  await customerB.removeChannel(apptChannel);
  await svcForInsert.from('appointments').delete().eq('code', apptCode);

  // limpeza
  const cleanup = async () => {
    const svc = createClient(URL, SERVICE_ROLE_KEY);
    await svc.from('ticket_calls').delete().in('ticket_id', [ticketId, ticketId2, pulled3.id, pulledA.id]);
    await svc.from('tickets').delete().in('id', [ticketId, ticketId2, pulled3.id, pulledA.id]);
    await svc.from('counters').update({ status: 'available', current_ticket_id: null, current_agent_id: null }).eq('institution_id', 'siac').in('id', ['guiche-1', 'guiche-2']);
  };
  await cleanup();
  await deleteAuthUser(customerId);
  await deleteAuthUser(customerBId);

  console.log(failures === 0 ? '\nTUDO OK -- entrega real via Supabase Realtime confirmada para todos os cenários da Fase 8.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
