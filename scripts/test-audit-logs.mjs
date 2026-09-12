// Valida os audit_logs (auditoria de produto comercial, 2026-09-07):
// confirma que as RPCs de mutação escrevem um registo, que o registo
// aparece para a equipa da filial certa, e que fica invisível para
// quem não devia ver (cliente, staff doutra filial).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL as URL, SUPABASE_ANON_KEY as ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY, TEST_STAFF_PASSWORD } from './lib/test-env.mjs';

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

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
  const email = `teste-audit-${Date.now()}@example.com`;
  const customerId = await createTestCustomer(email, 'senha123456');
  const customer = createClient(URL, ANON_KEY);
  const agent = createClient(URL, ANON_KEY);
  const manager = createClient(URL, ANON_KEY);
  const otherManager = createClient(URL, ANON_KEY);
  await customer.auth.signInWithPassword({ email, password: 'senha123456' });
  await agent.auth.signInWithPassword({ email: 'agente@siac.test', password: TEST_STAFF_PASSWORD });
  await manager.auth.signInWithPassword({ email: 'gestor@siac.test', password: TEST_STAFF_PASSWORD });
  await otherManager.auth.signInWithPassword({ email: 'gestor@filacerta.test', password: TEST_STAFF_PASSWORD });

  console.log('\n1. pull_ticket + call_next + complete_current geram registos de auditoria');
  const { data: ticket } = await customer.rpc('pull_ticket', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_service: 'Registo Civil' });
  await agent.rpc('call_next', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });
  await agent.rpc('complete_current', { p_institution_id: 'siac', p_branch_id: 'balcao-talatona', p_counter_id: 'guiche-1' });

  const { data: logs, error: logsErr } = await manager.from('audit_logs').select('action, entity, entity_id, result').eq('entity_id', ticket.id).order('created_at');
  if (logsErr) fail('gestor não conseguiu ler audit_logs', logsErr.message);
  const actions = (logs ?? []).map((l) => l.action);
  if (actions.includes('pull_ticket') && actions.includes('call_next') && actions.includes('complete_current')) {
    ok(`gestor viu os 3 registos: ${actions.join(', ')}`);
  } else {
    fail('faltam registos de auditoria esperados', JSON.stringify(actions));
  }

  console.log('\n2. Cliente NÃO consegue ler audit_logs (nem sequer as suas próprias acções)');
  const asCustomer = await customer.from('audit_logs').select('*').eq('entity_id', ticket.id);
  if (Array.isArray(asCustomer.data) && asCustomer.data.length === 0) {
    ok('cliente não lê audit_logs (0 linhas, RLS bloqueia)');
  } else {
    fail('cliente conseguiu ler audit_logs -- não devia', JSON.stringify(asCustomer));
  }

  console.log('\n3. Gestor de OUTRA instituição não vê os registos do SIAC');
  const asOtherManager = await otherManager.from('audit_logs').select('*').eq('entity_id', ticket.id);
  if (Array.isArray(asOtherManager.data) && asOtherManager.data.length === 0) {
    ok('gestor do Banco Exemplo não vê auditoria do SIAC (0 linhas)');
  } else {
    fail('gestor doutra instituição viu auditoria alheia -- FUGA', JSON.stringify(asOtherManager));
  }

  console.log('\n4. Cliente não consegue escrever directamente em audit_logs (só a função interna escreve)');
  const directInsert = await customer.from('audit_logs').insert({ action: 'fake', entity: 'ticket', entity_id: 'x', result: 'success' });
  if (directInsert.error) {
    ok(`insert directo recusado: ${directInsert.error.message}`);
  } else {
    fail('cliente conseguiu escrever directamente em audit_logs -- FALHA GRAVE', '');
  }

  console.log('\n5. GRANTs revogados: cliente não consegue fazer UPDATE directo a counters (mesmo com RLS à parte)');
  const directCounterUpdate = await customer.from('counters').update({ status: 'paused' }).eq('institution_id', 'siac').eq('branch_id', 'balcao-talatona').eq('id', 'guiche-1').select();
  if (directCounterUpdate.error || (Array.isArray(directCounterUpdate.data) && directCounterUpdate.data.length === 0)) {
    ok('UPDATE directo a counters continua bloqueado após revogar GRANTs');
  } else {
    fail('UPDATE directo a counters passou -- FALHA GRAVE', JSON.stringify(directCounterUpdate));
  }

  console.log('\n6. owner_add_owner / owner_remove_owner escrevem auditoria (Fase 4/17 -- antes não escreviam nada)');
  const svc = createClient(URL, SERVICE_ROLE_KEY);
  const ownerAEmail = `teste-owner-audit-a-${Date.now()}@example.com`;
  const ownerBEmail = `teste-owner-audit-b-${Date.now()}@example.com`;
  const ownerAId = await createTestCustomer(ownerAEmail, 'senha123456');
  const ownerBId = await createTestCustomer(ownerBEmail, 'senha123456');
  await svc.from('owners').insert({ id: ownerAId, name: 'Dono Teste A (auditoria)' });
  const ownerA = createClient(URL, ANON_KEY);
  await ownerA.auth.signInWithPassword({ email: ownerAEmail, password: 'senha123456' });

  const addResult = await ownerA.rpc('owner_add_owner', { p_email: ownerBEmail, p_name: 'Dono Teste B (auditoria)' });
  if (addResult.error) fail('owner_add_owner falhou inesperadamente', addResult.error.message);
  const removeResult = await ownerA.rpc('owner_remove_owner', { p_user_id: ownerBId });
  if (removeResult.error) fail('owner_remove_owner falhou inesperadamente', removeResult.error.message);

  const { data: ownerLogs, error: ownerLogsErr } = await ownerA.from('audit_logs').select('action').eq('entity_id', ownerBId).order('created_at');
  if (ownerLogsErr) fail('dono não conseguiu ler audit_logs de outro dono', ownerLogsErr.message);
  const ownerActions = (ownerLogs ?? []).map((l) => l.action);
  if (ownerActions.includes('owner_add_owner') && ownerActions.includes('owner_remove_owner')) {
    ok(`dono vê os registos de owner_add_owner/owner_remove_owner: ${ownerActions.join(', ')}`);
  } else {
    fail('faltam registos de auditoria para adicionar/remover dono', JSON.stringify(ownerActions));
  }

  const asStaffManager = await manager.from('audit_logs').select('*').eq('entity_id', ownerBId);
  if (Array.isArray(asStaffManager.data) && asStaffManager.data.length === 0) {
    ok('staff (não-dono) não vê auditoria de gestão de donos');
  } else {
    fail('staff conseguiu ver auditoria de gestão de donos -- FUGA', JSON.stringify(asStaffManager));
  }

  await svc.from('owners').delete().eq('id', ownerAId);
  await deleteAuthUser(ownerAId);
  await deleteAuthUser(ownerBId);

  await deleteAuthUser(customerId);
  console.log(failures === 0 ? '\nTUDO OK -- audit_logs e hardening de GRANTs validados.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
