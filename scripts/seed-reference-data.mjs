// Seed reprodutível dos dados de referência (instituições/filiais/
// balcões/staff) -- até agora só existiam como operação manual de
// produção (scripts/scratchpad da Fase 6, nunca versionados). Corrigido
// como parte do CI/CD (auditoria encontrou que o ambiente de teste não
// era recriável do zero, nem localmente nem em CI).
//
// Idempotente: pode correr contra QUALQUER projecto Supabase (local
// efémero no CI, ou produção) -- nunca hardcoded, exige sempre as
// variáveis de ambiente para forçar intenção explícita:
//
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   SUPABASE_ANON_KEY=... \
//   TEST_STAFF_PASSWORD=... \
//   node scripts/seed-reference-data.mjs
//
// As mesmas 6 instituições e 12 contas de staff usadas em produção e
// em todos os scripts de teste deste repositório (ver
// scripts/lib/test-env.mjs) -- a password NUNCA é hardcoded aqui (uma
// auditoria de segurança em 2026-09-12 encontrou a password partilhada
// destas 12 contas reais commitada neste ficheiro; ver
// docs/security-credentials.md para o estado da rotação).
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY, TEST_STAFF_PASSWORD as SEED_STAFF_PASSWORD } from './lib/test-env.mjs';
import { institutions, staffList, findUserByEmail as findUserByEmailShared } from './lib/pilot-data.mjs';

const AUTH_BASE = `${SUPABASE_URL}/auth/v1`;
const REST_BASE = `${SUPABASE_URL}/rest/v1`;

async function upsertViaRest(table, rows, onConflict) {
  const res = await fetch(`${REST_BASE}/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table} -> ${res.status}: ${await res.text()}`);
}

async function ensureAuthUser(email, password) {
  const existing = await findUserByEmailShared(AUTH_BASE, SERVICE_ROLE_KEY, email);
  if (existing) return existing.id;
  const res = await fetch(`${AUTH_BASE}/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createAuthUser(${email}) -> ${res.status}: ${JSON.stringify(body)}`);
  return body.id ?? body.user?.id;
}

async function main() {
  // 1. institutions/branches/counters
  await upsertViaRest('institutions', institutions.map((i) => ({ id: i.id, name: i.name })), 'id');
  console.log('institutions ok');

  const branchRows = [];
  const counterRows = [];
  for (const inst of institutions) {
    for (const branch of inst.branches) {
      branchRows.push({ id: branch.id, institution_id: inst.id, name: branch.name });
      branch.counters.forEach((label, i) => {
        counterRows.push({ id: `guiche-${i + 1}`, branch_id: branch.id, institution_id: inst.id, label });
      });
    }
  }
  await upsertViaRest('branches', branchRows, 'institution_id,id');
  console.log('branches ok');
  await upsertViaRest('counters', counterRows, 'institution_id,branch_id,id');
  console.log('counters ok');

  // 2. contas de Auth (idempotente -- reaproveita a conta se já existir)
  const staffRows = [];
  for (const s of staffList) {
    const id = await ensureAuthUser(s.email, SEED_STAFF_PASSWORD);
    console.log('auth ok:', s.email, '->', id);
    staffRows.push({
      id,
      name: s.name,
      role: s.role,
      institution_id: s.institutionId,
      branch_id: s.branchId,
      counter_id: s.counterId ?? null,
    });
  }
  await upsertViaRest('staff', staffRows, 'id');
  console.log('staff ok');

  console.log(`\nSeed completo: ${institutions.length} instituições, ${branchRows.length} filiais, ${counterRows.length} balcões, ${staffRows.length} contas de staff.`);
}

main().catch((err) => {
  console.error('ERRO no seed:', err);
  process.exit(1);
});
