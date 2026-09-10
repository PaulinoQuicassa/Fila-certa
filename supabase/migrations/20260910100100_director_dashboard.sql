-- Painel de Inteligência da Direcção Geral -- KPIs, tendência e
-- benchmarking são cálculos reais sobre tickets/ratings. Os "alertas
-- automáticos" são regras simples sobre dados reais (limiares fixos,
-- comentados abaixo) -- NÃO é um motor de previsão/IA, é heurística
-- explícita, por decisão deliberada (ver conversa).

-- ---------------------------------------------------------------------
-- staff.branch_id passa a poder ser nulo -- um director não pertence a
-- uma filial específica, vê a instituição toda. Continua obrigatório
-- para agente/gestor.
-- ---------------------------------------------------------------------

alter table staff alter column branch_id drop not null;
alter table staff add constraint staff_branch_required_unless_director
  check (role = 'director' or branch_id is not null);

-- ---------------------------------------------------------------------
-- Helper: é director DESTA instituição.
-- ---------------------------------------------------------------------

create or replace function public.is_director_of(p_institution_id text)
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
      and staff.role = 'director'
  );
$$;

-- ---------------------------------------------------------------------
-- Fronteiras de período partilhadas pelas 4 RPCs abaixo -- período
-- actual e o período imediatamente anterior, com a mesma duração, para
-- calcular tendências.
-- ---------------------------------------------------------------------

create or replace function public.director_period_bounds(p_period text)
returns table (period_start timestamptz, period_end timestamptz, prev_start timestamptz, prev_end timestamptz, bucket text)
language sql
immutable
set search_path = public
as $$
  select
    case p_period
      when 'hoje' then date_trunc('day', now())
      when '30d' then now() - interval '30 days'
      else now() - interval '7 days'
    end,
    now(),
    case p_period
      when 'hoje' then date_trunc('day', now()) - interval '1 day'
      when '30d' then now() - interval '60 days'
      else now() - interval '14 days'
    end,
    case p_period
      when 'hoje' then date_trunc('day', now())
      when '30d' then now() - interval '30 days'
      else now() - interval '7 days'
    end,
    case p_period
      when 'hoje' then 'hour'
      when '30d' then 'week'
      else 'day'
    end;
$$;

-- Variação percentual entre dois valores, tolerante a null/zero (usada
-- para as 4 tendências do KPI row).
create or replace function public.director_pct_change(p_current numeric, p_previous numeric)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_previous is null or p_current is null or p_previous = 0 then null
    else round(100.0 * (p_current - p_previous) / p_previous, 1)
  end;
$$;

-- ---------------------------------------------------------------------
-- director_kpis -- os 4 cartões do topo, com tendência vs período anterior.
-- ---------------------------------------------------------------------

create or replace function public.director_kpis(p_institution_id text, p_period text)
returns table (
  avg_wait_minutes numeric, avg_wait_trend_pct numeric,
  avg_satisfaction numeric, avg_satisfaction_trend_pct numeric,
  abandonment_pct numeric, abandonment_trend_pct numeric,
  completed_count bigint, completed_trend_pct numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  b record;
  v_wait numeric; v_wait_prev numeric;
  v_sat numeric; v_sat_prev numeric;
  v_aband numeric; v_aband_prev numeric;
  v_done bigint; v_done_prev bigint;
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode ver este painel';
  end if;

  select * into b from director_period_bounds(p_period);

  select avg(extract(epoch from (called_at - created_at)) / 60) into v_wait
    from tickets
   where institution_id = p_institution_id and called_at is not null
     and created_at >= b.period_start and created_at < b.period_end;

  select avg(extract(epoch from (called_at - created_at)) / 60) into v_wait_prev
    from tickets
   where institution_id = p_institution_id and called_at is not null
     and created_at >= b.prev_start and created_at < b.prev_end;

  select avg(r.overall) into v_sat
    from ratings r
   where r.institution_id = p_institution_id
     and r.created_at >= b.period_start and r.created_at < b.period_end;

  select avg(r.overall) into v_sat_prev
    from ratings r
   where r.institution_id = p_institution_id
     and r.created_at >= b.prev_start and r.created_at < b.prev_end;

  select case when count(*) = 0 then null else 100.0 * count(*) filter (where status = 'no_show') / count(*) end into v_aband
    from tickets
   where institution_id = p_institution_id
     and created_at >= b.period_start and created_at < b.period_end;

  select case when count(*) = 0 then null else 100.0 * count(*) filter (where status = 'no_show') / count(*) end into v_aband_prev
    from tickets
   where institution_id = p_institution_id
     and created_at >= b.prev_start and created_at < b.prev_end;

  select count(*) into v_done
    from tickets
   where institution_id = p_institution_id and status = 'done'
     and created_at >= b.period_start and created_at < b.period_end;

  select count(*) into v_done_prev
    from tickets
   where institution_id = p_institution_id and status = 'done'
     and created_at >= b.prev_start and created_at < b.prev_end;

  return query select
    round(v_wait, 1), director_pct_change(v_wait, v_wait_prev),
    round(v_sat, 2), director_pct_change(v_sat, v_sat_prev),
    round(v_aband, 1), director_pct_change(v_aband, v_aband_prev),
    coalesce(v_done, 0), director_pct_change(v_done, v_done_prev);
end;
$$;

-- ---------------------------------------------------------------------
-- director_trend -- pontos do gráfico (hora/dia/semana consoante o
-- período), tempo médio de espera real por balde de tempo.
-- ---------------------------------------------------------------------

create or replace function public.director_trend(p_institution_id text, p_period text)
returns table (bucket_label text, avg_wait_minutes numeric)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  b record;
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode ver este painel';
  end if;

  select * into b from director_period_bounds(p_period);

  return query
    select
      to_char(date_trunc(b.bucket, t.created_at),
        case b.bucket when 'hour' then 'HH24:00' when 'week' then '"Sem" IW' else 'DD/MM' end),
      round(avg(extract(epoch from (t.called_at - t.created_at)) / 60), 1)
    from tickets t
   where t.institution_id = p_institution_id
     and t.called_at is not null
     and t.created_at >= b.period_start and t.created_at < b.period_end
   group by date_trunc(b.bucket, t.created_at)
   order by date_trunc(b.bucket, t.created_at);
end;
$$;

-- ---------------------------------------------------------------------
-- director_benchmarking -- uma linha por filial, com um score composto
-- simples (heurística, não um modelo validado): 34% tempo de espera +
-- 33% satisfação + 33% (inverso do) abandono.
-- ---------------------------------------------------------------------

create or replace function public.director_benchmarking(p_institution_id text, p_period text)
returns table (branch_id text, branch_name text, avg_wait_minutes numeric, avg_satisfaction numeric, abandonment_pct numeric, score numeric)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  b record;
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode ver este painel';
  end if;

  select * into b from director_period_bounds(p_period);

  return query
    with ticket_stats as (
      select
        t.branch_id,
        avg(extract(epoch from (t.called_at - t.created_at)) / 60) filter (where t.called_at is not null) as avg_wait,
        count(*) as total,
        count(*) filter (where t.status = 'no_show') as no_show_count
      from tickets t
      where t.institution_id = p_institution_id
        and t.created_at >= b.period_start and t.created_at < b.period_end
      group by t.branch_id
    ),
    rating_stats as (
      select r.branch_id, avg(r.overall) as avg_satisfaction
      from ratings r
      where r.institution_id = p_institution_id
        and r.created_at >= b.period_start and r.created_at < b.period_end
      group by r.branch_id
    )
    select
      br.id,
      br.name,
      round(ts.avg_wait, 1),
      round(rs.avg_satisfaction, 2),
      round(case when coalesce(ts.total, 0) = 0 then 0 else 100.0 * ts.no_show_count / ts.total end, 1),
      round(
        greatest(0, 100 - coalesce(ts.avg_wait, 0) * 3) * 0.34
        + coalesce(rs.avg_satisfaction, 0) / 5 * 100 * 0.33
        + greatest(0, 100 - (case when coalesce(ts.total, 0) = 0 then 0 else 100.0 * ts.no_show_count / ts.total end) * 4) * 0.33
      , 0)
    from branches br
    left join ticket_stats ts on ts.branch_id = br.id
    left join rating_stats rs on rs.branch_id = br.id
    where br.institution_id = p_institution_id
    order by 6 desc;
end;
$$;

-- ---------------------------------------------------------------------
-- director_alerts -- regras fixas sobre dados reais (não é IA/previsão):
--   1. tempo de espera subiu >20% vs período anterior -> crítico
--   2. abandono acima de 15% -> atenção
--   3. tempo de espera desceu >20% vs período anterior -> info (boa notícia)
-- Só considera filiais com pelo menos 5 senhas no período (amostra
-- mínima -- evita alertas ruidosos com 1-2 senhas).
-- ---------------------------------------------------------------------

create or replace function public.director_alerts(p_institution_id text, p_period text)
returns table (
  branch_id text, branch_name text, severity text, title text,
  causa text, previsao text, recomendacao text
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  b record;
  r record;
  v_min_sample constant int := 5;
begin
  if not is_director_of(p_institution_id) then
    raise exception 'só a direcção geral desta instituição pode ver este painel';
  end if;

  select * into b from director_period_bounds(p_period);

  for r in
    with current_stats as (
      select t.branch_id, br.name as branch_name,
        avg(extract(epoch from (t.called_at - t.created_at)) / 60) filter (where t.called_at is not null) as avg_wait,
        count(*) as total,
        count(*) filter (where t.status = 'no_show') as no_show_count
      from tickets t
      join branches br on br.institution_id = t.institution_id and br.id = t.branch_id
      where t.institution_id = p_institution_id
        and t.created_at >= b.period_start and t.created_at < b.period_end
      group by t.branch_id, br.name
    ),
    previous_stats as (
      select t.branch_id,
        avg(extract(epoch from (t.called_at - t.created_at)) / 60) filter (where t.called_at is not null) as avg_wait
      from tickets t
      where t.institution_id = p_institution_id
        and t.created_at >= b.prev_start and t.created_at < b.prev_end
      group by t.branch_id
    )
    select cs.branch_id, cs.branch_name, cs.avg_wait, cs.total, cs.no_show_count, ps.avg_wait as prev_avg_wait
    from current_stats cs
    left join previous_stats ps on ps.branch_id = cs.branch_id
    where cs.total >= v_min_sample
  loop
    if r.avg_wait is not null and r.prev_avg_wait is not null and r.prev_avg_wait > 0
       and r.avg_wait > r.prev_avg_wait * 1.2 then
      branch_id := r.branch_id; branch_name := r.branch_name; severity := 'critico';
      title := 'Tempo de espera subiu ' || round(100.0 * (r.avg_wait - r.prev_avg_wait) / r.prev_avg_wait) || '% em ' || r.branch_name;
      causa := 'Tempo médio de espera passou de ' || round(r.prev_avg_wait, 1) || ' para ' || round(r.avg_wait, 1) || ' minutos face ao período anterior.';
      previsao := 'Se a procura se mantiver, o tempo de espera pode continuar a subir.';
      recomendacao := 'Considerar abrir mais um balcão ou reforçar a equipa nesta filial.';
      return next;
    end if;

    if r.total > 0 and (100.0 * r.no_show_count / r.total) > 15 then
      branch_id := r.branch_id; branch_name := r.branch_name; severity := 'atencao';
      title := 'Abandono acima de 15% em ' || r.branch_name;
      causa := round(100.0 * r.no_show_count / r.total, 1) || '% das senhas não chegaram a ser concluídas neste período.';
      previsao := 'Sem intervenção, a taxa de abandono tende a manter-se ou agravar.';
      recomendacao := 'Rever o tempo médio de atendimento e a escala de colaboradores desta filial.';
      return next;
    end if;

    if r.avg_wait is not null and r.prev_avg_wait is not null and r.prev_avg_wait > 0
       and r.avg_wait < r.prev_avg_wait * 0.8 then
      branch_id := r.branch_id; branch_name := r.branch_name; severity := 'info';
      title := 'Melhoria no tempo de espera em ' || r.branch_name;
      causa := 'Tempo médio de espera desceu de ' || round(r.prev_avg_wait, 1) || ' para ' || round(r.avg_wait, 1) || ' minutos.';
      previsao := 'Tendência positiva -- vale a pena perceber o que mudou.';
      recomendacao := 'Documentar o que foi feito nesta filial para replicar nas restantes.';
      return next;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

revoke execute on function public.director_kpis(text, text) from public;
grant execute on function public.director_kpis(text, text) to authenticated;

revoke execute on function public.director_trend(text, text) from public;
grant execute on function public.director_trend(text, text) to authenticated;

revoke execute on function public.director_benchmarking(text, text) from public;
grant execute on function public.director_benchmarking(text, text) to authenticated;

revoke execute on function public.director_alerts(text, text) from public;
grant execute on function public.director_alerts(text, text) to authenticated;
