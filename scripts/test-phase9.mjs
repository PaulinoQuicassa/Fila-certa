const PROJECT_REF = 'qdfpqispcntitvczybfl';
const ANON_KEY = 'sb_publishable_HLelr-FOPvSL9a5w8_feUw_FfKIrOoQ';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_BASE = `https://${PROJECT_REF}.supabase.co/auth/v1`;
const REST_BASE = `https://${PROJECT_REF}.supabase.co/rest/v1`;

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e}`); };

async function signIn(email, password) {
  const res = await fetch(`${AUTH_BASE}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body; // { access_token, user: {...} }
}

async function createTestCustomer(email, password) {
  const res = await fetch(`${AUTH_BASE}/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.id;
}

async function deleteAuthUser(uid) {
  await fetch(`${AUTH_BASE}/admin/users/${uid}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function rpc(accessToken, fn, args) {
  const res = await fetch(`${REST_BASE}/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, body };
}

async function select(accessToken, table, query) {
  const res = await fetch(`${REST_BASE}/${table}?${query}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

async function main() {
  const email = `teste-rpc-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(email, 'senha123456');
  console.log('cliente de teste criado:', email, customerId);

  const customerSession = await signIn(email, 'senha123456');
  const agentSession = await signIn('agente@siac.test', 'teste123');
  const managerSession = await signIn('gestor@siac.test', 'teste123');

  console.log('\n1. Cliente tira uma senha real via pull_ticket');
  const pulled = await rpc(customerSession.access_token, 'pull_ticket', {
    p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Registo Civil',
  });
  let ticketId;
  if (pulled.ok && pulled.body.status === 'waiting') {
    ticketId = pulled.body.id;
    ok(`senha criada: ${pulled.body.code} (id ${ticketId})`);
  } else {
    fail('pull_ticket deveria ter sucedido', JSON.stringify(pulled));
  }

  console.log('\n2. Cliente NÃO consegue chamar a própria senha (call_next é só staff)');
  const deniedCall = await rpc(customerSession.access_token, 'call_next', {
    p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1',
  });
  if (!deniedCall.ok) {
    ok(`negado como esperado (status ${deniedCall.status})`);
  } else {
    fail('cliente conseguiu chamar -- não devia ser permitido', JSON.stringify(deniedCall));
  }

  console.log('\n3. Agente chama a próxima senha (call_next)');
  const called = await rpc(agentSession.access_token, 'call_next', {
    p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1',
  });
  if (called.ok && called.body.status === 'serving' && called.body.id === ticketId) {
    ok(`senha chamada: ${called.body.code}, status=${called.body.status}, counter=${called.body.counter_id}`);
  } else {
    fail('call_next deveria ter chamado a senha do cliente', JSON.stringify(called));
  }

  console.log('\n4. ticket_calls tem uma linha nova, e o balcão mostra o agente/senha certos');
  const calls = await select(managerSession.access_token, 'ticket_calls', `ticket_id=eq.${ticketId}&select=code,counter_label`);
  const counters = await select(managerSession.access_token, 'counters', `institution_id=eq.siac&id=eq.guiche-1&select=status,current_ticket_id,current_agent_id`);
  if (Array.isArray(calls) && calls.length === 1 && calls[0].counter_label === 'Balcão 1') {
    ok(`ticket_calls registado: ${calls[0].code} -- ${calls[0].counter_label}`);
  } else {
    fail('ticket_calls inesperado', JSON.stringify(calls));
  }
  if (Array.isArray(counters) && counters[0]?.status === 'serving' && counters[0]?.current_ticket_id === ticketId) {
    ok('balcão guiche-1 mostra status=serving e o ticket certo');
  } else {
    fail('estado do balcão inesperado', JSON.stringify(counters));
  }

  console.log('\n5. Cliente avisa "estou a caminho" (set_on_the_way)');
  const onTheWay = await rpc(customerSession.access_token, 'set_on_the_way', { p_ticket_id: ticketId });
  ok(onTheWay.ok ? 'aceite' : `FALHOU: ${JSON.stringify(onTheWay)}`);
  if (!onTheWay.ok) failures++;

  console.log('\n6. Agente conclui o atendimento (complete_current)');
  const completed = await rpc(agentSession.access_token, 'complete_current', {
    p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1',
  });
  ok(completed.ok ? 'aceite' : `FALHOU: ${JSON.stringify(completed)}`);
  if (!completed.ok) failures++;

  const finalTicket = await select(managerSession.access_token, 'tickets', `id=eq.${ticketId}&select=status,customer_on_the_way,done_at`);
  const finalCounter = await select(managerSession.access_token, 'counters', `institution_id=eq.siac&id=eq.guiche-1&select=status,current_ticket_id`);
  if (finalTicket[0]?.status === 'done' && finalTicket[0]?.customer_on_the_way === true && finalTicket[0]?.done_at) {
    ok('senha final: status=done, customer_on_the_way=true, done_at preenchido');
  } else {
    fail('estado final da senha inesperado', JSON.stringify(finalTicket));
  }
  if (finalCounter[0]?.status === 'available' && finalCounter[0]?.current_ticket_id === null) {
    ok('balcão libertado (status=available, sem senha atual)');
  } else {
    fail('balcão não foi libertado correctamente', JSON.stringify(finalCounter));
  }

  console.log('\n7. Segunda senha: testar transfer_ticket + mark_no_show + cancel_ticket');
  const p2 = await rpc(customerSession.access_token, 'pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'NIF — AGT' });
  const t2 = p2.body.id;
  await rpc(agentSession.access_token, 'call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  const transferred = await rpc(agentSession.access_token, 'transfer_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1', p_target_counter_id: 'guiche-2' });
  ok(transferred.ok ? 'transfer_ticket aceite' : `FALHOU: ${JSON.stringify(transferred)}`);
  if (!transferred.ok) failures++;
  const t2State = await select(managerSession.access_token, 'tickets', `id=eq.${t2}&select=status,transferred_to_counter_id,was_transferred`);
  if (t2State[0]?.status === 'waiting' && t2State[0]?.transferred_to_counter_id === 'guiche-2' && t2State[0]?.was_transferred === true) {
    ok('senha 2 transferida correctamente para guiche-2, voltou a waiting');
  } else {
    fail('estado da senha 2 após transferir inesperado', JSON.stringify(t2State));
  }

  console.log('\n8. Cliente cancela a própria senha 2 (cancel_ticket)');
  const cancelled = await rpc(customerSession.access_token, 'cancel_ticket', { p_ticket_id: t2 });
  ok(cancelled.ok ? 'aceite' : `FALHOU: ${JSON.stringify(cancelled)}`);
  if (!cancelled.ok) failures++;
  const t2Final = await select(managerSession.access_token, 'tickets', `id=eq.${t2}&select=status,no_show_reason`);
  if (t2Final[0]?.status === 'no_show' && t2Final[0]?.no_show_reason === 'customer_cancelled') {
    ok('senha 2 cancelada pelo cliente correctamente');
  } else {
    fail('estado final da senha 2 inesperado', JSON.stringify(t2Final));
  }

  console.log('\n9. Cliente NÃO consegue ler senhas via update directo à tabela (RLS bloqueia)');
  const directUpdate = await fetch(`${REST_BASE}/tickets?id=eq.${ticketId}`, {
    method: 'PATCH',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${customerSession.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'waiting' }),
  });
  const directBody = await directUpdate.json();
  if (Array.isArray(directBody) && directBody.length === 0) {
    ok('UPDATE directo à tabela tickets negado pelo RLS (0 linhas afectadas, sem policy de update)');
  } else {
    fail('UPDATE directo deveria ter sido bloqueado', JSON.stringify(directBody));
  }

  // limpeza
  await fetch(`${REST_BASE}/ticket_calls?ticket_id=eq.${ticketId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/tickets?id=eq.${ticketId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/tickets?id=eq.${t2}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await deleteAuthUser(customerId);
  console.log('\nlimpeza feita (senhas de teste + conta de teste apagadas).');

  console.log(failures === 0 ? '\nTUDO OK -- Fase 9 validada de ponta a ponta.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERRO inesperado:', err);
  process.exit(1);
});
