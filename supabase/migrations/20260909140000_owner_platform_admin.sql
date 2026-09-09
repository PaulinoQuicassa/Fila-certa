-- Consola do dono da plataforma (app nova e separada, "fila-certa-owner"):
-- gestão de instituições, filiais, balcões e atribuição de colaboradores
-- a um perfil/instituição/filial -- hoje isso só existia por scripts de
-- seed corridos manualmente. Um "dono" é um papel novo, acima de
-- agente/gestor, sem âmbito de filial (vê e gere tudo) -- por isso não
-- entra na tabela `staff` (que exige institution_id/branch_id), fica
-- numa tabela própria mínima (`owners`), tal como o resto do projecto já
-- separa staff de citizen.

-- ---------------------------------------------------------------------
-- owners -- lista mínima de contas com acesso total à plataforma.
-- ---------------------------------------------------------------------

create table owners (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table owners enable row level security;
create policy owners_select_self on owners for select to authenticated
  using (id = auth.uid());
-- sem policy de insert/update/delete: só via owner_add_owner/owner_remove_owner (RPC).

create or replace function public.is_owner()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from owners where owners.id = auth.uid());
$$;

-- Dono passa a ver também a auditoria completa (antes só quem era staff
-- dessa filial via is_staff_of_branch conseguia ler -- um dono não é
-- staff de nenhuma, ficaria sem conseguir ver nada).
drop policy if exists audit_logs_select on audit_logs;
create policy audit_logs_select on audit_logs for select to authenticated
  using (is_staff_of_branch(institution_id, branch_id) or is_owner());

-- ---------------------------------------------------------------------
-- Instituições
-- ---------------------------------------------------------------------

create or replace function public.owner_create_institution(p_id text, p_name text)
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
end;
$$;

create or replace function public.owner_delete_institution(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode remover instituições';
  end if;

  begin
    delete from institutions where id = p_id;
  exception when foreign_key_violation then
    raise exception 'não é possível remover: ainda há filiais e/ou colaboradores associados a esta instituição';
  end;

  if not found then
    raise exception 'instituição não encontrada';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Filiais
-- ---------------------------------------------------------------------

create or replace function public.owner_create_branch(p_institution_id text, p_id text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar filiais';
  end if;

  insert into branches (institution_id, id, name) values (p_institution_id, p_id, p_name);
end;
$$;

create or replace function public.owner_delete_branch(p_institution_id text, p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode remover filiais';
  end if;

  begin
    delete from branches where institution_id = p_institution_id and id = p_id;
  exception when foreign_key_violation then
    raise exception 'não é possível remover: esta filial ainda tem balcões, senhas ou outros dados associados';
  end;

  if not found then
    raise exception 'filial não encontrada';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Balcões
-- ---------------------------------------------------------------------

create or replace function public.owner_create_counter(p_institution_id text, p_branch_id text, p_id text, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar balcões';
  end if;

  insert into counters (institution_id, branch_id, id, label) values (p_institution_id, p_branch_id, p_id, p_label);
end;
$$;

create or replace function public.owner_delete_counter(p_institution_id text, p_branch_id text, p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode remover balcões';
  end if;

  -- liberta quem estivesse atribuído -- não faz sentido bloquear a
  -- remoção do balcão só por isso.
  update staff set counter_id = null
   where institution_id = p_institution_id and branch_id = p_branch_id and counter_id = p_id;

  begin
    delete from counters where institution_id = p_institution_id and branch_id = p_branch_id and id = p_id;
  exception when foreign_key_violation then
    raise exception 'não é possível remover: este balcão já tem senhas associadas no histórico';
  end;

  if not found then
    raise exception 'balcão não encontrado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Colaboradores (staff) -- a conta de login (auth.users) continua a ser
-- criada manualmente no Dashboard do Supabase (Authentication → Add
-- User); esta RPC só faz a parte de negócio: associar essa conta a uma
-- instituição/filial/perfil. list_branch_staff (Dashboard do gestor) só
-- lista UMA filial -- esta lista TODAS, só para o dono.
-- ---------------------------------------------------------------------

create or replace function public.owner_list_staff()
returns table (id uuid, email text, name text, role staff_role, institution_id text, branch_id text, counter_id text)
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
    select s.id, u.email, s.name, s.role, s.institution_id, s.branch_id, s.counter_id
    from staff s
    join auth.users u on u.id = s.id
    order by s.institution_id, s.branch_id, s.name;
end;
$$;

create or replace function public.owner_assign_staff(
  p_email text, p_name text, p_role staff_role, p_institution_id text, p_branch_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode atribuir colaboradores';
  end if;

  select id into v_user_id from auth.users where email = p_email;
  if v_user_id is null then
    raise exception 'não existe nenhuma conta com este email -- crie-a primeiro no Dashboard do Supabase (Authentication → Add User)';
  end if;

  insert into staff (id, name, role, institution_id, branch_id, counter_id)
  values (v_user_id, p_name, p_role, p_institution_id, p_branch_id, null)
  on conflict (id) do update
    set name = excluded.name,
        role = excluded.role,
        institution_id = excluded.institution_id,
        branch_id = excluded.branch_id,
        counter_id = null; -- mudou de filial/perfil -- o balcão antigo já não se aplica

  perform write_audit_log('owner_assign_staff', 'staff', v_user_id::text, p_institution_id, p_branch_id,
    'success', jsonb_build_object('email', p_email, 'role', p_role));
end;
$$;

create or replace function public.owner_remove_staff(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode remover colaboradores';
  end if;

  delete from staff where id = p_user_id;
  if not found then
    raise exception 'colaborador não encontrado';
  end if;

  perform write_audit_log('owner_remove_staff', 'staff', p_user_id::text, null, null, 'success', null);
end;
$$;

-- ---------------------------------------------------------------------
-- Donos -- o próprio dono gere quem mais tem este acesso. A conta
-- (auth.users) também é criada manualmente no Dashboard primeiro.
-- ---------------------------------------------------------------------

create or replace function public.owner_list_owners()
returns table (id uuid, email text, name text, created_at timestamptz)
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
    select o.id, u.email, o.name, o.created_at
    from owners o
    join auth.users u on u.id = o.id
    order by o.created_at;
end;
$$;

create or replace function public.owner_add_owner(p_email text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not is_owner() then
    raise exception 'só um dono existente pode adicionar outro dono';
  end if;

  select id into v_user_id from auth.users where email = p_email;
  if v_user_id is null then
    raise exception 'não existe nenhuma conta com este email -- crie-a primeiro no Dashboard do Supabase (Authentication → Add User)';
  end if;

  insert into owners (id, name) values (v_user_id, p_name)
  on conflict (id) do update set name = excluded.name;
end;
$$;

create or replace function public.owner_remove_owner(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só um dono pode remover outro dono';
  end if;

  if (select count(*) from owners) <= 1 then
    raise exception 'não é possível remover o último dono da plataforma';
  end if;

  delete from owners where id = p_user_id;
  if not found then
    raise exception 'dono não encontrado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants -- mesmo padrão de todo o resto do projecto: revoga de
-- public, concede só a authenticated. is_owner() fica com o grant por
-- omissão (como is_staff_of_branch/is_manager_of_branch), só devolve um
-- booleano sobre o próprio auth.uid().
-- ---------------------------------------------------------------------

revoke execute on function public.owner_create_institution(text, text) from public;
grant execute on function public.owner_create_institution(text, text) to authenticated;

revoke execute on function public.owner_delete_institution(text) from public;
grant execute on function public.owner_delete_institution(text) to authenticated;

revoke execute on function public.owner_create_branch(text, text, text) from public;
grant execute on function public.owner_create_branch(text, text, text) to authenticated;

revoke execute on function public.owner_delete_branch(text, text) from public;
grant execute on function public.owner_delete_branch(text, text) to authenticated;

revoke execute on function public.owner_create_counter(text, text, text, text) from public;
grant execute on function public.owner_create_counter(text, text, text, text) to authenticated;

revoke execute on function public.owner_delete_counter(text, text, text) from public;
grant execute on function public.owner_delete_counter(text, text, text) to authenticated;

revoke execute on function public.owner_list_staff() from public;
grant execute on function public.owner_list_staff() to authenticated;

revoke execute on function public.owner_assign_staff(text, text, staff_role, text, text) from public;
grant execute on function public.owner_assign_staff(text, text, staff_role, text, text) to authenticated;

revoke execute on function public.owner_remove_staff(uuid) from public;
grant execute on function public.owner_remove_staff(uuid) to authenticated;

revoke execute on function public.owner_list_owners() from public;
grant execute on function public.owner_list_owners() to authenticated;

revoke execute on function public.owner_add_owner(text, text) from public;
grant execute on function public.owner_add_owner(text, text) to authenticated;

revoke execute on function public.owner_remove_owner(uuid) from public;
grant execute on function public.owner_remove_owner(uuid) to authenticated;

revoke insert, update, delete, truncate on owners from anon, authenticated;
