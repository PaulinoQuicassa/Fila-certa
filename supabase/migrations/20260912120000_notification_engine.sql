-- Motor de notificações (Fases 11/12/14 do pedido de hardening):
-- tabela única de rastreio de entrega para qualquer canal/fornecedor
-- (hoje SMS e WhatsApp, via Twilio/Meta -- ver
-- supabase/functions/_shared/notifications/), com idempotência
-- garantida ao nível da base de dados, não só por uma verificação
-- SELECT-antes-de-INSERT no código (o mesmo tipo de condição de
-- corrida já corrigido em pull_ticket/owner_remove_owner na migração
-- anterior -- aqui fecha-se à partida com uma coluna unique).
--
-- Chama-se `notification_deliveries`, não `notifications` -- já existe
-- uma tabela `notifications` (20260906190000_initial_schema.sql) que é
-- a caixa de entrada PRIVADA do cliente (title/subtitle/read, lida
-- pelo sino do HomeScreen no Flutter); são conceitos diferentes -- esta
-- tabela nova é rastreio técnico de ENTREGA por fornecedor externo
-- (Twilio/Meta), nunca lida directamente pelo cliente. Reutilizar o
-- nome teria colidido com uma tabela em produção.
--
-- event_id é o identificador lógico do evento de negócio que originou
-- a notificação (ex.: "queue_called:<ticket_id>",
-- "queue_near_turn:<ticket_id>") -- 1 evento = no máximo 1 linha,
-- mesmo que o motor seja chamado várias vezes para o mesmo evento
-- (reentrega de webhook, retry de rede, duplo trigger). Nunca guarda o
-- conteúdo da OTP nem o corpo completo da mensagem -- só o necessário
-- para observabilidade e diagnóstico (Fase 16).
create table notification_deliveries (
  id                    uuid primary key default gen_random_uuid(),
  event_id              text not null unique,
  user_id               uuid references auth.users(id) on delete cascade,
  channel               text not null check (channel in ('sms', 'whatsapp')),
  provider              text not null,
  provider_message_id   text,
  status                text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'failed', 'read')),
  priority              text not null check (priority in ('critical', 'high', 'medium', 'low')),
  created_at            timestamptz not null default now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  error_code            text,
  error_message         text,
  retry_count           integer not null default 0
);

alter table notification_deliveries enable row level security;
-- Sem nenhuma policy -- mesmo padrão de audit_logs/whatsapp_message_log:
-- só as Edge Functions (service_role) leem/escrevem. Não há hoje
-- nenhum ecrã de "caixa de entrada de notificações" no cliente; se um
-- dia existir, a policy de select-só-do-próprio-user entra nessa
-- altura, com o ecrã que a vai usar.

create index notification_deliveries_user_created_idx on notification_deliveries (user_id, created_at desc);
-- Fila de reprocessamento (Fase 11/13): encontrar rapidamente o que
-- ainda não chegou a bom porto, por prioridade primeiro (CRITICAL
-- nunca deve esperar atrás de LOW -- Fase 12).
create index notification_deliveries_pending_idx on notification_deliveries (priority, created_at) where status in ('queued', 'failed');

-- ---------------------------------------------------------------------
-- record_notification_attempt -- ponto único de escrita nesta tabela,
-- chamado pelas Edge Functions com service_role. Faz o INSERT
-- idempotente (on conflict do nothing) e devolve se esta chamada foi
-- realmente a primeira para este event_id -- quem chama só efectua o
-- envio de facto quando `inserted = true`.
-- ---------------------------------------------------------------------
create or replace function public.record_notification_attempt(
  p_event_id text, p_user_id uuid, p_channel text, p_provider text, p_priority text
)
returns table (id uuid, inserted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into notification_deliveries (event_id, user_id, channel, provider, priority, status)
  values (p_event_id, p_user_id, p_channel, p_provider, p_priority, 'queued')
  on conflict (event_id) do nothing
  returning notification_deliveries.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select notification_deliveries.id into v_id from notification_deliveries where notification_deliveries.event_id = p_event_id;
  return query select v_id, false;
end;
$$;

revoke all on function public.record_notification_attempt(text, uuid, text, text, text) from public;
-- Só service_role chama isto (dentro das Edge Functions) -- nenhum
-- grant a authenticated, mesmo padrão de write_audit_log.

create or replace function public.update_notification_status(
  p_id uuid, p_status text, p_provider_message_id text default null,
  p_error_code text default null, p_error_message text default null,
  p_provider text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update notification_deliveries set
    status = p_status,
    provider = coalesce(p_provider, provider),
    provider_message_id = coalesce(p_provider_message_id, provider_message_id),
    error_code = p_error_code,
    error_message = p_error_message,
    sent_at = case when p_status = 'sent' and sent_at is null then now() else sent_at end,
    delivered_at = case when p_status in ('delivered', 'read') and delivered_at is null then now() else delivered_at end,
    failed_at = case when p_status = 'failed' then now() else failed_at end,
    retry_count = case when p_status = 'failed' then retry_count + 1 else retry_count end
  where id = p_id;
end;
$$;

revoke all on function public.update_notification_status(uuid, text, text, text, text, text) from public;
