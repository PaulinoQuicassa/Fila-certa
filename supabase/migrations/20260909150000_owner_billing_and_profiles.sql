-- Segunda parte da consola do dono: dados de facturação por instituição
-- (NIF, tipo, preço/balcão, estado activo/trial/suspensa, receita mensal
-- calculada) e perfis de acesso nomeados e configuráveis.
--
-- Nota importante sobre o âmbito dos "perfis de acesso": este projecto
-- já tem um modelo de autorização real e em produção, usado todos os
-- dias pelas outras duas apps (fila-certa-staff, projectogestaodefilas)
-- -- staff.role ('agent'/'manager') e a tabela owners. Substituir esse
-- modelo por permissões totalmente dinâmicas exigiria reescrever todas
-- as RPCs e RLS existentes (is_staff_of_branch, is_manager_of_branch,
-- call_next, etc.) e o código das duas apps que já depende delas -- um
-- projecto à parte, arriscado para sistemas já em uso real. Os "perfis"
-- desta migração são por isso uma camada real e persistida de
-- catalogação/organização (nome, âmbito, lista de permissões,
-- associação a pessoas concretas) -- não fake, fica tudo gravado e
-- editável -- mas a aplicação técnica de acesso continua a ser
-- staff.role/owners, exactamente como hoje.

-- ---------------------------------------------------------------------
-- Facturação por instituição -- tabela à parte (não colunas em
-- `institutions`) porque `institutions` tem SELECT aberto a qualquer
-- autenticado (inclui cidadãos na app do cliente); preço/NIF/estado são
-- dados comerciais sensíveis, só o dono deve conseguir lê-los.
-- ---------------------------------------------------------------------

create type institution_status as enum ('active', 'trial', 'suspended');

create table institution_billing (
  institution_id        text primary key references institutions(id) on delete cascade,
  nif                   text,
  type                  text,
  price_per_counter_kz  integer not null default 0,
  billing_status        institution_status not null default 'trial'
);

alter table institution_billing enable row level security;
create policy institution_billing_select on institution_billing for select to authenticated
  using (is_owner());
-- sem insert/update/delete directo: só via RPC owner_* abaixo.

-- Backfill -- as 6 instituições piloto já existentes (banco-exemplo,
-- bpc, bfa, bai, bci, siac) não têm linha de facturação nenhuma; sem
-- isto, owner_list_institutions_overview (INNER JOIN) fá-las-ia
-- desaparecer por completo da consola do dono.
insert into institution_billing (institution_id)
select id from institutions
on conflict (institution_id) do nothing;

-- ---------------------------------------------------------------------
-- Perfis de acesso -- catálogo nomeado, com âmbito e permissões livres
-- (lista de texto, sem verificação técnica -- ver nota no topo).
-- ---------------------------------------------------------------------

create type profile_scope as enum ('global', 'institution');

create table access_profiles (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  scope         profile_scope not null,
  permissions   text[] not null default '{}',
  created_at    timestamptz not null default now()
);

alter table access_profiles enable row level security;
create policy access_profiles_select on access_profiles for select to authenticated
  using (is_owner());

-- Rótulo opcional em quem já tem acesso real (staff/owners) -- não
-- substitui staff.role nem a pertença a `owners`, só documenta/organiza
-- qual perfil nomeado essa pessoa representa.
alter table staff add column if not exists access_profile_id uuid references access_profiles(id) on delete set null;
alter table owners add column if not exists access_profile_id uuid references access_profiles(id) on delete set null;

-- ---------------------------------------------------------------------
-- owner_create_institution -- agora cria também a linha de facturação
-- (substitui a versão da migração anterior, mesma assinatura mínima +
-- os novos campos).
-- ---------------------------------------------------------------------

-- Assinatura diferente da versão anterior (2 args) -- `create or replace`
-- não substitui, cria uma sobrecarga nova; a antiga tem de ser apagada
-- explicitamente para não deixar duas versões incoerentes (a antiga
-- nunca escreveria institution_billing).
drop function if exists public.owner_create_institution(text, text);

create or replace function public.owner_create_institution(
  p_id text, p_name text, p_nif text default null, p_type text default null, p_price_per_counter_kz integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar instituições';
  end if;

  insert into institutions (id, name) values (p_id, p_name);
  insert into institution_billing (institution_id, nif, type, price_per_counter_kz)
  values (p_id, p_nif, p_type, coalesce(p_price_per_counter_kz, 0));
end;
$$;

create or replace function public.owner_update_institution(
  p_id text, p_name text, p_nif text, p_type text, p_price_per_counter_kz integer, p_billing_status institution_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode editar instituições';
  end if;

  update institutions set name = p_name where id = p_id;
  if not found then
    raise exception 'instituição não encontrada';
  end if;

  update institution_billing
     set nif = p_nif, type = p_type, price_per_counter_kz = p_price_per_counter_kz, billing_status = p_billing_status
   where institution_id = p_id;
end;
$$;

-- ---------------------------------------------------------------------
-- owner_list_institutions_overview -- fonte de dados do separador
-- "Empresas": nome + facturação + contagens reais de filiais/balcões +
-- receita mensal calculada (balcões × preço, só quando o estado é
-- 'active' -- suspensas/trial não facturam).
-- ---------------------------------------------------------------------

create or replace function public.owner_list_institutions_overview()
returns table (
  id text, name text, nif text, type text,
  billing_status institution_status, price_per_counter_kz integer,
  branch_count bigint, counter_count bigint, mrr_kz bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode ver a visão geral das instituições';
  end if;

  return query
    select
      i.id, i.name, b.nif, b.type, b.billing_status, b.price_per_counter_kz,
      count(distinct br.id) as branch_count,
      count(distinct c.id) as counter_count,
      case when b.billing_status = 'active' then count(distinct c.id) * b.price_per_counter_kz else 0 end as mrr_kz
    from institutions i
    join institution_billing b on b.institution_id = i.id
    left join branches br on br.institution_id = i.id
    left join counters c on c.institution_id = i.id and c.branch_id = br.id
    group by i.id, i.name, b.nif, b.type, b.billing_status, b.price_per_counter_kz
    order by i.name;
end;
$$;

-- ---------------------------------------------------------------------
-- Perfis de acesso -- CRUD + roster (para a contagem de "utilizadores").
-- ---------------------------------------------------------------------

create or replace function public.owner_list_access_profiles()
returns table (id uuid, name text, scope profile_scope, permissions text[], user_count bigint)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode ver os perfis de acesso';
  end if;

  return query
    select
      p.id, p.name, p.scope, p.permissions,
      (select count(*) from staff s where s.access_profile_id = p.id)
        + (select count(*) from owners o where o.access_profile_id = p.id) as user_count
    from access_profiles p
    order by p.created_at;
end;
$$;

create or replace function public.owner_create_access_profile(p_name text, p_scope profile_scope, p_permissions text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar perfis de acesso';
  end if;

  insert into access_profiles (name, scope, permissions) values (p_name, p_scope, coalesce(p_permissions, '{}'));
end;
$$;

create or replace function public.owner_delete_access_profile(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode remover perfis de acesso';
  end if;

  delete from access_profiles where id = p_id;
  if not found then
    raise exception 'perfil não encontrado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Associar o rótulo de perfil a quem já tem acesso real.
-- ---------------------------------------------------------------------

create or replace function public.owner_set_staff_profile(p_user_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode alterar o perfil de um colaborador';
  end if;

  update staff set access_profile_id = p_profile_id where id = p_user_id;
  if not found then
    raise exception 'colaborador não encontrado';
  end if;
end;
$$;

create or replace function public.owner_set_owner_profile(p_user_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode alterar o perfil de um dono';
  end if;

  update owners set access_profile_id = p_profile_id where id = p_user_id;
  if not found then
    raise exception 'dono não encontrado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- owner_list_staff / owner_list_owners -- passam a incluir o perfil.
-- ---------------------------------------------------------------------

-- Ganham colunas novas no resultado -- `create or replace` não permite
-- mudar o tipo de retorno de uma função existente, tem de se apagar
-- primeiro.
drop function if exists public.owner_list_staff();
drop function if exists public.owner_list_owners();

create or replace function public.owner_list_staff()
returns table (
  id uuid, email text, name text, role staff_role, institution_id text, branch_id text, counter_id text,
  access_profile_id uuid, access_profile_name text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode ver a lista completa de colaboradores';
  end if;

  return query
    select s.id, u.email, s.name, s.role, s.institution_id, s.branch_id, s.counter_id,
           s.access_profile_id, p.name
    from staff s
    join auth.users u on u.id = s.id
    left join access_profiles p on p.id = s.access_profile_id
    order by s.institution_id, s.branch_id, s.name;
end;
$$;

create or replace function public.owner_list_owners()
returns table (id uuid, email text, name text, created_at timestamptz, access_profile_id uuid, access_profile_name text)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só um dono pode ver a lista de donos';
  end if;

  return query
    select o.id, u.email, o.name, o.created_at, o.access_profile_id, p.name
    from owners o
    join auth.users u on u.id = o.id
    left join access_profiles p on p.id = o.access_profile_id
    order by o.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

revoke execute on function public.owner_create_institution(text, text, text, text, integer) from public;
grant execute on function public.owner_create_institution(text, text, text, text, integer) to authenticated;

revoke execute on function public.owner_update_institution(text, text, text, text, integer, institution_status) from public;
grant execute on function public.owner_update_institution(text, text, text, text, integer, institution_status) to authenticated;

revoke execute on function public.owner_list_institutions_overview() from public;
grant execute on function public.owner_list_institutions_overview() to authenticated;

revoke execute on function public.owner_list_access_profiles() from public;
grant execute on function public.owner_list_access_profiles() to authenticated;

revoke execute on function public.owner_create_access_profile(text, profile_scope, text[]) from public;
grant execute on function public.owner_create_access_profile(text, profile_scope, text[]) to authenticated;

revoke execute on function public.owner_delete_access_profile(uuid) from public;
grant execute on function public.owner_delete_access_profile(uuid) to authenticated;

revoke execute on function public.owner_set_staff_profile(uuid, uuid) from public;
grant execute on function public.owner_set_staff_profile(uuid, uuid) to authenticated;

revoke execute on function public.owner_set_owner_profile(uuid, uuid) from public;
grant execute on function public.owner_set_owner_profile(uuid, uuid) to authenticated;

revoke execute on function public.owner_list_staff() from public;
grant execute on function public.owner_list_staff() to authenticated;

revoke execute on function public.owner_list_owners() from public;
grant execute on function public.owner_list_owners() to authenticated;

revoke insert, update, delete, truncate on institution_billing, access_profiles from anon, authenticated;
