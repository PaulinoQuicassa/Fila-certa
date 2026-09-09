-- Fase 10 (docs/migration-plan.md): ao reescrever AgentScreen.tsx para
-- chamar call_next() sem escolher a senha manualmente, reparei que a
-- versão da Fase 9 ignorava `transferred_to_counter_id` -- podia entregar
-- a outro balcão uma senha reservada para um balcão específico
-- (transferTicket com targetCounterId), quebrando a garantia que já
-- existia no código React anterior (eligibleQueue em AgentScreen.tsx
-- só deixava um balcão ver/chamar senhas transferidas para si ou sem
-- destino). Corrige sem mudar a assinatura da função.
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

revoke execute on function public.call_next(text, text, text) from public;
grant execute on function public.call_next(text, text, text) to authenticated;
