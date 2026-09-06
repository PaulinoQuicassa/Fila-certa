-- Fase 10: `counters.current_agent_id` aponta para auth.users(id) (ver
-- comentário em 20260906190000_initial_schema.sql sobre porquê não é
-- staff(id) directamente), mas o frontend precisa do NOME do agente
-- (Counter.agentName), tal como mostrava antes o campo `agentName`
-- gravado directamente no documento do balcão no Firestore. Como
-- `current_agent_id` referencia auth.users e `staff.id = auth.users.id`,
-- um LEFT JOIN a `staff` resolve o nome sem duplicar dado nenhum.
create view public.counters_with_agent as
select
  c.institution_id,
  c.branch_id,
  c.id,
  c.label,
  c.status,
  c.current_ticket_id,
  c.current_agent_id,
  s.name as current_agent_name
from counters c
left join staff s on s.id = c.current_agent_id;

-- Propositadamente SEM `security_invoker` (fica no default: corre com os
-- privilégios do dono da view). `staff_select_self` só deixa cada
-- funcionário ver a própria linha, mas no Firestore `agentName` vinha
-- gravado directamente no documento do balcão -- visível a qualquer
-- utilizador autenticado, tal como `counters_select` (docs/security.md).
-- Correr como dono expõe só as colunas escolhidas aqui (nunca o resto de
-- `staff`, como role/institution_id), reproduzindo exactamente essa
-- mesma abertura, não mais.
grant select on public.counters_with_agent to authenticated;
