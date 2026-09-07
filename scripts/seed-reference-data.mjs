// Seed reprodutível dos dados de referência (instituições/filiais/
// balcões/staff) -- até agora só existiam como operação manual de
// produção (scripts/scratchpad da Fase 6, nunca versionados). Corrigido
// como parte do CI/CD (auditoria encontrou que o ambiente de teste não
// era recriável do zero, nem localmente nem em CI).
//
// Idempotente: pode correr contra QUALQUER projecto Supabase (local
// efémero no CI, ou produção) -- nunca hardcoded, exige sempre as duas
// variáveis de ambiente para forçar intenção explícita:
//
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/seed-reference-data.mjs
//
// As mesmas 6 instituições e 12 contas de staff (password `teste123`
// para todas, piloto sem clientes reais -- ver docs/migration-plan.md,
// estratégia de auth) usadas em produção e em todos os scripts de
// teste deste repositório.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const AUTH_BASE = `${SUPABASE_URL}/auth/v1`;
const REST_BASE = `${SUPABASE_URL}/rest/v1`;

const institutions = [
  { id: 'bai', name: 'Banco BAI', branches: [{ id: 'agencia-viana', name: 'Agência Viana', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'banco-exemplo', name: 'Banco Sol', branches: [{ id: 'agencia-maianga', name: 'Agência Maianga', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bci', name: 'Banco BCI', branches: [{ id: 'agencia-kilamba', name: 'Agência Kilamba', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bfa', name: 'Banco BFA', branches: [{ id: 'agencia-belas', name: 'Agência Belas', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'bpc', name: 'Banco de Poupança e Crédito (BPC)', branches: [{ id: 'agencia-talatona', name: 'Agência Talatona', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
  { id: 'siac', name: 'SIAC — Serviço Integrado de Atendimento ao Cidadão', branches: [{ id: 'balcao-talatona', name: 'Balcão Talatona', counters: ['Balcão 1', 'Balcão 2', 'Balcão 3'] }] },
];

const staffList = [
  { email: 'gestor@bai.test', name: 'Rosa Ferreira', role: 'manager', institutionId: 'bai', branchId: 'agencia-viana' },
  { email: 'gestor@bpc.test', name: 'Isabel Ferraz', role: 'manager', institutionId: 'bpc', branchId: 'agencia-talatona' },
  { email: 'gestor@filacerta.test', name: 'Beatriz Neto', role: 'manager', institutionId: 'banco-exemplo', branchId: 'agencia-maianga' },
  { email: 'agente@siac.test', name: 'Kiluanje Mateus', role: 'agent', institutionId: 'siac', branchId: 'balcao-talatona', counterId: 'guiche-1' },
  { email: 'agente@bci.test', name: 'Miguel Sumbo', role: 'agent', institutionId: 'bci', branchId: 'agencia-kilamba', counterId: 'guiche-1' },
  { email: 'agente@bfa.test', name: 'Domingos Neto', role: 'agent', institutionId: 'bfa', branchId: 'agencia-belas', counterId: 'guiche-1' },
  { email: 'gestor@bfa.test', name: 'Ana Kiala', role: 'manager', institutionId: 'bfa', branchId: 'agencia-belas' },
  { email: 'agente@bai.test', name: 'Fernando Bumba', role: 'agent', institutionId: 'bai', branchId: 'agencia-viana', counterId: 'guiche-1' },
  { email: 'gestor@bci.test', name: 'Teresa Vieira', role: 'manager', institutionId: 'bci', branchId: 'agencia-kilamba' },
  { email: 'agente@bpc.test', name: 'Manuel Sacramento', role: 'agent', institutionId: 'bpc', branchId: 'agencia-talatona', counterId: 'guiche-1' },
  { email: 'gestor@siac.test', name: 'Fátima Chissano', role: 'manager', institutionId: 'siac', branchId: 'balcao-talatona' },
  { email: 'agente@filacerta.test', name: 'João Manuel', role: 'agent', institutionId: 'banco-exemplo', branchId: 'agencia-maianga', counterId: 'guiche-3' },
];

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

// A API Admin não filtra por email apesar do parâmetro aceitar --
// devolve sempre a lista paginada inteira (confirmado a testar contra
// produção: `?email=x` ignorado, tinha de paginar e filtrar aqui).
async function findUserByEmail(email) {
  let page = 1;
  for (;;) {
    const res = await fetch(`${AUTH_BASE}/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const users = body.users ?? [];
    const found = users.find((u) => u.email === email);
    if (found) return found;
    if (users.length < 1000) return null;
    page++;
  }
}

async function ensureAuthUser(email, password) {
  const existing = await findUserByEmail(email);
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
    const id = await ensureAuthUser(s.email, 'teste123');
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
