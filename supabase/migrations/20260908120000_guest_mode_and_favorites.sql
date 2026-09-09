-- Fila Certa 2.0 -- redesign UX/UI do cliente (projectogestaodefilas).
--
-- Duas alterações mínimas e justificadas ao backend, pedidas directamente
-- pelo master prompt do redesign (princípio "não obrigar login cedo
-- demais" -- secção 4):
--
-- 1. Modo convidado: hoje `institutions_select`/`branches_select`/
--    `counters_select` só permitem `authenticated` (20260906190100_rls.sql,
--    linhas 43-50) -- uma sessão anónima (sem login) não consegue ler
--    nem os nomes das instituições. Isto bloqueia por completo a
--    exploração sem conta que o redesign exige. Dados envolvidos são
--    puramente públicos (nome de bancos/agências/balcões, informação já
--    visível fisicamente nas próprias agências) -- não há PII nem dados
--    de fila individual nestas 3 tabelas. `tickets`/`ticket_calls`/
--    `branch_counters` (que têm lógica de fila e dados por cliente)
--    NÃO são tocados por esta migration -- continuam `authenticated`/
--    staff-only exactamente como antes.
--
-- 2. `branch_queue_summary` (contagem de espera por serviço, já uma
--    função SECURITY DEFINER agregada, sem PII) passa a incluir `anon`,
--    espelhando exactamente o que `branch_wait_stats` já fazia desde
--    20260906220000_least_privilege_hardening.sql -- sem isto, a busca
--    por serviço em modo convidado não teria nenhum dado de fila real
--    para mostrar.
--
-- Nenhuma tabela com lógica crítica de fila, nenhuma RPC de mutação, e
-- nenhuma policy já existente é alterada ou removida.

create policy institutions_select_guest on institutions for select to anon using (true);
create policy branches_select_guest on branches for select to anon using (true);
create policy counters_select_guest on counters for select to anon using (true);

grant execute on function public.branch_queue_summary(text, text) to anon;

-- ---------------------------------------------------------------------
-- favorites -- nova, pedida no redesign (secção 26 do master prompt).
-- Preferência pessoal, sem concorrência a proteger e sem lógica de
-- fila -- mesmo padrão de `notifications`/`user_settings`: DML directo
-- via RLS, sem RPC.
-- ---------------------------------------------------------------------

create table favorites (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  institution_id  text not null,
  branch_id       text not null,
  created_at      timestamptz not null default now(),
  foreign key (institution_id, branch_id) references branches(institution_id, id) on delete cascade,
  unique (user_id, institution_id, branch_id)
);

create index favorites_user_idx on favorites (user_id);

alter table favorites enable row level security;

create policy favorites_select_own on favorites for select to authenticated
  using (user_id = auth.uid());
create policy favorites_insert_own on favorites for insert to authenticated
  with check (user_id = auth.uid());
create policy favorites_delete_own on favorites for delete to authenticated
  using (user_id = auth.uid());

-- Defesa em profundidade, mesmo padrão de 20260907100200_revoke_unnecessary_grants.sql:
-- RLS já impede tudo isto, mas remove a rede de segurança implícita do
-- Supabase (GRANT automático a anon/authenticated em tabelas novas).
revoke all on favorites from anon;
revoke update, truncate on favorites from authenticated;
