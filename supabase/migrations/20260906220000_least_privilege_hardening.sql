-- Hardening de segurança pedido explicitamente antes da Fase 10 (ver
-- docs/security-rls.md para a auditoria/matriz completa). Princípio:
-- least privilege -- cada utilizador só recebe o que precisa para o seu
-- próprio contexto operacional (a sua senha, o seu balcão enquanto o
-- atende, a sua filial enquanto staff dessa filial).
--
-- Problema encontrado (Fase 8): tickets/counters/ticket_calls tinham
-- SELECT aberto a QUALQUER autenticado (security.md Decisão 1, réplica
-- do Firestore original) -- o teste real de Realtime confirmou que isto
-- deixa qualquer cliente OBSERVAR AO VIVO senhas de outros clientes e de
-- outras instituições, não só ler uma vez. Além disso, `is_staff_of`
-- só verificava a instituição, nunca a filial -- um agente de uma
-- filial conseguia (em teoria) chamar/ver senhas de outra filial da
-- mesma instituição, o que também viola least privilege.

-- ---------------------------------------------------------------------
-- Novo helper: pertence à equipa DESTA filial (não só desta instituição)
-- ---------------------------------------------------------------------

create or replace function public.is_staff_of_branch(p_institution_id text, p_branch_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from staff
    where staff.id = auth.uid()
      and staff.institution_id = p_institution_id
      and staff.branch_id = p_branch_id
  );
$$;

-- ---------------------------------------------------------------------
-- tickets: só o dono (customer_id = auth.uid()) ou a equipa dessa
-- filial. Deixa de haver leitura aberta a qualquer autenticado.
-- ---------------------------------------------------------------------

drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select to authenticated
  using (customer_id = auth.uid() or is_staff_of_branch(institution_id, branch_id));

-- ---------------------------------------------------------------------
-- counters: a equipa dessa filial, ou o cliente cuja senha está a ser
-- atendida NESSE balcão neste momento (precisa disto para detectar
-- "balcão em pausa" -- GlobalQueueAlerts). Nunca a filial inteira para
-- um cliente que não está a ser atendido lá.
-- ---------------------------------------------------------------------

drop policy if exists counters_select on counters;
create policy counters_select on counters for select to authenticated
  using (
    is_staff_of_branch(institution_id, branch_id)
    or exists (
      select 1 from tickets
      where tickets.id = counters.current_ticket_id
        and tickets.customer_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- ticket_calls: a equipa dessa filial, a sessão anónima do painel de TV
-- (não tem instituição própria -- é o próprio propósito dela mostrar o
-- quadro de chamadas ao público físico do balcão), ou um cliente com
-- senha activa nessa filial (legítimo ver o quadro de chamadas de onde
-- está fisicamente à espera). Nunca aberto a um cliente sem nenhuma
-- ligação a essa filial.
-- ---------------------------------------------------------------------

drop policy if exists ticket_calls_select on ticket_calls;
create policy ticket_calls_select on ticket_calls for select to authenticated
  using (
    is_anonymous_session()
    or is_staff_of_branch(institution_id, branch_id)
    or exists (
      select 1 from tickets
      where tickets.institution_id = ticket_calls.institution_id
        and tickets.branch_id = ticket_calls.branch_id
        and tickets.customer_id = auth.uid()
        and tickets.status in ('waiting', 'serving')
    )
  );

-- ---------------------------------------------------------------------
-- Achado relacionado, mesma causa raiz: as funções RPC de mutação só
-- verificavam a instituição (`is_staff_of`), nunca a filial -- um
-- agente da Filial A conseguiria, em teoria, chamar/concluir/transferir
-- senhas da Filial B da mesma instituição. Corrigido trocando
-- is_staff_of(p_institution_id) por
-- is_staff_of_branch(p_institution_id, p_branch_id) nas funções que já
-- recebem os dois parâmetros -- sem mudar assinatura nem grants.
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
end;
$$;

-- ---------------------------------------------------------------------
-- Agregados públicos-operacionais: substituem leituras que dependiam de
-- SELECT aberto em `tickets` para dados que são, por natureza,
-- informação pública da fila (quantas pessoas, que serviços, tempo
-- médio) e não dados de um cliente específico -- nunca devolvem
-- customer_id, código de senha alheio, nem qualquer outra coluna
-- identificável.
-- ---------------------------------------------------------------------

-- Substitui ticket_service.dart: subscribeQueueSize / subscribeWaitingServiceNames.
create or replace function public.branch_queue_summary(p_institution_id text, p_branch_id text)
returns table(service text, waiting_count bigint)
language sql
security definer
stable
set search_path = public
as $$
  select service, count(*) as waiting_count
    from tickets
   where institution_id = p_institution_id
     and branch_id = p_branch_id
     and status = 'waiting'
   group by service;
$$;

revoke execute on function public.branch_queue_summary(text, text) from public;
grant execute on function public.branch_queue_summary(text, text) to authenticated;

-- Substitui PublicDisplay.tsx: cálculo de tempo médio de espera (antes
-- lido a partir de subscribeTicketsToday, que uma sessão anónima já não
-- consegue ler linha a linha). Só a média, arredondada a minutos.
create or replace function public.branch_wait_stats(p_institution_id text, p_branch_id text)
returns numeric
language sql
security definer
stable
set search_path = public
as $$
  select round(avg(extract(epoch from (called_at - created_at)) / 60)::numeric, 0)
    from tickets
   where institution_id = p_institution_id
     and branch_id = p_branch_id
     and called_at is not null
     and created_at >= date_trunc('day', now());
$$;

revoke execute on function public.branch_wait_stats(text, text) from public;
grant execute on function public.branch_wait_stats(text, text) to authenticated, anon;

-- Substitui ticket_service.dart: subscribeWaitingAhead -- conta senhas
-- em espera antes da minha, sem expor as linhas de outros clientes.
-- Confirma a posse da senha antes de calcular (não aceita ticket_id à
-- socapa).
create or replace function public.waiting_ahead_count(p_ticket_id uuid)
returns integer
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_institution_id text;
  v_branch_id text;
  v_created_at timestamptz;
  v_count integer;
begin
  select institution_id, branch_id, created_at
    into v_institution_id, v_branch_id, v_created_at
    from tickets
   where id = p_ticket_id and customer_id = auth.uid();

  if v_institution_id is null then
    raise exception 'senha não encontrada ou não pertence ao utilizador';
  end if;

  select count(*) into v_count
    from tickets
   where institution_id = v_institution_id
     and branch_id = v_branch_id
     and status = 'waiting'
     and id <> p_ticket_id
     and created_at < v_created_at;

  return v_count;
end;
$$;

revoke execute on function public.waiting_ahead_count(uuid) from public;
grant execute on function public.waiting_ahead_count(uuid) to authenticated;
