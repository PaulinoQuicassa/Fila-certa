// Rotação de password das 12 contas reais de staff -- criado depois da
// auditoria de segurança de 2026-09-12 ter encontrado a password fixa
// partilhada destas contas commitada no repositório (README + vários
// scripts). Considerar essa password comprometida.
//
// Este script NÃO escolhe nem inventa a password nova -- só o operador
// decide, passando-a por variável de ambiente. Nunca imprime a
// password recebida, só o resultado (email -> sucesso/falha).
//
//   SUPABASE_URL=https://qdfpqispcntitvczybfl.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   SUPABASE_ANON_KEY=... \
//   TEST_STAFF_PASSWORD=<password NOVA, forte, escolhida por si> \
//   node scripts/rotate-staff-passwords.mjs
//
// Idempotente e seguro correr mais que uma vez -- cada conta que já
// não existir é só assinalada e ignorada (não cria nada; isso é
// trabalho do seed-reference-data.mjs).
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY, TEST_STAFF_PASSWORD as NEW_PASSWORD } from './lib/test-env.mjs';
import { staffList, findUserByEmail } from './lib/pilot-data.mjs';

const AUTH_BASE = `${SUPABASE_URL}/auth/v1`;

async function setPassword(userId, password) {
  const res = await fetch(`${AUTH_BASE}/admin/users/${userId}`, {
    method: 'PUT',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(`A rodar a password de ${staffList.length} contas de staff em ${SUPABASE_URL}...\n`);
  let updated = 0;
  let missing = 0;
  let failed = 0;

  for (const s of staffList) {
    const user = await findUserByEmail(AUTH_BASE, SERVICE_ROLE_KEY, s.email);
    if (!user) {
      console.log(`  IGNORADA  ${s.email} -- conta não encontrada (nada a rodar)`);
      missing++;
      continue;
    }
    try {
      await setPassword(user.id, NEW_PASSWORD);
      console.log(`  OK        ${s.email}`);
      updated++;
    } catch (err) {
      console.log(`  FALHOU    ${s.email} -- ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${updated} rodadas, ${missing} não encontradas, ${failed} falharam.`);
  console.log('\nNunca mais reutilizar a password antiga em nenhum sítio -- já não deve constar de nenhum ficheiro deste repositório.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERRO inesperado:', err);
  process.exit(1);
});
