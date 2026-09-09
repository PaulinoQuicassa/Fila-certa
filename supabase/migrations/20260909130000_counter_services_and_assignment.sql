-- Autonomia do gestor para configurar balcões: hoje qualquer balcão
-- chama qualquer senha em espera, mas na realidade cada balcão físico
-- só atende alguns serviços -- e não há forma nenhuma de o gestor
-- atribuir um colaborador a um balcão específico (só existe
-- `current_agent_id`, que é transitório: fica preenchido enquanto esse
-- colaborador está mesmo a atender uma senha nesse balcão, apagado
-- assim que liberta -- ver counters_with_agent_view.sql). Isto adiciona
-- a atribuição persistente (`staff.counter_id`, já existia na coluna
-- mas nada a escrevia fora do seed) e um filtro de serviços por balcão.

-- ---------------------------------------------------------------------
-- counters.services -- null (ou vazio) continua a significar "todos os
-- serviços", exactamente o comportamento actual -- só passa a haver
-- restrição depois de um gestor a configurar explicitamente.
-- ---------------------------------------------------------------------

alter table counters add column if not exists services text[];

-- ---------------------------------------------------------------------
-- Helper: é gestor DESTA filial (não só staff qualquer)
-- ---------------------------------------------------------------------

create or replace function public.is_manager_of_branch(p_institution_id text, p_branch_id text)
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
      and staff.role = 'manager'
  );
$$;

-- ---------------------------------------------------------------------
-- list_branch_staff -- roster da filial (nome/papel/balcão atribuído)
-- para o ecrã "Gerir Balcões" preencher o selector de colaborador.
-- Só o gestor precisa disto (o agente não tem nenhum ecrã que o use).
-- ---------------------------------------------------------------------

create or replace function public.list_branch_staff(p_institution_id text, p_branch_id text)
returns table (id uuid, name text, role staff_role, counter_id text)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_manager_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só um gestor desta filial pode ver a lista de colaboradores';
  end if;

  return query
    select s.id, s.name, s.role, s.counter_id
    from staff s
    where s.institution_id = p_institution_id
      and s.branch_id = p_branch_id
    order by s.name;
end;
$$;

revoke execute on function public.list_branch_staff(text, text) from public;
grant execute on function public.list_branch_staff(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- set_counter_services -- p_services vazio ou null volta a "todos os
-- serviços" (nullif normaliza array vazio para null).
-- ---------------------------------------------------------------------

create or replace function public.set_counter_services(p_institution_id text, p_branch_id text, p_counter_id text, p_services text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_manager_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só um gestor desta filial pode configurar os serviços do balcão';
  end if;

  update counters
     set services = nullif(p_services, '{}')
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;

  if not found then
    raise exception 'balcão não encontrado';
  end if;

  perform write_audit_log('set_counter_services', 'counter', p_counter_id, p_institution_id, p_branch_id,
    'success', jsonb_build_object('services', p_services));
end;
$$;

revoke execute on function public.set_counter_services(text, text, text, text[]) from public;
grant execute on function public.set_counter_services(text, text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- assign_counter_agent -- p_agent_id null liberta o balcão. Um balcão só
-- tem um colaborador atribuído de cada vez: atribuir liberta
-- automaticamente quem lá estava antes.
-- ---------------------------------------------------------------------

create or replace function public.assign_counter_agent(p_institution_id text, p_branch_id text, p_counter_id text, p_agent_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_manager_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só um gestor desta filial pode atribuir balcões';
  end if;

  if not exists (
    select 1 from counters
     where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id
  ) then
    raise exception 'balcão não encontrado';
  end if;

  update staff
     set counter_id = null
   where institution_id = p_institution_id
     and branch_id = p_branch_id
     and counter_id = p_counter_id;

  if p_agent_id is not null then
    update staff
       set counter_id = p_counter_id
     where id = p_agent_id
       and institution_id = p_institution_id
       and branch_id = p_branch_id;

    if not found then
      raise exception 'colaborador não encontrado nesta filial';
    end if;
  end if;

  perform write_audit_log('assign_counter_agent', 'counter', p_counter_id, p_institution_id, p_branch_id,
    'success', jsonb_build_object('agent_id', p_agent_id));
end;
$$;

revoke execute on function public.assign_counter_agent(text, text, text, uuid) from public;
grant execute on function public.assign_counter_agent(text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- counters_with_agent -- expõe `services` (dashboard/agente já lêem
-- desta view, não da tabela directamente).
-- ---------------------------------------------------------------------

-- `create or replace view` só permite ACRESCENTAR colunas no fim da
-- lista -- `services` tem de vir depois de `current_agent_name`
-- (a posição das colunas já existentes não pode mudar).
create or replace view public.counters_with_agent as
select
  c.institution_id,
  c.branch_id,
  c.id,
  c.label,
  c.status,
  c.current_ticket_id,
  c.current_agent_id,
  s.name as current_agent_name,
  c.services
from counters c
left join staff s on s.id = c.current_agent_id;

-- ---------------------------------------------------------------------
-- call_next -- passa a respeitar counters.services: só considera senhas
-- desses serviços, a não ser que a senha tenha sido especificamente
-- transferida para este balcão (uma transferência é já uma decisão
-- humana explícita, não deve ser bloqueada pela configuração-padrão do
-- balcão) ou o balcão não tenha nenhuma restrição configurada (null).
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
  v_counter_services text[];
begin
  if not is_staff_of_branch(p_institution_id, p_branch_id) then
    raise exception 'só a equipa desta filial pode chamar senhas';
  end if;

  select label, services into v_counter_label, v_counter_services
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
     and (
       transferred_to_counter_id = p_counter_id
       or v_counter_services is null
       or service = any(v_counter_services)
     )
   order by (transferred_to_counter_id = p_counter_id) desc nulls last, priority desc, created_at asc
   limit 1
   for update skip locked;

  if v_ticket.id is null then
    raise exception 'não há senhas em espera para os serviços deste balcão';
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
