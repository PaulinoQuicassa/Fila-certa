-- Fase 4/17 do hardening final: cobertura de audit log para operações
-- privilegiadas do dono da plataforma. Antes desta migração, só
-- owner_assign_staff/owner_remove_staff escreviam em audit_logs --
-- criar/remover instituições, filiais, balcões, PERFIS DE ACESSO e,
-- mais grave, CRIAR/REMOVER OUTRO DONO (owner_add_owner/
-- owner_remove_owner) não deixavam nenhum rasto. Corrigido para todas
-- as RPCs owner_* que alteram estado.
--
-- ---------------------------------------------------------------------
-- Correcção real encontrada nesta revisão: owner_create_institution
-- ficou com DOIS overloads coexistentes -- a validação de slug/trim
-- adicionada em 20260912110000_production_hardening.sql foi escrita
-- para a assinatura antiga (p_id text, p_name text), mas
-- 20260909150000_owner_billing_and_profiles.sql já tinha substituído
-- essa função pela versão de 5 argumentos (com nif/type/preço) --
-- create or replace de uma assinatura DIFERENTE cria um overload novo
-- em vez de substituir. A consola do dono chama sempre com os 5
-- argumentos nomeados (ver fila-certa-owner/src/lib/admin.ts), por
-- isso a validação nunca chegou a correr de facto -- o overload de 2
-- argumentos ficava morto, nunca chamado. Corrigido aqui: apagado o
-- overload morto, validação movida para a assinatura realmente usada.
-- ---------------------------------------------------------------------
drop function if exists public.owner_create_institution(text, text);

create or replace function public.owner_create_institution(
  p_id text, p_name text, p_nif text default null, p_type text default null, p_price_per_counter_kz integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar instituições';
  end if;

  v_id := normalize_and_validate_slug_id(p_id, 'identificador da instituição');
  insert into institutions (id, name) values (v_id, trim(p_name));
  insert into institution_billing (institution_id, nif, type, price_per_counter_kz)
  values (v_id, p_nif, p_type, coalesce(p_price_per_counter_kz, 0));

  perform write_audit_log('owner_create_institution', 'institution', v_id, v_id, null, 'success',
    jsonb_build_object('name', trim(p_name), 'nif', p_nif, 'type', p_type));
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

  perform write_audit_log('owner_delete_institution', 'institution', p_id, p_id, null, 'success', null);
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

  perform write_audit_log('owner_update_institution', 'institution', p_id, p_id, null, 'success',
    jsonb_build_object('name', p_name, 'billing_status', p_billing_status));
end;
$$;

create or replace function public.owner_create_branch(p_institution_id text, p_id text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar filiais';
  end if;

  v_id := normalize_and_validate_slug_id(p_id, 'identificador da filial');
  insert into branches (institution_id, id, name) values (p_institution_id, v_id, trim(p_name));

  perform write_audit_log('owner_create_branch', 'branch', v_id, p_institution_id, v_id, 'success',
    jsonb_build_object('name', trim(p_name)));
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

  perform write_audit_log('owner_delete_branch', 'branch', p_id, p_institution_id, p_id, 'success', null);
end;
$$;

create or replace function public.owner_create_counter(p_institution_id text, p_branch_id text, p_id text, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar balcões';
  end if;

  v_id := normalize_and_validate_slug_id(p_id, 'identificador do balcão');
  insert into counters (institution_id, branch_id, id, label) values (p_institution_id, p_branch_id, v_id, trim(p_label));

  perform write_audit_log('owner_create_counter', 'counter', v_id, p_institution_id, p_branch_id, 'success',
    jsonb_build_object('label', trim(p_label)));
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

  perform write_audit_log('owner_delete_counter', 'counter', p_id, p_institution_id, p_branch_id, 'success', null);
end;
$$;

-- ---------------------------------------------------------------------
-- Donos -- a operação mais sensível de todas (dá acesso total à
-- plataforma); é precisamente a que não tinha nenhum registo.
-- ---------------------------------------------------------------------

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

  perform write_audit_log('owner_add_owner', 'owner', v_user_id::text, null, null, 'success',
    jsonb_build_object('email', p_email, 'name', p_name));
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

  if p_user_id = auth.uid() then
    raise exception 'não pode remover o seu próprio acesso de dono -- peça a outro dono para o fazer';
  end if;

  perform pg_advisory_xact_lock(hashtext('owner_remove_owner'));

  if (select count(*) from owners) <= 1 then
    raise exception 'não é possível remover o último dono da plataforma';
  end if;

  delete from owners where id = p_user_id;
  if not found then
    raise exception 'dono não encontrado';
  end if;

  perform write_audit_log('owner_remove_owner', 'owner', p_user_id::text, null, null, 'success', null);
end;
$$;

-- ---------------------------------------------------------------------
-- Contas de quiosque -- isenção de "uma senha por serviço" (ver
-- 20260912110000_production_hardening.sql); também sem registo até agora.
-- ---------------------------------------------------------------------

create or replace function public.owner_set_kiosk_account(p_user_id uuid, p_is_kiosk boolean, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode gerir contas de quiosque';
  end if;

  if p_is_kiosk then
    insert into kiosk_accounts (user_id, label) values (p_user_id, p_label)
    on conflict (user_id) do update set label = coalesce(excluded.label, kiosk_accounts.label);
  else
    delete from kiosk_accounts where user_id = p_user_id;
  end if;

  perform write_audit_log('owner_set_kiosk_account', 'auth_user', p_user_id::text, null, null, 'success',
    jsonb_build_object('is_kiosk', p_is_kiosk, 'label', p_label));
end;
$$;

-- ---------------------------------------------------------------------
-- Perfis de acesso.
-- ---------------------------------------------------------------------

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

  perform write_audit_log('owner_create_access_profile', 'access_profile', p_name, null, null, 'success',
    jsonb_build_object('scope', p_scope, 'permissions', p_permissions));
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

  perform write_audit_log('owner_delete_access_profile', 'access_profile', p_id::text, null, null, 'success', null);
end;
$$;

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

  perform write_audit_log('owner_set_staff_profile', 'staff', p_user_id::text, null, null, 'success',
    jsonb_build_object('access_profile_id', p_profile_id));
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

  perform write_audit_log('owner_set_owner_profile', 'owner', p_user_id::text, null, null, 'success',
    jsonb_build_object('access_profile_id', p_profile_id));
end;
$$;
