-- Fase 1 (segurança) -- restringe EXECUTE de `anon` nas funções `public`.
--
-- Estado antes: `anon` tem EXECUTE nas 67 funções `public` (predefinição do
-- Supabase; o REVOKE ... FROM public não o remove). `authenticated` tem
-- EXECUTE nas 67.
--
-- Não altera implementações, RLS, tabelas nem dados. Só privilégios EXECUTE.
--
-- Mantidas com EXECUTE para `anon`:
--   helpers usados por políticas RLS: is_owner(), is_staff_of_branch(text,text),
--     is_anonymous_session()
--   leituras feitas pela app Flutter antes do login:
--     queue_capacity_preview(text,text,text), branch_queue_summary(text,text),
--     branch_wait_stats(text,text)
--
-- Quatro funções internas sem validação de identidade (R1): removidas de
-- `anon` e `authenticated`; `service_role` mantém acesso (Edge Functions).
-- Os chamadores internos são todos SECURITY DEFINER com dono `postgres`, por
-- isso continuam a funcionar sem EXECUTE para `authenticated`/`anon`.
--
-- Rollback: supabase/rollbacks/20261004120000_restrict_rpc_execute_rollback.sql

-- ---------------------------------------------------------------------
-- 1. Funções R1 -- sem validação de identidade. anon e authenticated sem acesso.
-- ---------------------------------------------------------------------

revoke execute on function public.update_notification_status(uuid, text, text, text, text, text) from anon, authenticated;
revoke execute on function public.record_notification_attempt(text, uuid, text, text, text) from anon, authenticated;
revoke execute on function public.clear_counter(text, text, text) from anon, authenticated;
revoke execute on function public.write_audit_log(text, text, text, text, text, text, jsonb) from anon, authenticated;

grant execute on function public.update_notification_status(uuid, text, text, text, text, text) to service_role;
grant execute on function public.record_notification_attempt(text, uuid, text, text, text) to service_role;
grant execute on function public.clear_counter(text, text, text) to service_role;
grant execute on function public.write_audit_log(text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 2. Restantes funções -- anon sem EXECUTE. authenticated não muda.
--    Nenhuma é chamada por anon nas apps (verificado no código).
-- ---------------------------------------------------------------------

revoke execute on function public.assign_counter_agent(text, text, text, uuid) from anon;
revoke execute on function public.call_next(text, text, text) from anon;
revoke execute on function public.cancel_appointment(text) from anon;
revoke execute on function public.cancel_ticket(uuid) from anon;
revoke execute on function public.complete_current(text, text, text) from anon;
revoke execute on function public.director_alerts(text, text) from anon;
revoke execute on function public.director_benchmarking(text, text) from anon;
revoke execute on function public.director_capacity_kpis(text) from anon;
revoke execute on function public.director_kpis(text, text) from anon;
revoke execute on function public.director_pct_change(numeric, numeric) from anon;
revoke execute on function public.director_period_bounds(text) from anon;
revoke execute on function public.director_trend(text, text) from anon;
revoke execute on function public.director_update_branch_capacity(text, text, time, time, integer, integer, integer, boolean) from anon;
revoke execute on function public.is_director_of(text) from anon;
revoke execute on function public.is_kiosk_account(uuid) from anon;
revoke execute on function public.is_manager_of_branch(text, text) from anon;
revoke execute on function public.list_branch_staff(text, text) from anon;
revoke execute on function public.mark_no_show(text, text, text) from anon;
revoke execute on function public.next_appointment_code(text, text) from anon;
revoke execute on function public.normalize_and_validate_slug_id(text, text) from anon;
revoke execute on function public.owner_add_owner(text, text) from anon;
revoke execute on function public.owner_assign_staff(text, text, staff_role, text, text) from anon;
revoke execute on function public.owner_create_access_profile(text, profile_scope, text[]) from anon;
revoke execute on function public.owner_create_branch(text, text, text) from anon;
revoke execute on function public.owner_create_counter(text, text, text, text) from anon;
revoke execute on function public.owner_create_institution(text, text, text, text, integer) from anon;
revoke execute on function public.owner_delete_access_profile(uuid) from anon;
revoke execute on function public.owner_delete_branch(text, text) from anon;
revoke execute on function public.owner_delete_counter(text, text, text) from anon;
revoke execute on function public.owner_delete_institution(text) from anon;
revoke execute on function public.owner_list_access_profiles() from anon;
revoke execute on function public.owner_list_institutions_overview() from anon;
revoke execute on function public.owner_list_owners() from anon;
revoke execute on function public.owner_list_staff() from anon;
revoke execute on function public.owner_mfa_status() from anon;
revoke execute on function public.owner_remove_owner(uuid) from anon;
revoke execute on function public.owner_remove_staff(uuid) from anon;
revoke execute on function public.owner_set_kiosk_account(uuid, boolean, text) from anon;
revoke execute on function public.owner_set_owner_profile(uuid, uuid) from anon;
revoke execute on function public.owner_set_staff_profile(uuid, uuid) from anon;
revoke execute on function public.owner_update_institution(text, text, text, text, integer, institution_status) from anon;
revoke execute on function public.pull_ticket(text, text, text, text, boolean) from anon;
revoke execute on function public.recall_current(text, text, text) from anon;
revoke execute on function public.record_phone_verified_event() from anon;
revoke execute on function public.report_customer_arrived(uuid) from anon;
revoke execute on function public.report_customer_delay(uuid) from anon;
revoke execute on function public.schedule_appointment(text, text, text, text, date, text) from anon;
revoke execute on function public.set_counter_paused(text, text, text, boolean) from anon;
revoke execute on function public.set_counter_services(text, text, text, text[]) from anon;
revoke execute on function public.set_on_the_way(uuid) from anon;
revoke execute on function public.set_whatsapp_notifications(boolean) from anon;
revoke execute on function public.staff_display_name(uuid) from anon;
revoke execute on function public.transfer_ticket(text, text, text, text) from anon;
revoke execute on function public.validate_display_name(text, text) from anon;
revoke execute on function public.waiting_ahead_count(uuid) from anon;
revoke execute on function public.watch_branch_capacity(text, text, text) from anon;
revoke execute on function public.whatsapp_notifications_status() from anon;

-- ---------------------------------------------------------------------
-- 3. EXECUTE herdado de PUBLIC. `anon` e `authenticated` herdam de PUBLIC;
--    um REVOKE ... FROM anon não o remove. Estas seis funções têm EXECUTE
--    para PUBLIC (pré-verificação de 2026-10-04). São chamadas apenas por
--    funções SECURITY DEFINER com dono postgres, por isso não dependem de PUBLIC.
-- ---------------------------------------------------------------------

revoke execute on function public.clear_counter(text, text, text) from public;
revoke execute on function public.write_audit_log(text, text, text, text, text, text, jsonb) from public;
revoke execute on function public.director_pct_change(numeric, numeric) from public;
revoke execute on function public.director_period_bounds(text) from public;
revoke execute on function public.is_director_of(text) from public;
revoke execute on function public.is_manager_of_branch(text, text) from public;
