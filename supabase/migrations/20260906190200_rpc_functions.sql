-- Fase 9 do plano de migração (docs/migration-plan.md).
-- Substitui, uma a uma, as operações que hoje correm no cliente dentro
-- de transacções do SDK Firestore (fila-certa-staff/src/lib/queue.ts e
-- projectogestaodefilas/lib/ticket_service.dart) por funções Postgres
-- SECURITY DEFINER, chamadas via supabase.rpc(...). É esta mudança que
-- resolve os pontos 20/21 do mandato de migração: nenhuma tabela de
-- fila aceita INSERT/UPDATE directo (ver 20260906190100_rls.sql) --
-- só estas funções escrevem nelas, cada uma validando a própria
-- autorização antes de mexer em qualquer linha.
--
-- Convenção repetida em todas: `set search_path = public` (obrigatório
-- em SECURITY DEFINER para não poder ser enganada por um search_path
-- malicioso), e revogar EXECUTE de PUBLIC/anon, concedendo só a
-- `authenticated`.

-- ---------------------------------------------------------------------
-- Helper: sessão anónima? (equivalente a
-- request.auth.token.firebase.sign_in_provider != 'anonymous' nas
-- Firestore rules -- o Supabase também marca sessões anónimas com
-- is_anonymous=true no JWT, mesmo usando o mesmo papel `authenticated`).
-- ---------------------------------------------------------------------

create or replace function public.is_anonymous_session()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- ---------------------------------------------------------------------
-- pull_ticket -- substitui ticket_service.dart: pullTicket()
-- ---------------------------------------------------------------------

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

  return v_ticket;
end;
$$;

revoke execute on function public.pull_ticket(text, text, text) from public;
grant execute on function public.pull_ticket(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- next_appointment_code -- substitui ticket_service.dart: nextAppointmentCode()
-- Mesma sequência partilhada de pull_ticket (branch_counters), tal como
-- já acontecia com meta/ticketSeq no Firestore.
-- ---------------------------------------------------------------------

create or replace function public.next_appointment_code(p_institution_id text, p_branch_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem agendar';
  end if;

  insert into branch_counters (institution_id, branch_id, seq)
    values (p_institution_id, p_branch_id, 1)
  on conflict (institution_id, branch_id)
    do update set seq = branch_counters.seq + 1
  returning seq into v_seq;

  return 'AG' || lpad(v_seq::text, 3, '0');
end;
$$;

revoke execute on function public.next_appointment_code(text, text) from public;
grant execute on function public.next_appointment_code(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- schedule_appointment / cancel_appointment -- substitui
-- ticket_service.dart: scheduleAppointment() / cancelAppointmentMirror(),
-- já unificados numa tabela só (ver docs/security.md, Decisão 3).
-- ---------------------------------------------------------------------

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

  return v_appt;
end;
$$;

revoke execute on function public.schedule_appointment(text, text, text, text, date, text) from public;
grant execute on function public.schedule_appointment(text, text, text, text, date, text) to authenticated;

create or replace function public.cancel_appointment(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update appointments
     set status = 'cancelled'
   where code = p_code
     and customer_id = auth.uid();

  if not found then
    raise exception 'agendamento não encontrado ou não pertence ao utilizador';
  end if;
end;
$$;

revoke execute on function public.cancel_appointment(text) from public;
grant execute on function public.cancel_appointment(text) to authenticated;

-- ---------------------------------------------------------------------
-- call_next -- substitui queue.ts: callNext()
-- SKIP LOCKED resolve directamente o cenário do ponto 21 do mandato:
-- dois agentes a chamar em simultâneo nunca ficam presos à espera um
-- do outro nem podem chamar a mesma senha duas vezes.
-- ---------------------------------------------------------------------

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
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode chamar senhas';
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
   order by priority desc, created_at asc
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

  return v_ticket;
end;
$$;

revoke execute on function public.call_next(text, text, text) from public;
grant execute on function public.call_next(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- recall_current -- substitui queue.ts: recallCurrent()
-- ---------------------------------------------------------------------

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
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode voltar a chamar';
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
end;
$$;

revoke execute on function public.recall_current(text, text, text) from public;
grant execute on function public.recall_current(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- clear_counter (interna, não exposta) -- réplica de queue.ts:
-- clearCounter(), reaproveitada por complete_current/mark_no_show/
-- transfer_ticket.
-- ---------------------------------------------------------------------

create or replace function public.clear_counter(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update counters
     set status = 'available',
         current_ticket_id = null,
         current_agent_id = null
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
$$;

-- sem grant a authenticated: só chamada internamente pelas funções abaixo.

-- ---------------------------------------------------------------------
-- complete_current -- substitui queue.ts: completeCurrent()
-- ---------------------------------------------------------------------

create or replace function public.complete_current(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode concluir o atendimento';
  end if;

  select current_ticket_id into v_ticket_id
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
  if v_ticket_id is null then
    raise exception 'este balcão não tem nenhuma senha em atendimento';
  end if;

  update tickets set status = 'done', done_at = now() where id = v_ticket_id;
  perform clear_counter(p_institution_id, p_branch_id, p_counter_id);
end;
$$;

revoke execute on function public.complete_current(text, text, text) from public;
grant execute on function public.complete_current(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- mark_no_show -- substitui queue.ts: markNoShow()
-- ---------------------------------------------------------------------

create or replace function public.mark_no_show(p_institution_id text, p_branch_id text, p_counter_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode marcar ausência';
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
end;
$$;

revoke execute on function public.mark_no_show(text, text, text) from public;
grant execute on function public.mark_no_show(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- transfer_ticket -- substitui queue.ts: transferTicket()
-- ---------------------------------------------------------------------

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
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode transferir';
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
end;
$$;

revoke execute on function public.transfer_ticket(text, text, text, text) from public;
grant execute on function public.transfer_ticket(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- set_counter_paused -- substitui queue.ts: setCounterPaused()
-- ---------------------------------------------------------------------

create or replace function public.set_counter_paused(p_institution_id text, p_branch_id text, p_counter_id text, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_staff_of(p_institution_id) then
    raise exception 'só a equipa desta instituição pode pausar/retomar o balcão';
  end if;

  update counters
     set status = case when p_paused then 'paused' else 'available' end
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
end;
$$;

revoke execute on function public.set_counter_paused(text, text, text, boolean) from public;
grant execute on function public.set_counter_paused(text, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- cancel_ticket -- substitui ticket_service.dart: cancelTicket()
-- Cobre "Sair da fila" (status='waiting') e "Não posso comparecer"
-- (status='serving') com a mesma função, tal como já acontecia com a
-- Firestore rule original.
-- ---------------------------------------------------------------------

create or replace function public.cancel_ticket(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tickets
     set status = 'no_show', no_show_reason = 'customer_cancelled'
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status in ('waiting', 'serving');

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou já não está activa';
  end if;
end;
$$;

revoke execute on function public.cancel_ticket(uuid) from public;
grant execute on function public.cancel_ticket(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- set_on_the_way -- substitui ticket_service.dart: setOnTheWay()
-- ---------------------------------------------------------------------

create or replace function public.set_on_the_way(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tickets
     set customer_on_the_way = true
   where id = p_ticket_id
     and customer_id = auth.uid()
     and status = 'serving';

  if not found then
    raise exception 'senha não encontrada, não pertence ao utilizador, ou não está em atendimento';
  end if;
end;
$$;

revoke execute on function public.set_on_the_way(uuid) from public;
grant execute on function public.set_on_the_way(uuid) to authenticated;
