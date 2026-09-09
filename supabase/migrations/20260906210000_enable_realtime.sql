-- Fase 8 do plano de migração (docs/migration-plan.md): activa a
-- replicação lógica (`supabase_realtime`) só nas tabelas que o código
-- cliente realmente subscreve via postgres_changes hoje (ver
-- docs/realtime-audit.md e docs/realtime-architecture.md). Sem isto, os
-- canais `.channel(...).on('postgres_changes', ...)` ficam subscritos
-- mas NUNCA recebem nenhum evento -- confirmado com um teste real que
-- todos os cenários (tickets, counters) davam timeout antes desta
-- migration (ver scripts/test-realtime-delivery.mjs).
--
-- Fora desta lista, de propósito: institutions/branches/staff/
-- branch_counters -- nenhum ecrã subscreve estas tabelas em tempo real
-- hoje (mudam raramente e não têm nenhum consumidor ao vivo); activar
-- Realtime nelas seria trabalho sem utilizador, ao contrário do pedido
-- explícito de não activar Realtime indiscriminadamente em tudo.
alter publication supabase_realtime add table
  tickets,
  counters,
  ticket_calls,
  appointments,
  ratings,
  notifications,
  user_settings;
