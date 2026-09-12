-- Liga o WhatsApp a uma conta por telefone já verificada (2026-09-12).
--
-- Contexto: o cliente Flutter passou a registar-se por telefone +
-- código OTP (autenticação nativa do Supabase -- `auth.users.phone` /
-- `phone_confirmed_at`, não uma tabela própria). O toggle "Notificações
-- por WhatsApp" já existia mas nunca esteve ligado a nada real -- esta
-- migração é a ponte que falta: activar o toggle associa o número já
-- verificado da conta a `whatsapp_contacts` (criada na migração do
-- canal WhatsApp, 20260910110000), que é exactamente a tabela que
-- `whatsapp-notifier` já usa para saber a quem mandar mensagem. Sem
-- reimplementar nada do canal -- só a associar-lhe uma conta que chegou
-- por outro caminho (a app, não uma conversa iniciada no WhatsApp).
--
-- O número tem de estar mesmo verificado (`phone_confirmed_at` não
-- nulo) -- nunca confiar num número não confirmado para decidir quem
-- recebe notificações de outra pessoa.

create or replace function public.set_whatsapp_notifications(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_confirmed timestamptz;
  v_e164 text;
begin
  select phone, phone_confirmed_at into v_phone, v_confirmed
  from auth.users where id = auth.uid();

  if v_phone is null or v_phone = '' or v_confirmed is null then
    raise exception 'a conta ainda não tem um número de telefone verificado';
  end if;

  v_e164 := '+' || v_phone;

  if p_enabled then
    insert into whatsapp_contacts (phone, user_id)
    values (v_e164, auth.uid())
    on conflict (phone) do update set user_id = excluded.user_id;
  else
    delete from whatsapp_contacts where phone = v_e164 and user_id = auth.uid();
  end if;

  perform write_audit_log(
    case when p_enabled then 'whatsapp_notifications_enabled' else 'whatsapp_notifications_disabled' end,
    'auth_user', auth.uid()::text, null, null, 'success',
    jsonb_build_object('phone', v_e164)
  );
end;
$$;

revoke all on function public.set_whatsapp_notifications(boolean) from public;
grant execute on function public.set_whatsapp_notifications(boolean) to authenticated;

-- Estado real (não só a preferência local) -- para a app mostrar
-- "activado" só quando o número está mesmo ligado em whatsapp_contacts,
-- nunca a partir só de `user_settings.whatsapp` (que podia estar
-- dessincronizado, ex.: depois de mudar de número).
create or replace function public.whatsapp_notifications_status()
returns table (phone text, phone_verified boolean, notifications_enabled boolean)
language sql
security definer
set search_path = public
stable
as $$
  select
    case when u.phone is null or u.phone = '' then null else '+' || u.phone end,
    u.phone is not null and u.phone <> '' and u.phone_confirmed_at is not null,
    exists (
      select 1 from whatsapp_contacts wc
      where wc.user_id = auth.uid() and wc.phone = '+' || u.phone
    )
  from auth.users u
  where u.id = auth.uid();
$$;

revoke all on function public.whatsapp_notifications_status() from public;
grant execute on function public.whatsapp_notifications_status() to authenticated;

-- Auditoria simples do momento de verificação do telefone -- chamada
-- pela app mesmo a seguir a `verifyOTP` ter sucesso (esse passo em si
-- é tratado inteiramente pelo Supabase Auth, sem RPC nossa no meio;
-- isto só regista o evento para haver rasto).
create or replace function public.record_phone_verified_event()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_confirmed timestamptz;
begin
  select phone, phone_confirmed_at into v_phone, v_confirmed
  from auth.users where id = auth.uid();

  if v_phone is null or v_confirmed is null then
    raise exception 'número de telefone não verificado';
  end if;

  perform write_audit_log('phone_verified', 'auth_user', auth.uid()::text, null, null, 'success', jsonb_build_object('phone', '+' || v_phone));
end;
$$;

revoke all on function public.record_phone_verified_event() from public;
grant execute on function public.record_phone_verified_event() to authenticated;
