-- Correcção de um bug real encontrado ao testar o fluxo de cancelamento
-- do lado do cliente contra produção.
--
-- Cenário: um cliente cancela a sua senha enquanto está a ser atendido
-- (`cancel_ticket`, define status='no_show', no_show_reason=
-- 'customer_cancelled' -- de propósito NÃO liberta o balcão, para o
-- agente ter de reconhecer explicitamente em vez de o balcão
-- desaparecer sozinho). O agente vê o aviso "O cliente avisou que não
-- vai comparecer" e clica "Libertar Balcão", que chama `mark_no_show` --
-- a mesma função usada quando é o AGENTE a marcar ausência a partir de
-- uma senha ainda em atendimento.
--
-- Bug: `mark_no_show` escrevia sempre no_show_reason = 'staff_marked',
-- mesmo quando a senha já estava 'no_show'/'customer_cancelled' --
-- apagando a informação real de que foi o cliente que cancelou.
--
-- Correcção: só escreve 'staff_marked' quando a transição é mesmo feita
-- pelo agente a partir de uma senha activa (status ainda não é
-- 'no_show'); quando já está 'no_show' (o caso "Libertar Balcão"),
-- mantém o motivo original.

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
     set status = 'no_show',
         done_at = now(),
         no_show_reason = case when status = 'no_show' then no_show_reason else 'staff_marked' end
   where id = v_ticket_id;
  perform clear_counter(p_institution_id, p_branch_id, p_counter_id);

  perform write_audit_log('mark_no_show', 'ticket', v_ticket_id::text, p_institution_id, p_branch_id, 'success', null);
end;
$$;

revoke execute on function public.mark_no_show(text, text, text) from public;
grant execute on function public.mark_no_show(text, text, text) to authenticated;
