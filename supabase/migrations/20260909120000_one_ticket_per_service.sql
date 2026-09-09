-- O cliente só pode ter uma senha activa (`waiting` ou `serving`) por
-- serviço, na mesma filial -- evita duplicados por duplo-toque/reload
-- que depois ficam impossíveis de distinguir em "Os meus atendimentos"
-- e sem forma de os abandonar todos de uma vez.
--
-- Excepção: a conta técnica da estação de auto-atendimento
-- (`estacao@...`, ver Estacao.tsx / supabase.ts) é partilhada por todos
-- os cidadãos que tiram senha fisicamente no balcão -- aplicar aqui o
-- limite bloquearia a fila inteira a partir do segundo cidadão a pedir
-- o mesmo serviço.

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
  v_email text;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem tirar senha';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  if v_email is null or v_email not like 'estacao@%' then
    if exists (
      select 1 from tickets
       where institution_id = p_institution_id
         and branch_id = p_branch_id
         and service = p_service
         and customer_id = auth.uid()
         and status in ('waiting', 'serving')
    ) then
      raise exception 'já tem uma senha activa para este serviço';
    end if;
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

revoke execute on function public.pull_ticket(text, text, text) from public;
grant execute on function public.pull_ticket(text, text, text) to authenticated;
