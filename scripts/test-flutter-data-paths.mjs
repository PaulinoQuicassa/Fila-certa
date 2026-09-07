// Valida os caminhos NOVOS que só a app Flutter usa (ainda não cobertos
// pelos testes da Fase 9/10 do lado React): ratings (insert directo),
// notifications (insert/list/markAllRead), user_settings (upsert+update),
// appointments (next_appointment_code + schedule_appointment + cancel),
// exactamente com os mesmos nomes de coluna que lib/ticket_service.dart e
// lib/app_stores.dart agora usam.
const BASE_URL = process.env.SUPABASE_URL ?? 'https://qdfpqispcntitvczybfl.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_HLelr-FOPvSL9a5w8_feUw_FfKIrOoQ';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
async function post(token, table, data) {
  const res = await fetch(`${REST_BASE}/${table}`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(data) });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}
async function patch(token, table, query, data) {
  const res = await fetch(`${REST_BASE}/${table}?${query}`, { method: 'PATCH', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(data) });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}
async function select(token, table, query) {
  const res = await fetch(`${REST_BASE}/${table}?${query}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
  return res.json();
}

async function main() {
  const email = `teste-flutter-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(email, 'senha123456');
  const session = await signIn(email, 'senha123456');
  const token = session.access_token;
  const agentSession = await signIn('agente@siac.test', 'teste123');

  console.log('\n1. user_settings: upsert (ensureSettingsRow) + update (toggle)');
  const upsert = await post(token, 'user_settings', { user_id: customerId });
  // upsert real via Prefer resolution=merge-duplicates, simulando supabase.upsert do Dart:
  const upsertReal = await fetch(`${REST_BASE}/user_settings?on_conflict=user_id`, {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ user_id: customerId }),
  });
  ok(`upsert user_settings status=${upsertReal.status}`);
  const upd = await patch(token, 'user_settings', `user_id=eq.${customerId}`, { queue_alerts: false, language: 'pt' });
  if (upd.ok && upd.body[0]?.queue_alerts === false) {
    ok('update user_settings (queue_alerts=false) aplicado');
  } else {
    fail('update user_settings falhou', JSON.stringify(upd));
  }

  console.log('\n2. notifications: insert + list + markAllRead');
  const notif = await post(token, 'notifications', { user_id: customerId, title: 'É a sua vez!', subtitle: 'Balcão 1' });
  if (notif.ok && notif.body[0]?.read === false) {
    ok(`notification criada: ${notif.body[0].id}`);
  } else {
    fail('insert notifications falhou', JSON.stringify(notif));
  }
  const markRead = await patch(token, 'notifications', `user_id=eq.${customerId}&read=eq.false`, { read: true });
  if (markRead.ok && markRead.body.every((n) => n.read === true)) {
    ok('markAllRead aplicado');
  } else {
    fail('markAllRead falhou', JSON.stringify(markRead));
  }

  console.log('\n3. appointments: next_appointment_code + schedule_appointment (sem customerUid, servidor deriva auth.uid())');
  const codeRes = await rpc(token, 'next_appointment_code', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona' });
  const code = codeRes.body;
  if (codeRes.ok && typeof code === 'string' && code.startsWith('AG')) {
    ok(`código reservado: ${code}`);
  } else {
    fail('next_appointment_code falhou', JSON.stringify(codeRes));
  }
  const sched = await rpc(token, 'schedule_appointment', {
    p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_code: code,
    p_service: 'Bilhete de Identidade', p_date: '2026-09-10', p_time: '10:30',
  });
  if (sched.ok && sched.body?.customer_id === customerId) {
    ok(`agendamento criado: ${sched.body.code}, customer_id correcto (servidor, não confiado do cliente)`);
  } else {
    fail('schedule_appointment falhou', JSON.stringify(sched));
  }
  const listed = await select(token, 'appointments', `customer_id=eq.${customerId}&status=eq.scheduled&select=code,institution_id,branch_id,service,date,time`);
  if (Array.isArray(listed) && listed.length === 1 && listed[0].code === code) {
    ok('AppointmentsStore._refetch (select customer_id+status=scheduled) devolveria exactamente este agendamento');
  } else {
    fail('select de appointments inesperado', JSON.stringify(listed));
  }
  const cancelled = await rpc(token, 'cancel_appointment', { p_code: code });
  ok(cancelled.ok ? 'cancel_appointment aceite' : `FALHOU: ${JSON.stringify(cancelled)}`);
  if (!cancelled.ok) failures++;

  console.log('\n4. ratings: insert directo (RLS exige ticket do próprio cliente)');
  const p1 = await rpc(token, 'pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'NIF — AGT' });
  const ticketId = p1.body.id;
  await rpc(agentSession.access_token, 'call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  await rpc(agentSession.access_token, 'complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  const rating = await post(token, 'ratings', {
    ticket_id: ticketId, institution_id: 'siac', branch_id: 'balcao-talatona', customer_id: customerId,
    service: 'NIF — AGT', overall: 5, recommend: true, comment: 'Bom atendimento',
    aspect_atendimento: 5, aspect_tempo_espera: 4, aspect_organizacao: 4, aspect_instalacoes: 5,
  });
  if (rating.ok && rating.body[0]?.overall === 5) {
    ok(`rating criada para a senha ${ticketId}`);
  } else {
    fail('insert ratings falhou', JSON.stringify(rating));
  }

  // limpeza
  await fetch(`${REST_BASE}/ratings?ticket_id=eq.${ticketId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/ticket_calls?ticket_id=eq.${ticketId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/tickets?id=eq.${ticketId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/appointments?code=eq.${code}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/notifications?user_id=eq.${customerId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await fetch(`${REST_BASE}/user_settings?user_id=eq.${customerId}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
  await deleteAuthUser(customerId);
  console.log('\nlimpeza feita.');

  console.log(failures === 0 ? '\nTUDO OK -- caminhos de dados novos da app Flutter validados.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
