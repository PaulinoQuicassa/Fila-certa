-- Instrumenta as RPCs de mutação existentes com write_audit_log(...) --
-- só em caso de sucesso (uma excepção reverte a própria transacção,
-- incluindo o registo de auditoria -- ver comentário em
-- 20260907100000_audit_logs.sql sobre porquê tentativas negadas não
-- ficam auditadas por este mecanismo simples). Nenhuma mudança de
-- assinatura, comportamento ou grants -- só a chamada extra no fim.

create or replace function public.pull_ticket(p_institution_id text, p_branch_id text, p_service text)
returns tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
  v_code text;
  v_ticket tickets;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem tirar senha';
  end if;

  insert into branch_counters (institution_id, branch_id, seq)
    values (p_institution_id, p_branch_id, 1)
  on conflict (institution_id, branch_id)
    do update set seq = branch_counters.seq + 1
  returning seq into v_seq;

  v_code := 'B' || lpad(v_seq::text, 3, '0');

  insert into tickets (institution_id, branch_id, code, service, status, customer_id)
  values (p_institution_id, p_branch_id, v_code, p_service, 'waiting', auth.uid())
  returning * into v_ticket;

  perform write_audit_log('pull_ticket', 'ticket', v_ticket.id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('code', v_code, 'service', p_service));

  return v_ticket;
end;
$$;

create or replace function public.call_next(p_institution_id text, p_branch_id text, p_counter_id text)
returns tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket tickets;
  v_counter_label text;
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode chamar senhas';
  end if;

  select label into v_counter_label
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
  if v_counter_label is null then
    raise exception 'balcão não encontrado';
  end if;

  select * into v_ticket
    from tickets
   where institution_id = p_institution_id
     and branch_id = p_branch_id
     and status = 'waiting'
     and (transferred_to_counter_id is null or transferred_to_counter_id = p_counter_id)
   order by (transferred_to_counter_id = p_counter_id) desc nulls last, priority desc, created_at asc
   limit 1
   for update skip locked;

  if v_ticket.id is null then
    raise exception 'não há senhas em espera';
  end if;

  update tickets
     set status = 'serving',
         counter_id = p_counter_id,
         called_at = now(),
         transferred_to_counter_id = null,
         customer_on_the_way = false
   where id = v_ticket.id
  returning * into v_ticket;

  update counters
     set status = 'serving',
         current_ticket_id = v_ticket.id,
         current_agent_id = auth.uid()
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;

  insert into ticket_calls (institution_id, branch_id, ticket_id, code, counter_label)
  values (p_institution_id, p_branch_id, v_ticket.id, v_ticket.code, v_counter_label);

  perform write_audit_log('call_next', 'ticket', v_ticket.id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('counter_id', p_counter_id, 'code', v_ticket.code));

  return v_ticket;
end;
$$;

create or replace function public.recall_current(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
  v_code text;
  v_counter_label text;
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode voltar a chamar';
  end if;

  select current_ticket_id, label into v_ticket_id, v_counter_label
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;

  if v_ticket_id is null then
    raise exception 'este balcão não tem nenhuma senha em atendimento';
  end if;

  select code into v_code from tickets where id = v_ticket_id;

  insert into ticket_calls (institution_id, branch_id, ticket_id, code, counter_label)
  values (p_institution_id, p_branch_id, v_ticket_id, v_code, v_counter_label);

  perform write_audit_log('recall_current', 'ticket', v_ticket_id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('counter_id', p_counter_id, 'code', v_code));
end;
$$;

create or replace function public.complete_current(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode concluir o atendimento';
  end if;

  select current_ticket_id into v_ticket_id
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
  if v_ticket_id is null then
    raise exception 'este balcão não tem nenhuma senha em atendimento';
  end if;

  update tickets set status = 'done', done_at = now() where id = v_ticket_id;
  perform clear_counter(p_institution_id, p_branch_id, p_counter_id);

  perform write_audit_log('complete_current', 'ticket', v_ticket_id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('counter_id', p_counter_id));
end;
$$;

create or replace function public.mark_no_show(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode marcar ausência';
  end if;

  select current_ticket_id into v_ticket_id
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
  if v_ticket_id is null then
    raise exception 'este balcão não tem nenhuma senha em atendimento';
  end if;

  update tickets
     set status = 'no_show', done_at = now(), no_show_reason = 'staff_marked'
   where id = v_ticket_id;
  perform clear_counter(p_institution_id, p_branch_id, p_counter_id);

  perform write_audit_log('mark_no_show', 'ticket', v_ticket_id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('counter_id', p_counter_id));
end;
$$;

create or replace function public.transfer_ticket(
  p_institution_id text, p_branch_id text, p_counter_id text,
  p_target_counter_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode transferir';
  end if;

  select current_ticket_id into v_ticket_id
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
  if v_ticket_id is null then
    raise exception 'este balcão não tem nenhuma senha em atendimento';
  end if;

  update tickets
     set status = 'waiting',
         counter_id = null,
         called_at = null,
         transferred_to_counter_id = p_target_counter_id,
         was_transferred = true
   where id = v_ticket_id;
  perform clear_counter(p_institution_id, p_branch_id, p_counter_id);

  perform write_audit_log('transfer_ticket', 'ticket', v_ticket_id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('from_counter_id', p_counter_id, 'to_counter_id', p_target_counter_id));
end;
$$;

create or replace function public.set_counter_paused(p_institution_id text, p_branch_id text, p_counter_id text, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode pausar/retomar o balcão';
  end if;

  update counters
     set status = (case when p_paused then 'paused' else 'available' end)::counter_status
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;

  perform write_audit_log(case when p_paused then 'pause_counter' else 'resume_counter' end,
    'counter', p_counter_id, p_institution_id, p_branch_id, 'success', null);
end;
$$;

create or replace function public.cancel_ticket(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_institution_id text;
  v_branch_id text;
begin
  update tickets
     set status = 'no_show', no_show_reason = 'customer_cancelled'
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status in ('waiting', 'serving')
  returning institution_id, branch_id into v_institution_id, v_branch_id;

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou já não está activa';
  end if;

  perform write_audit_log('cancel_ticket', 'ticket', p_ticket_id::text, v_institution_id, v_branch_id, 'success', null);
end;
$$;

create or replace function public.set_on_the_way(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_institution_id text;
  v_branch_id text;
begin
  update tickets
     set customer_on_the_way = true
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status = 'serving'
  returning institution_id, branch_id into v_institution_id, v_branch_id;

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou não está em atendimento';
  end if;

  perform write_audit_log('set_on_the_way', 'ticket', p_ticket_id::text, v_institution_id, v_branch_id, 'success', null);
end;
$$;

create or replace function public.schedule_appointment(
  p_institution_id text, p_branch_id text, p_code text,
  p_service text, p_date date, p_time text
)
returns appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt appointments;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem agendar';
  end if;

  insert into appointments (code, institution_id, branch_id, customer_id, service, date, time, status)
  values (p_code, p_institution_id, p_branch_id, auth.uid(), p_service, p_date, p_time, 'scheduled')
  returning * into v_appt;

  perform write_audit_log('schedule_appointment', 'appointment', v_appt.code, p_institution_id, p_branch_id,
    'success', jsonb_build_object('service', p_service, 'date', p_date, 'time', p_time));

  return v_appt;
end;
$$;

create or replace function public.cancel_appointment(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_institution_id text;
  v_branch_id text;
begin
  update appointments
     set status = 'cancelled'
   where code = p_code
     and customer_id = auth.uid()
  returning institution_id, branch_id into v_institution_id, v_branch_id;

  if not found then
    raise exception 'agendamento não encontrado ou não pertence ao utilizador';
  end if;

  perform write_audit_log('cancel_appointment', 'appointment', p_code, v_institution_id, v_branch_id, 'success', null);
end;
$$;
