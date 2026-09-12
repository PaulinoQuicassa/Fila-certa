// MFA obrigatório para donos (Fase 6/19) -- fluxo real de ponta a
// ponta, sem tocar directamente no schema `auth` (o PostgREST local só
// expõe `public`/`graphql_public` -- confirmado em CI: PGRST106
// "Invalid schema: auth"). Em vez de inserir um factor à mão, o script
// usa a própria API de MFA da Auth (enroll/challengeAndVerify),
// calculando um código TOTP válido a partir do segredo devolvido --
// exactamente o que uma app autenticadora real faria.
//
// Confirma:
// 1. Um dono SEM nenhum factor MFA verificado continua a conseguir
//    usar a consola normalmente (aal1) -- nunca ficou trancado fora.
// 2. Depois de inscrever e confirmar um factor TOTP real (mesma
//    sessão), owner_mfa_status() reflecte o novo estado.
// 3. Uma sessão NOVA (novo login por password, ainda em aal1 --
//    comportamento normal da Auth: password sozinha nunca dá aal2 a
//    uma conta já inscrita) deixa de conseguir chamar uma RPC de dono
//    -- MFA passa a ser mesmo obrigatório a partir da inscrição.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
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

// RFC 4648 (base32, sem padding) + RFC 6238 (TOTP) -- o mesmo cálculo
// que qualquer app autenticadora (Google Authenticator, Authy, ...)
// faz a partir do segredo mostrado no QR code.
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secretBase32, step = 30, digits = 6) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binCode = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (binCode % 10 ** digits).toString().padStart(digits, '0');
}

async function main() {
  const email = `teste-owner-mfa-${Date.now()}@example.com`;
  const password = 'senha123456';
  const ownerId = await createTestOwner(email, password);
  const { error: ownerInsertError } = await svc.from('owners').insert({ id: ownerId, name: 'Dono Teste MFA' });
  if (ownerInsertError) throw ownerInsertError;

  const client1 = createClient(URL, ANON_KEY);
  await client1.auth.signInWithPassword({ email, password });

  console.log('\n1. dono sem nenhum factor MFA verificado -- continua a passar em aal1 (sem trancar ninguém fora)');
  const { data: statusBefore, error: statusBeforeError } = await client1.rpc('owner_mfa_status').single();
  if (statusBeforeError) throw statusBeforeError;
  if (statusBefore.is_owner === true && statusBefore.has_verified_factor === false && statusBefore.current_aal === 'aal1') {
    ok('owner_mfa_status() reporta is_owner=true, has_verified_factor=false, aal1');
  } else {
    fail('owner_mfa_status() incorrecto antes de inscrever MFA', JSON.stringify(statusBefore));
  }

  const { error: kioskBeforeError } = await client1.rpc('owner_set_kiosk_account', { p_user_id: ownerId, p_is_kiosk: false });
  if (!kioskBeforeError) {
    ok('RPC de dono (owner_set_kiosk_account) continua acessível em aal1 sem MFA inscrito');
  } else {
    fail('RPC de dono foi recusada mesmo sem MFA inscrito -- trancaria contas antigas fora', kioskBeforeError.message);
  }

  console.log('\n2. inscrição TOTP real (enroll + código calculado a partir do segredo, como uma app autenticadora)');
  const { data: enrollData, error: enrollError } = await client1.auth.mfa.enroll({ factorType: 'totp' });
  if (enrollError || !enrollData) throw enrollError ?? new Error('enroll sem dados');
  const code = totpCode(enrollData.totp.secret);
  const { error: verifyError } = await client1.auth.mfa.challengeAndVerify({ factorId: enrollData.id, code });
  if (!verifyError) {
    ok('challengeAndVerify aceitou o código calculado a partir do segredo -- factor TOTP agora verificado');
  } else {
    fail('challengeAndVerify recusou um código correctamente calculado (RFC 6238)', verifyError.message);
  }

  const { data: statusAfter, error: statusAfterError } = await client1.rpc('owner_mfa_status').single();
  if (statusAfterError) throw statusAfterError;
  if (statusAfter.has_verified_factor === true) {
    ok('owner_mfa_status() já reporta has_verified_factor=true');
  } else {
    fail('has_verified_factor devia ser true depois do enroll+verify', JSON.stringify(statusAfter));
  }

  console.log('\n3. uma sessão NOVA (login por password outra vez) fica em aal1 -- e agora é recusada numa RPC de dono');
  const client2 = createClient(URL, ANON_KEY);
  await client2.auth.signInWithPassword({ email, password });
  const { data: statusClient2 } = await client2.rpc('owner_mfa_status').single();
  if (statusClient2?.current_aal !== 'aal1') {
    fail('esperava-se que um novo login por password ficasse em aal1 (comportamento normal da Auth)', JSON.stringify(statusClient2));
  }

  const { error: kioskAfterError } = await client2.rpc('owner_set_kiosk_account', { p_user_id: ownerId, p_is_kiosk: false });
  if (kioskAfterError) {
    ok('RPC de dono recusada numa sessão aal1 depois de existir um factor MFA verificado -- MFA agora obrigatório');
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
