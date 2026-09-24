-- Achado ERROR do linter de segurança da Supabase (2026-09-24):
-- `counters_with_agent` estava definida como view SECURITY DEFINER
-- (comportamento por omissão de qualquer `create view` antes de
-- `security_invoker=true` existir, PG15+) -- ignora completamente o
-- RLS de `counters`, mostrando TODAS as linhas a quem quer que tenha
-- GRANT na view, independentemente da política da tabela base.
--
-- Isto tornou a correcção anterior desta sessão (remover
-- counters_select_guest) incompleta: `anon` continuava a conseguir ler
-- todos os balcões via esta view, porque ela nunca respeitava o RLS em
-- primeiro lugar.
--
-- Corrigido em dois passos:
-- 1. A view passa a `security_invoker = true` -- agora respeita a
--    política real de `counters` (staff da filial, ou cliente com
--    senha activa nesse balcão) para a role de quem pergunta, não do
--    dono da view.
-- 2. `current_agent_name` deixa de vir de um LEFT JOIN directo a
--    `staff` -- essa tabela só tem `staff_select_self` (só o próprio),
--    por isso um join normal devolveria sempre NULL para toda a gente
--    excepto o próprio agente a ver o seu balcão, partindo a
--    funcionalidade real (mostrar o nome do agente a quem tem senha
--    activa nesse balcão, ou a colegas da mesma filial). Resolvido com
--    uma função security definer estreita -- devolve só o nome, nunca
--    o resto da linha de staff -- chamada de dentro da própria view,
--    mesmo padrão já usado nesta base de dados para is_staff_of_branch/
--    is_kiosk_account (cruzar RLS de forma explícita e limitada, nunca
--    às cegas).

create or replace function public.staff_display_name(p_staff_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select name from staff where id = p_staff_id;
$$;

revoke all on function public.staff_display_name(uuid) from public;
grant execute on function public.staff_display_name(uuid) to authenticated;

create or replace view public.counters_with_agent as
select
  c.institution_id,
  c.branch_id,
  c.id,
  c.label,
  c.status,
  c.current_ticket_id,
  c.current_agent_id,
  public.staff_display_name(c.current_agent_id) as current_agent_name,
  c.services
from counters c;

alter view public.counters_with_agent set (security_invoker = on);

-- `anon` nunca teve um uso legítimo desta view (o convidado usa
-- branch_queue_summary) -- com security_invoker, o RLS de `counters`
-- (só `authenticated`) já bloqueia tudo para anon de qualquer forma;
-- revoga-se o grant também, por clareza e defesa em profundidade.
revoke select on public.counters_with_agent from anon;
