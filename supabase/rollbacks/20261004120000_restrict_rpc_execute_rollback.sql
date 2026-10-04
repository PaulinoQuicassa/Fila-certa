-- ROLLBACK de supabase/migrations/20261004120000_restrict_rpc_execute.sql
--
-- NÃO está em supabase/migrations/ de propósito: o Supabase CLI aplicaria
-- este ficheiro como migração. Executar manualmente só se for preciso reverter.
--
-- Repõe exactamente o estado anterior: anon e authenticated com EXECUTE nas
-- 67 funções `public` (verificado com has_function_privilege antes da migração).
-- Não toca em implementações, RLS, tabelas nem dados.

-- Funções R1: repor anon e authenticated.
grant execute on function public.update_notification_status(uuid, text, text, text, text, text) to anon, authenticated;
grant execute on function public.record_notification_attempt(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.clear_counter(text, text, text) to anon, authenticated;
grant execute on function public.write_audit_log(text, text, text, text, text, text, jsonb) to anon, authenticated;

-- Restantes funções: repor anon.
grant execute on function public.assign_counter_agent(text, text, text, uuid) to anon;
grant execute on function public.call_next(text, text, text) to anon;
grant execute on function public.cancel_appointment(text) to anon;
grant execute on function public.cancel_ticket(uuid) to anon;
grant execute on function public.complete_current(text, text, text) to anon;
grant execute on function public.director_alerts(text, text) to anon;
grant execute on function public.director_benchmarking(text, text) to anon;
grant execute on function public.director_capacity_kpis(text) to anon;
grant execute on function public.director_kpis(text, text) to anon;
grant execute on function public.director_pct_change(numeric, numeric) to anon;
grant execute on function public.director_period_bounds(text) to anon;
grant execute on function public.director_trend(text, text) to anon;
grant execute on function public.director_update_branch_capacity(text, text, time, time, integer, integer, integer, boolean) to anon;
grant execute on function public.is_director_of(text) to anon;
grant execute on function public.is_kiosk_account(uuid) to anon;
grant execute on function public.is_manager_of_branch(text, text) to anon;
grant execute on function public.list_branch_staff(text, text) to anon;
grant execute on function public.mark_no_show(text, text, text) to anon;
grant execute on function public.next_appointment_code(text, text) to anon;
grant execute on function public.normalize_and_validate_slug_id(text, text) to anon;
grant execute on function public.owner_add_owner(text, text) to anon;
grant execute on function public.owner_assign_staff(text, text, staff_role, text, text) to anon;
grant execute on function public.owner_create_access_profile(text, profile_scope, text[]) to anon;
grant execute on function public.owner_create_branch(text, text, text) to anon;
grant execute on function public.owner_create_counter(text, text, text, text) to anon;
grant execute on function public.owner_create_institution(text, text, text, text, integer) to anon;
grant execute on function public.owner_delete_access_profile(uuid) to anon;
grant execute on function public.owner_delete_branch(text, text) to anon;
grant execute on function public.owner_delete_counter(text, text, text) to anon;
grant execute on function public.owner_delete_institution(text) to anon;
grant execute on function public.owner_list_access_profiles() to anon;
grant execute on function public.owner_list_institutions_overview() to anon;
grant execute on function public.owner_list_owners() to anon;
grant execute on function public.owner_list_staff() to anon;
grant execute on function public.owner_mfa_status() to anon;
grant execute on function public.owner_remove_owner(uuid) to anon;
grant execute on function public.owner_remove_staff(uuid) to anon;
grant execute on function public.owner_set_kiosk_account(uuid, boolean, text) to anon;
grant execute on function public.owner_set_owner_profile(uuid, uuid) to anon;
grant execute on function public.owner_set_staff_profile(uuid, uuid) to anon;
grant execute on function public.owner_update_institution(text, text, text, text, integer, institution_status) to anon;
grant execute on function public.pull_ticket(text, text, text, text, boolean) to anon;
grant execute on function public.recall_current(text, text, text) to anon;
grant execute on function public.record_phone_verified_event() to anon;
grant execute on function public.report_customer_arrived(uuid) to anon;
grant execute on function public.report_customer_delay(uuid) to anon;
grant execute on function public.schedule_appointment(text, text, text, text, date, text) to anon;
grant execute on function public.set_counter_paused(text, text, text, boolean) to anon;
grant execute on function public.set_counter_services(text, text, text, text[]) to anon;
grant execute on function public.set_on_the_way(uuid) to anon;
grant execute on function public.set_whatsapp_notifications(boolean) to anon;
grant execute on function public.staff_display_name(uuid) to anon;
grant execute on function public.transfer_ticket(text, text, text, text) to anon;
grant execute on function public.validate_display_name(text, text) to anon;
grant execute on function public.waiting_ahead_count(uuid) to anon;
grant execute on function public.watch_branch_capacity(text, text, text) to anon;
grant execute on function public.whatsapp_notifications_status() to anon;

-- Repor EXECUTE para PUBLIC nas seis funções que o tinham (estado da pré-verificação).
grant execute on function public.clear_counter(text, text, text) to public;
grant execute on function public.write_audit_log(text, text, text, text, text, text, jsonb) to public;
grant execute on function public.director_pct_change(numeric, numeric) to public;
grant execute on function public.director_period_bounds(text) to public;
grant execute on function public.is_director_of(text) to public;
grant execute on function public.is_manager_of_branch(text, text) to public;
