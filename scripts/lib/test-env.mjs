// Ambiente exigido por qualquer script deste directório que fale com o
// Supabase (local efémero no CI, ou produção manualmente) -- NUNCA
// hardcoded e NUNCA com valor por omissão (nem sequer para produção),
// para nenhum script poder apontar para lá "sem querer" só por
// esquecimento de definir a variável.
//
// Antes de 2026-09-12, cada script definia `SUPABASE_URL`/`ANON_KEY`
// com fallback para o projecto de produção real, e a password de staff
// vinha hardcoded em cada ficheiro -- uma auditoria de segurança
// encontrou isso como achado Crítico (credenciais reais de produção
// commitadas no repositório). Este módulo é a correcção: falha alto e
// claro se faltar alguma variável, em vez de silenciosamente assumir
// produção ou uma password fixa.
//
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   TEST_STAFF_PASSWORD=... \
//   node scripts/test-phase9.mjs

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Falta a variável de ambiente ${name}. Este script nunca assume um valor por omissão ` +
        `(nem local nem de produção) -- define-a explicitamente antes de correr. Ver ` +
        `scripts/lib/test-env.mjs.`,
    );
    process.exit(1);
  }
  return value;
}

export const SUPABASE_URL = required('SUPABASE_URL');
export const SUPABASE_ANON_KEY = required('SUPABASE_ANON_KEY');
export const SUPABASE_SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

// Password partilhada só para as contas de staff/clientes de teste que
// estes scripts criam/usam -- nunca a mesma em dois ambientes, decidida
// por quem corre o script, nunca por nós.
export const TEST_STAFF_PASSWORD = required('TEST_STAFF_PASSWORD');
