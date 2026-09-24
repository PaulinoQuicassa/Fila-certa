-- Capacidade Inteligente da Fila (plano aprovado 2026-09-24).
--
-- Hoje a Fila Certa só responde "qual é a minha posição/ETA" -- nunca
-- "ainda vou ser atendido hoje". Isto acrescenta essa camada: capacidade
-- operacional estimada por filial (por tempo até ao fecho E por volume
-- diário configurado, o mais restritivo dos dois vence), com 3 estados
-- (green/yellow/red) calculados sempre ao vivo (nunca cache), e aplicados
-- a sério em pull_ticket (não só sugeridos na UI -- um cliente a chamar a
-- API directamente não consegue saltar o vermelho).
--
-- Desenho completo (regras de negócio, casos extremos considerados) no
-- plano: C:\Users\Paulino Quicassa\.claude\plans\splendid-forging-gizmo.md

-- ---------------------------------------------------------------------
-- 1. Configuração operacional por filial. Tudo com omissão que preserva
--    o comportamento actual: capacity_gate_enabled = false em todas as
--    filiais existentes -- nada muda até um director configurar e
--    activar esta filial explicitamente.
-- ---------------------------------------------------------------------

alter table branches add column if not exists opening_time time;
alter table branches add column if not exists closing_time time;
alter table branches add column if not exists safety_margin_minutes integer not null default 15;
alter table branches add column if not exists daily_capacity integer;
alter table branches add column if not exists avg_service_minutes integer not null default 10;
alter table branches add column if not exists capacity_gate_enabled boolean not null default false;

alter table branches add constraint branches_safety_margin_non_negative check (safety_margin_minutes >= 0);
alter table branches add constraint branches_avg_service_minutes_positive check (avg_service_minutes > 0);
alter table branches add constraint branches_daily_capacity_non_negative check (daily_capacity is null or daily_capacity >= 0);

-- Preparação para diferenciação por serviço (não usado no cálculo ainda
-- -- queue_capacity_preview cai sempre no tempo médio observado/da filial
-- -- mas o catálogo fica pronto para essa evolução sem migração extra).
alter table services add column if not exists avg_duration_minutes integer;
alter table services add constraint services_avg_duration_positive check (avg_duration_minutes is null or avg_duration_minutes > 0);

-- ---------------------------------------------------------------------
-- 2. "Avisar-me quando abrir" -- opt-in do cliente quando a filial está
--    em red. Entrega em v1 é in-app/foreground (o cliente com o ecrã
--    aberto faz poll a queue_capacity_preview, como já se faz com
--    ETA/posição); esta tabela fica pronta para push real quando essa
--    infraestrutura existir (hoje não existe -- confirmado, sem
--    firebase_messaging/equivalente na app do cliente).
-- ---------------------------------------------------------------------

create table capacity_watchers (
  id uuid primary key default gen_random_uuid(),
  institution_id text not null,
  branch_id text not null,
  customer_id uuid not null references auth.users(id) on delete cascade,
  service text,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  foreign key (institution_id, branch_id) references branches (institution_id, id) on delete cascade
);

create index capacity_watchers_lookup on capacity_watchers (institution_id, branch_id) where notified_at is null;

alter table capacity_watchers enable row level security;

create policy capacity_watchers_select_own on capacity_watchers
  for select using (customer_id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. queue_capacity_preview -- o cálculo central. stable, sem escrita,
--    reutilizado em 3 sítios: painel do cliente antes de entrar,
--    internamente por pull_ticket (mesma transacção, evita TOCTOU entre
--    o preview e o insert), e por director_capacity_kpis (painel do
--    estabelecimento, uma linha por filial).
-- ---------------------------------------------------------------------

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

  -- Tempo médio de atendimento (called_at -> done_at, não é o mesmo que
  -- branch_wait_stats, que mede tempo de ESPERA created_at -> called_at).
  -- Dados de hoje têm sempre prioridade sobre a configuração; a
  -- configuração só serve de regra conservadora quando ainda não há
  -- amostra (secção 18 do pedido).
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

  -- Gate desligada, ou filial ainda sem horário configurado: nunca
  -- bloquear por falta de configuração -- regra conservadora explícita.
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

  -- Minutos-desde-a-meia-noite em vez de timestamptz, para não entrar em
  -- aritmética de fuso horário desnecessária -- suficiente para filiais
  -- que fecham no mesmo dia em que abrem (o caso comum; fecho depois da
  -- meia-noite fica fora de âmbito nesta primeira versão). A sessão do
  -- Postgres corre em UTC (confirmado -- `show timezone`), mas
  -- opening_time/closing_time são preenchidos pelo director a pensar em
  -- hora de Angola (WAT, UTC+1, sem horário de Verão) -- por isso "agora"
  -- tem de ser explicitamente convertido, senão o fecho ficaria 1h
  -- adiantado/atrasado consoante a hora do dia.
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

-- ---------------------------------------------------------------------
-- 4. director_capacity_kpis -- painel do estabelecimento (secção 12 do
--    pedido), uma linha por filial da instituição. Reaproveita
--    queue_capacity_preview via lateral join, sem duplicar a lógica.
-- ---------------------------------------------------------------------

create or replace function public.director_capacity_kpis(p_institution_id text)
returns table(
  branch_id text, branch_name text, state text, queue_position integer, eta_minutes integer,
  active_counters integer, avg_service_minutes numeric, remaining_by_volume integer,
  remaining_by_time integer, gate_enabled boolean, daily_capacity integer, done_today integer,
  opening_time time, closing_time time, safety_margin_minutes integer
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode ver este painel';
  end if;

  return query
    select
      br.id, br.name, p.state, p.queue_position, p.eta_minutes, p.active_counters,
      p.avg_service_minutes, p.remaining_by_volume, p.remaining_by_time, p.gate_enabled,
      br.daily_capacity,
      (select count(*)::integer from tickets t
        where t.institution_id = br.institution_id and t.branch_id = br.id
          and t.status = 'done' and t.created_at >= date_trunc('day', now())),
      br.opening_time, br.closing_time, br.safety_margin_minutes
    from branches br
    cross join lateral queue_capacity_preview(br.institution_id, br.id) p
    where br.institution_id = p_institution_id
    order by br.name;
end;
$$;

revoke all on function public.director_capacity_kpis(text) from public;
grant execute on function public.director_capacity_kpis(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. director_update_branch_capacity -- configuração (secção 13 do
--    pedido). Só o director da instituição; audita como as restantes
--    RPCs de escrita.
-- ---------------------------------------------------------------------

create or replace function public.director_update_branch_capacity(
  p_institution_id text, p_branch_id text,
  p_opening_time time, p_closing_time time,
  p_safety_margin_minutes integer, p_daily_capacity integer,
  p_avg_service_minutes integer, p_capacity_gate_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode configurar a capacidade';
  end if;

  if p_safety_margin_minutes is null or p_safety_margin_minutes < 0 then
    raise exception 'margem de segurança inválida';
  end if;

  if p_avg_service_minutes is null or p_avg_service_minutes <= 0 then
    raise exception 'tempo médio de atendimento inválido';
  end if;

  if p_daily_capacity is not null and p_daily_capacity < 0 then
    raise exception 'capacidade diária inválida';
  end if;

  if p_capacity_gate_enabled and (p_opening_time is null or p_closing_time is null) then
    raise exception 'defina o horário de abertura e de encerramento antes de activar a capacidade inteligente';
  end if;

  update branches
     set opening_time = p_opening_time,
         closing_time = p_closing_time,
         safety_margin_minutes = p_safety_margin_minutes,
         daily_capacity = p_daily_capacity,
         avg_service_minutes = p_avg_service_minutes,
         capacity_gate_enabled = p_capacity_gate_enabled
   where institution_id = p_institution_id and id = p_branch_id;

  if not found then
    raise exception 'filial não encontrada';
  end if;

  perform write_audit_log('director_update_branch_capacity', 'branch', p_branch_id, p_institution_id, p_branch_id,
    'success', jsonb_build_object(
      'opening_time', p_opening_time, 'closing_time', p_closing_time,
      'safety_margin_minutes', p_safety_margin_minutes, 'daily_capacity', p_daily_capacity,
      'avg_service_minutes', p_avg_service_minutes, 'capacity_gate_enabled', p_capacity_gate_enabled
    ));
end;
$$;

revoke all on function public.director_update_branch_capacity(text, text, time, time, integer, integer, integer, boolean) from public;
grant execute on function public.director_update_branch_capacity(text, text, time, time, integer, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 6. watch_branch_capacity -- "avisar-me quando abrir" (secção 4/15).
--    Idempotente por delete-then-insert (mais simples que um índice
--    único parcial com expressão, mesmo efeito).
-- ---------------------------------------------------------------------

create or replace function public.watch_branch_capacity(
  p_institution_id text, p_branch_id text, p_service text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem pedir para ser avisados';
  end if;

  delete from capacity_watchers
   where institution_id = p_institution_id and branch_id = p_branch_id
     and customer_id = auth.uid() and coalesce(service, '') = coalesce(p_service, '')
     and notified_at is null;

  insert into capacity_watchers (institution_id, branch_id, customer_id, service)
  values (p_institution_id, p_branch_id, auth.uid(), p_service);
end;
$$;

revoke all on function public.watch_branch_capacity(text, text, text) from public;
grant execute on function public.watch_branch_capacity(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. pull_ticket -- aplica a gate a sério (server-side, não só na UI).
--    A assinatura muda (novo p_acknowledged_risk) -- create or replace
--    NÃO substitui uma função quando a lista de tipos de parâmetros
--    muda, cria um overload novo (foi exactamente isto que causou o
--    incidente de produção desta sessão em pull_ticket). Por isso
--    elimina-se primeiro a versão de 4 argumentos, explicitamente.
-- ---------------------------------------------------------------------

drop function if exists public.pull_ticket(text, text, text, text);

create or replace function public.pull_ticket(
  p_institution_id text, p_branch_id text, p_service text, p_channel text default 'app',
  p_acknowledged_risk boolean default false
)
returns tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
  v_code text;
  v_ticket tickets;
  v_capacity record;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem tirar senha';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || '|' || p_institution_id || '|' || p_branch_id || '|' || p_service, 0));

  if not is_kiosk_account(auth.uid()) then
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

  select * into v_capacity from queue_capacity_preview(p_institution_id, p_branch_id, p_service);

  if v_capacity.gate_enabled then
    if v_capacity.state = 'red' then
      raise exception 'capacity_exhausted';
    elsif v_capacity.state = 'yellow' and not coalesce(p_acknowledged_risk, false) then
      raise exception 'capacity_risk_confirmation_required';
    end if;
  end if;

  insert into branch_counters (institution_id, branch_id, seq)
    values (p_institution_id, p_branch_id, 1)
  on conflict (institution_id, branch_id)
    do update set seq = branch_counters.seq + 1
  returning seq into v_seq;

  v_code := 'B' || lpad(v_seq::text, 3, '0');

  insert into tickets (institution_id, branch_id, code, service, status, customer_id, channel)
  values (p_institution_id, p_branch_id, v_code, p_service, 'waiting', auth.uid(), coalesce(p_channel, 'app'))
  returning * into v_ticket;

  perform write_audit_log('pull_ticket', 'ticket', v_ticket.id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('code', v_code, 'service', p_service, 'channel', coalesce(p_channel, 'app')));

  return v_ticket;
end;
$$;

revoke execute on function public.pull_ticket(text, text, text, text, boolean) from public;
grant execute on function public.pull_ticket(text, text, text, text, boolean) to authenticated;
