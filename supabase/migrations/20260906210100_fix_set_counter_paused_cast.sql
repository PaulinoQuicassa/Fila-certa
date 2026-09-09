-- Fase 8: encontrado ao testar entrega real via Realtime
-- (scripts/test-realtime-delivery.mjs, cenário "pausar balcão") --
-- set_counter_paused nunca tinha sido exercitado de ponta a ponta antes
-- disto (não estava no teste da Fase 9). O CASE com literais 'paused'/
-- 'available' fica com tipo `text`, e o Postgres recusa atribuir texto
-- directamente a uma coluna `counter_status` dentro de plpgsql sem cast
-- explícito -- por isso a função falhava sempre que chamada.
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
     set status = (case when p_paused then 'paused' else 'available' end)::counter_status
   where institution_id = p_institution_id and branch_id = p_branch_id and id = p_counter_id;
end;
$$;

revoke execute on function public.set_counter_paused(text, text, text, boolean) from public;
grant execute on function public.set_counter_paused(text, text, text, boolean) to authenticated;
