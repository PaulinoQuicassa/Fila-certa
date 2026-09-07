// Backup manual periódico do Postgres/Supabase (decisão do utilizador:
// plano gratuito, sem PITR/backups automáticos -- ver auditoria de
// 2026-09-07). Exporta o CONTEÚDO de todas as tabelas via REST API com
// a service_role key (ignora RLS de propósito, é um backup completo).
// O ESQUEMA já está garantido pelas migrations versionadas em
// supabase/migrations/ -- não precisa de ser re-exportado aqui; isto
// só preserva os dados.
//
// Corre manualmente, sempre que fizer sentido (ex.: antes de uma
// alteração grande, ou semanalmente):
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup-supabase.mjs
//
// Guardado localmente (nunca no repositório, que agora é público) em
// ~/Desktop/fila-certa-backups/ -- mesma pasta do backup do Firestore.
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const PROJECT_REF = 'qdfpqispcntitvczybfl';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('falta SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const REST_BASE = `https://${PROJECT_REF}.supabase.co/rest/v1`;
const AUTH_BASE = `https://${PROJECT_REF}.supabase.co/auth/v1`;

// Todas as tabelas de negócio (não inclui as internas do schema auth/storage).
const TABLES = [
  'institutions', 'branches', 'counters', 'staff', 'branch_counters',
  'tickets', 'ticket_calls', 'appointments', 'ratings', 'notifications',
  'user_settings', 'audit_logs',
];

// A maioria das tabelas tem PK "id"; branch_counters/user_settings têm
// PKs compostas/próprias sem coluna "id" -- ordenar por uma coluna que
// realmente existe em cada uma (só para paginação estável, não é a PK).
const ORDER_COLUMN = {
  branch_counters: 'institution_id',
  user_settings: 'user_id',
};

async function dumpTable(table) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  const orderBy = ORDER_COLUMN[table] ?? 'id';
  for (;;) {
    const res = await fetch(`${REST_BASE}/${table}?select=*&order=${orderBy}&limit=${pageSize}&offset=${offset}`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) {
      // Só 404 é "tabela ainda não existe" (ex.: uma tabela nova antes
      // da sua migration ser aplicada) -- qualquer outro erro (400,
      // 403, etc.) é real e tem de parar o backup, não ser ignorado
      // silenciosamente (já aconteceu: um erro 400 por nome de coluna
      // errado escondeu duas tabelas inteiras do backup).
      if (res.status === 404) return { skipped: true, reason: await res.text() };
      throw new Error(`${table}: ${res.status} ${await res.text()}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return { rows };
}

async function dumpAuthUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`${AUTH_BASE}/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) throw new Error(`auth users: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const batch = body.users ?? [];
    users.push(...batch.map((u) => ({ id: u.id, email: u.email, is_anonymous: u.is_anonymous, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at })));
    if (batch.length < 1000) break;
    page++;
  }
  return users;
}

async function main() {
  const backup = { exportedAt: new Date().toISOString(), projectRef: PROJECT_REF, tables: {}, authUsers: [] };

  for (const table of TABLES) {
    const result = await dumpTable(table);
    if (result.skipped) {
      console.log(`(ignorada) ${table}: ${result.reason}`);
      continue;
    }
    backup.tables[table] = result.rows;
    console.log(`${table}: ${result.rows.length} linha(s)`);
  }

  backup.authUsers = await dumpAuthUsers();
  console.log(`auth.users: ${backup.authUsers.length} conta(s)`);

  const dir = join(os.homedir(), 'Desktop', 'fila-certa-backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `supabase-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nBackup escrito em: ${file}`);
  console.log('Esquema (DDL) não incluído de propósito -- já está versionado em supabase/migrations/.');
}

main().catch((err) => {
  console.error('ERRO no backup:', err);
  process.exit(1);
});
