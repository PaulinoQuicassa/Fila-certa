// Confirma os agregados novos criados pelo hardening de segurança
// (branch_queue_summary, branch_wait_stats, waiting_ahead_count) --
// substituem leituras directas de `tickets` que deixaram de ser
// possíveis para quem não é dono/staff dessa filial.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL as URL, SUPABASE_ANON_KEY as ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY } from './lib/test-env.mjs';

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

const svc = createClient(URL, SERVICE_ROLE_KEY);

async function createTestCustomer(email, password) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.id;
}
async function deleteAuthUser(uid) {
  await fetch(`${URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
}

async function main() {
  const emailC = `teste-agg-c-${Date.now()}@example.com`;
  const emailC2 = `teste-agg-c2-${Date.now()}@example.com`;
  const emailNoTicket = `teste-agg-nt-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(emailC, 'senha123456');
  const customer2Id = await createTestCustomer(emailC2, 'senha123456');
  const noTicketId = await createTestCustomer(emailNoTicket, 'senha123456');
  const customer = createClient(URL, ANON_KEY);
  const customer2 = createClient(URL, ANON_KEY);
  const noTicketCustomer = createClient(URL, ANON_KEY);
  const anon = createClient(URL, ANON_KEY);
  await customer.auth.signInWithPassword({ email: emailC, password: 'senha123456' });
  await customer2.auth.signInWithPassword({ email: emailC2, password: 'senha123456' });
  await noTicketCustomer.auth.signInWithPassword({ email: emailNoTicket, password: 'senha123456' });
  await anon.auth.signInAnonymously();

  const { data: t1 } = await customer.rpc('pull_ticket', { p_institution_id: 'bpc', p_branch_id: 'agencia-talatona', p_service: 'Abertura de Conta' });
  const { data: t2 } = await customer.rpc('pull_ticket', { p_institution_id: 'bpc', p_branch_id: 'agencia-talatona', p_service: 'Crédito Habitação' });
  // t3 é de um SEGUNDO cliente, não do mesmo -- desde a regra "uma senha
  // activa por serviço" (20260909120000_one_ticket_per_service.sql), o
  // mesmo cliente já não pode pedir uma segunda "Abertura de Conta"
  // enquanto a primeira continuar activa.
  const { data: t3 } = await customer2.rpc('pull_ticket', { p_institution_id: 'bpc', p_branch_id: 'agencia-talatona', p_service: 'Abertura de Conta' });

  console.log('\n1. branch_queue_summary: cliente sem nenhuma senha ali consegue ver o agregado (informação pública da fila)');
  const summary = await noTicketCustomer.rpc('branch_queue_summary', { p_institution_id: 'bpc', p_branch_id: 'agencia-talatona' });
  const abertura = summary.data?.find((r) => r.service === 'Abertura de Conta');
  const credito = summary.data?.find((r) => r.service === 'Crédito Habitação');
  if (!summary.error && abertura?.waiting_count === 2 && credito?.waiting_count === 1) {
    ok(`agregado correcto: Abertura de Conta=${abertura.waiting_count}, Crédito Habitação=${credito.waiting_count}`);
  } else {
    fail('agregado incorrecto ou com erro', JSON.stringify({ error: summary.error, data: summary.data }));
  }

  console.log('\n2. waiting_ahead_count: cliente vê quantas senhas o precedem, sem ver as linhas alheias');
  const ahead = await customer2.rpc('waiting_ahead_count', { p_ticket_id: t3.id });
  if (!ahead.error && ahead.data === 2) {
    ok(`t3 tem 2 senhas à frente (t1 e t2), confirmado sem expor as linhas de t1/t2 a mais ninguém`);
  } else {
    fail('waiting_ahead_count incorrecto', JSON.stringify(ahead));
  }

  console.log('\n3. waiting_ahead_count: outro cliente NÃO pode consultar a posição de uma senha que não é dele');
  const stolen = await noTicketCustomer.rpc('waiting_ahead_count', { p_ticket_id: t1.id });
  if (stolen.error) {
    ok(`recusado como esperado: ${stolen.error.message}`);
  } else {
    fail('outro cliente conseguiu consultar a posição de uma senha alheia -- FALHA', JSON.stringify(stolen));
  }

  console.log('\n4. branch_wait_stats: sessão anónima (painel de TV) consegue ler o tempo médio, sem ver tickets linha a linha');
  await svc.from('tickets').update({
    status: 'serving',
    created_at: new Date(Date.now() - 8 * 60000).toISOString(),
    called_at: new Date(Date.now() - 5 * 60000).toISOString(),
    counter_id: 'guiche-1',
  }).eq('id', t1.id);
  const stats = await anon.rpc('branch_wait_stats', { p_institution_id: 'bpc', p_branch_id: 'agencia-talatona' });
  if (!stats.error && typeof stats.data === 'number' && stats.data >= 0) {
    ok(`sessão anónima obteve o tempo médio: ${stats.data} min`);
  } else {
    fail('sessão anónima não conseguiu obter branch_wait_stats', JSON.stringify(stats));
  }
  const anonDirect = await anon.from('tickets').select('id').eq('institution_id', 'bpc').eq('branch_id', 'agencia-talatona');
  if (Array.isArray(anonDirect.data) && anonDirect.data.length === 0) {
    ok('confirmado: a mesma sessão anónima NÃO consegue ler as linhas de tickets directamente (só o agregado)');
  } else {
    fail('sessão anónima leu tickets directamente -- devia estar bloqueada', JSON.stringify(anonDirect));
  }

  // limpeza
  await svc.from('tickets').delete().in('id', [t1.id, t2.id, t3.id]);
  await svc.from('counters').update({ status: 'available', current_ticket_id: null, current_agent_id: null }).eq('institution_id', 'bpc').eq('branch_id', 'agencia-talatona').eq('id', 'guiche-1');
  await deleteAuthUser(customerId);
  await deleteAuthUser(customer2Id);
  await deleteAuthUser(noTicketId);

  console.log(failures === 0 ? '\nTUDO OK -- agregados públicos-operacionais validados.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
