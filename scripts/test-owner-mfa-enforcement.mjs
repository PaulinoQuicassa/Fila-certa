// MFA obrigatório para donos (Fase 6/19) -- confirma que:
// 1. Um dono SEM nenhum factor MFA verificado continua a conseguir
//    usar a consola normalmente (aal1) -- nunca ficou trancado fora
//    por esta alteração.
// 2. owner_mfa_status() reporta correctamente o estado real.
// 3. Assim que a conta TEM um factor TOTP verificado,
//    is_owner()/RPCs de dono deixam de aceitar uma sessão aal1 -- MFA
//    passa a ser mesmo obrigatório a partir desse momento, não apenas
//    "disponível".
//
// Não testa o enrolment/challenge TOTP completo (isso é um fluxo de
// UI real na consola do dono, fila-certa-owner) -- insere directamente
// um factor "verified" via service_role para testar só a parte que
// vive nesta base de dados: a decisão de is_owner().
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL as URL, SUPABASE_ANON_KEY as ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY } from './lib/test-env.mjs';

const svc = createClient(URL, SERVICE_ROLE_KEY);

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

async function createTestOwner(email, password) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.id;
}
async function deleteAuthUser(uid) {
  await fetch(`${URL}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
}

async function main() {
  const email = `teste-owner-mfa-${Date.now()}@example.com`;
  const password = 'senha123456';
  const ownerId = await createTestOwner(email, password);
  const { error: ownerInsertError } = await svc.from('owners').insert({ id: ownerId, name: 'Dono Teste MFA' });
  if (ownerInsertError) throw ownerInsertError;

  const ownerClient = createClient(URL, ANON_KEY);
  await ownerClient.auth.signInWithPassword({ email, password });

  console.log('\n1. dono sem nenhum factor MFA verificado -- continua a passar em aal1 (sem trancar ninguém fora)');
  const { data: statusBefore, error: statusBeforeError } = await ownerClient.rpc('owner_mfa_status').single();
  if (statusBeforeError) throw statusBeforeError;
  if (statusBefore.is_owner === true && statusBefore.has_verified_factor === false && statusBefore.current_aal === 'aal1') {
    ok('owner_mfa_status() reporta is_owner=true, has_verified_factor=false, aal1');
  } else {
    fail('owner_mfa_status() incorrecto antes de inscrever MFA', JSON.stringify(statusBefore));
  }

  const { error: kioskBeforeError } = await ownerClient.rpc('owner_set_kiosk_account', { p_user_id: ownerId, p_is_kiosk: false });
  if (!kioskBeforeError) {
    ok('RPC de dono (owner_set_kiosk_account) continua acessível em aal1 sem MFA inscrito');
  } else {
    fail('RPC de dono foi recusada mesmo sem MFA inscrito -- trancaria contas antigas fora', kioskBeforeError.message);
  }

  console.log('\n2. depois de um factor TOTP verificado existir, aal1 deixa de chegar -- MFA passa a ser mesmo obrigatório');
  // mfa_factors vive no schema `auth` -- supabase-js só fala com
  // `public` por omissão, por isso este cliente aponta o schema
  // explicitamente.
  const svcAuth = createClient(URL, SERVICE_ROLE_KEY, { db: { schema: 'auth' } });
  const { error: factorInsertAuthError } = await svcAuth.from('mfa_factors').insert({
    user_id: ownerId, friendly_name: 'Teste TOTP', factor_type: 'totp', status: 'verified', secret: 'JBSWY3DPEHPK3PXP',
  });
  if (factorInsertAuthError) throw factorInsertAuthError;

  const { data: statusAfter, error: statusAfterError } = await ownerClient.rpc('owner_mfa_status').single();
  if (statusAfterError) throw statusAfterError;
  if (statusAfter.has_verified_factor === true) {
    ok('owner_mfa_status() já reporta has_verified_factor=true');
  } else {
    fail('has_verified_factor devia ser true depois do insert', JSON.stringify(statusAfter));
  }

  // A sessão actual do cliente continua em aal1 (não completou nenhum
  // challenge TOTP) -- agora que a conta TEM um factor verificado,
  // is_owner() deve recusar até um RPC simples de dono.
  const { error: kioskAfterError } = await ownerClient.rpc('owner_set_kiosk_account', { p_user_id: ownerId, p_is_kiosk: false });
  if (kioskAfterError) {
    ok('RPC de dono recusada em aal1 depois de existir um factor MFA verificado -- MFA agora obrigatório');
  } else {
    fail('RPC de dono deveria ter sido recusada em aal1 com MFA já inscrito -- MFA não está a ser aplicado', null);
  }

  // limpeza
  await svc.from('owners').delete().eq('id', ownerId);
  await deleteAuthUser(ownerId);

  console.log(failures === 0 ? '\nTUDO OK -- MFA de dono aplicado correctamente, sem trancar contas antigas fora.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
