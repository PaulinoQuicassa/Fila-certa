-- Defesa em profundidade (auditoria de 2026-09-07): `anon`/`authenticated`
-- tinham GRANT total (INSERT/UPDATE/DELETE/TRUNCATE) em todas as
-- tabelas -- comportamento por omissão do Supabase ao criar tabelas no
-- schema public. Isto é seguro hoje porque o RLS bloqueia tudo o que
-- não tem policy explícita, mas é uma segurança de uma só camada: se o
-- RLS alguma vez for desactivado por engano numa tabela (ex.: numa
-- migration futura), essa tabela fica imediatamente aberta a qualquer
-- pessoa com a chave pública. Revoga-se aqui ao nível do GRANT o que
-- nunca deveria ser possível de qualquer forma, para que uma falha de
-- RLS não seja também uma falha de GRANT.
--
-- TRUNCATE nunca é necessário para nenhum papel da aplicação -- revogado
-- de todas as tabelas, sem excepção.

revoke truncate on
  institutions, branches, counters, staff, branch_counters,
  tickets, ticket_calls, appointments, ratings, notifications,
  user_settings, audit_logs, counters_with_agent
from anon, authenticated;

-- Tabelas só mutáveis via RPC SECURITY DEFINER -- nenhum INSERT/UPDATE/
-- DELETE directo, nunca teve policy para isso (ver security-rls.md).
-- SELECT mantido, continua controlado pelas policies existentes.
revoke insert, update, delete on
  institutions, branches, counters, staff, branch_counters,
  tickets, ticket_calls, appointments, audit_logs
from anon, authenticated;

-- ratings: mantém INSERT (tem policy própria, ratings_insert_own),
-- revoga UPDATE/DELETE (nunca teve policy -- "nunca poder ser alterada
-- depois de criada").
revoke update, delete on ratings from anon, authenticated;

-- notifications/user_settings: mantêm INSERT/UPDATE (têm policy
-- própria), revogam DELETE (nunca teve policy).
revoke delete on notifications, user_settings from anon, authenticated;
