-- Auditoria de produto comercial (2026-09-07): não havia forma de saber
-- "quem fez o quê, quando, em que instituição/filial, com que
-- resultado" -- crítico para confiança institucional e para
-- investigar disputas ("o agente diz que concluiu, o cliente diz que
-- não foi atendido"). Log append-only, nunca editável/apagável pelo
-- cliente.

create table audit_logs (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  actor_id        uuid references auth.users(id),
  action          text not null,
  entity          text not null,
  entity_id       text,
  institution_id  text,
  branch_id       text,
  result          text not null default 'success' check (result in ('success', 'denied')),
  details         jsonb
);

-- Índices pelos filtros reais que um gestor/atendente vai usar: "o que
-- aconteceu nesta filial", "o que aconteceu com esta senha".
create index audit_logs_branch_created_idx on audit_logs (institution_id, branch_id, created_at desc);
create index audit_logs_entity_idx on audit_logs (entity, entity_id);

alter table audit_logs enable row level security;

-- Só a equipa da própria filial vê o registo dessa filial -- nunca o
-- cliente (mesmo sendo o próprio actor de alguns eventos, ex.:
-- cancel_ticket), e nunca staff de outra filial (mesma regra least
-- privilege já aplicada a tickets/counters).
create policy audit_logs_select on audit_logs for select to authenticated
  using (is_staff_of_branch(institution_id, branch_id));

-- Sem policy de insert/update/delete: só escrito internamente pela
-- função abaixo, chamada dentro das próprias RPCs SECURITY DEFINER --
-- nunca directamente pelo cliente (nem staff, nem service_role via API
-- pública).
create or replace function public.write_audit_log(
  p_action text, p_entity text, p_entity_id text,
  p_institution_id text, p_branch_id text,
  p_result text default 'success', p_details jsonb default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into audit_logs (actor_id, action, entity, entity_id, institution_id, branch_id, result, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_institution_id, p_branch_id, p_result, p_details);
$$;

-- Sem grant a authenticated: só chamada internamente (perform
-- write_audit_log(...)) pelas RPCs abaixo, nunca directamente pelo
-- cliente -- exactamente o mesmo padrão já usado para clear_counter().
