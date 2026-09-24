-- queue_capacity_preview comparava "agora" (now()::time, sessão do
-- Postgres corre em UTC -- confirmado via `show timezone`) directamente
-- contra opening_time/closing_time, que um director preenche a pensar em
-- hora de Angola (WAT, UTC+1, sem horário de Verão). Sem esta correcção,
-- o corte de capacidade ficaria sistematicamente 1h errado (fecho
-- "17:00" avaliado como se já fosse 17:00 UTC = 18:00 em Angola).
-- Descoberto ao preparar a primeira configuração real de uma filial.

create or replace function public.queue_capacity_preview(
  p_institution_id text, p_branch_id text, p_service text default null
)
returns table(
  state text,
  queue_position integer,
  eta_minutes integer,
  active_counters integer,
  avg_service_minutes numeric,
  remaining_by_volume integer,
  remaining_by_time integer,
  projected_finish timestamptz,
  gate_enabled boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  b branches%rowtype;
  v_active_counters integer;
  v_avg_service_minutes numeric;
  v_position integer;
  v_eta_minutes numeric;
  v_done_today integer;
  v_remaining_by_volume integer;
  v_remaining_by_time integer;
  v_operational_limit integer;
  v_minutes_now numeric;
  v_minutes_close numeric;
  v_minutes_until_red_cutoff numeric;
  v_minutes_until_yellow_cutoff numeric;
  v_state text;
begin
  select * into b from branches where institution_id = p_institution_id and id = p_branch_id;
  if not found then
    raise exception 'filial não encontrada';
  end if;

  select count(*) + 1 into v_position
    from tickets
   where institution_id = p_institution_id and branch_id = p_branch_id and status = 'waiting';

  select count(*) into v_active_counters
    from counters
   where institution_id = p_institution_id and branch_id = p_branch_id
     and status in ('available', 'serving');

  select avg(extract(epoch from (done_at - called_at)) / 60) into v_avg_service_minutes
    from tickets
   where institution_id = p_institution_id and branch_id = p_branch_id
     and status = 'done' and done_at is not null and called_at is not null
     and created_at >= date_trunc('day', now());

  v_avg_service_minutes := greatest(coalesce(v_avg_service_minutes, b.avg_service_minutes), 1);

  if v_active_counters > 0 then
    v_eta_minutes := v_position::numeric / v_active_counters * v_avg_service_minutes;
  else
    v_eta_minutes := v_position * v_avg_service_minutes;
  end if;

  if not b.capacity_gate_enabled or b.opening_time is null or b.closing_time is null then
    return query select
      'green'::text, v_position, round(v_eta_minutes)::integer, v_active_counters,
      round(v_avg_service_minutes, 1), null::integer, null::integer,
      now() + (v_eta_minutes || ' minutes')::interval, false;
    return;
  end if;

  if b.daily_capacity is not null then
    select count(*) into v_done_today
      from tickets
     where institution_id = p_institution_id and branch_id = p_branch_id
       and status = 'done' and created_at >= date_trunc('day', now());
    v_remaining_by_volume := greatest(b.daily_capacity - v_done_today, 0);
  else
    v_remaining_by_volume := null;
  end if;

  -- "Agora" em hora de Angola (WAT, UTC+1), não na timezone da sessão do
  -- Postgres (UTC) -- ver nota no topo do ficheiro.
  v_minutes_now := extract(epoch from (now() at time zone 'Africa/Luanda')::time) / 60;
  v_minutes_close := extract(epoch from b.closing_time) / 60;
  v_minutes_until_red_cutoff := v_minutes_close - b.safety_margin_minutes - v_minutes_now;
  v_minutes_until_yellow_cutoff := v_minutes_close - (2 * b.safety_margin_minutes) - v_minutes_now;

  if v_active_counters > 0 then
    v_remaining_by_time := greatest(floor(greatest(v_minutes_until_red_cutoff, 0) / v_avg_service_minutes * v_active_counters)::integer, 0);
  else
    v_remaining_by_time := 0;
  end if;

  if v_remaining_by_volume is null then
    v_operational_limit := v_remaining_by_time;
  else
    v_operational_limit := least(v_remaining_by_volume, v_remaining_by_time);
  end if;

  if v_operational_limit <= 0 or v_eta_minutes > v_minutes_until_red_cutoff then
    v_state := 'red';
  elsif v_eta_minutes > v_minutes_until_yellow_cutoff then
    v_state := 'yellow';
  else
    v_state := 'green';
  end if;

  return query select
    v_state, v_position, round(v_eta_minutes)::integer, v_active_counters,
    round(v_avg_service_minutes, 1), v_remaining_by_volume, v_remaining_by_time,
    now() + (v_eta_minutes || ' minutes')::interval, true;
end;
$$;

revoke all on function public.queue_capacity_preview(text, text, text) from public;
grant execute on function public.queue_capacity_preview(text, text, text) to authenticated;
