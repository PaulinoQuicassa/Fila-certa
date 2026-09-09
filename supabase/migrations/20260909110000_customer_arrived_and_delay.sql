-- Torna reais dois sinais do cliente que hoje só existiam visualmente na
-- app do cliente, sem gravar nada no servidor -- por isso nunca
-- chegavam ao ecrã do agente nem ao dashboard do gestor:
--
-- 1. "Cheguei" -- o cliente confirma que já está fisicamente no local,
--    à espera de ser chamado ao balcão.
-- 2. "Estou atrasado" -- o cliente avisa que vai demorar mais um pouco,
--    mas continua a caminho (distinto de "Não vou conseguir chegar",
--    que já era real via cancel_ticket).
--
-- Mesmo padrão exacto de customer_on_the_way/set_on_the_way (a única
-- diferença é dois campos novos em vez de um).

alter table tickets add column if not exists customer_arrived_at timestamptz;
alter table tickets add column if not exists customer_delay_reported_at timestamptz;

create or replace function public.report_customer_arrived(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tickets
     set customer_arrived_at = now()
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status = 'serving';

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou não está em atendimento';
  end if;
end;
$$;

revoke execute on function public.report_customer_arrived(uuid) from public;
grant execute on function public.report_customer_arrived(uuid) to authenticated;

create or replace function public.report_customer_delay(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tickets
     set customer_delay_reported_at = now()
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status = 'serving';

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou não está em atendimento';
  end if;
end;
$$;

revoke execute on function public.report_customer_delay(uuid) from public;
grant execute on function public.report_customer_delay(uuid) to authenticated;
