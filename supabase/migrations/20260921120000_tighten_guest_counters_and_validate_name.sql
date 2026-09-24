-- Achados de uma varredura de segurança (2026-09-21):
--
-- 1. Least-privilege: a política `counters_select_guest` (adicionada em
--    20260908120000_guest_mode_and_favorites.sql) dava a QUALQUER
--    utilizador anónimo leitura de `counters` -- e, através da view
--    `counters_with_agent`, do nome do agente e do ticket em atendimento
--    de todos os balcões, de todas as filiais. Isto é MAIS do que um
--    cliente autenticado pode ver (esse ficou restrito, em
--    20260906220000, a ser staff da filial ou ter senha activa nesse
--    balcão). Confirmado que nenhum fluxo de convidado lê `counters`
--    directamente -- o convidado usa `branch_queue_summary` (agregado)
--    e lê institutions/branches; quem lê `counters` (getCounterLabel/
--    subscribeCounterStatus no cliente) fá-lo sempre autenticado e com
--    senha activa na filial, já coberto pela política `authenticated`.
--    Remove-se a política anónima, sem partir o modo convidado.
drop policy if exists counters_select_guest on counters;

-- 2. Sanitização: `owner_create_institution`/`owner_update_institution`
--    validavam/normalizavam o ID (slug) mas aceitavam qualquer texto no
--    NOME -- incluindo `<script>...</script>`. React e Flutter escapam
--    por omissão (nunca chega a executar), mas não há razão para deixar
--    entrar lixo no catálogo público que os clientes navegam. Valida-se
--    no servidor: nome não vazio depois de trim, comprimento razoável, e
--    sem os caracteres de marcação `< >` (nunca legítimos num nome de
--    instituição). Aplicado às duas RPCs que escrevem o nome.

create or replace function public.validate_display_name(p_name text, p_label text default 'nome')
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_name text;
begin
  v_name := trim(coalesce(p_name, ''));
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception '% inválido -- deve ter entre 2 e 120 caracteres', p_label;
  end if;
  if v_name ~ '[<>]' then
    raise exception '% inválido -- não pode conter os caracteres < ou >', p_label;
  end if;
  return v_name;
end;
$$;

revoke all on function public.validate_display_name(text, text) from public;
grant execute on function public.validate_display_name(text, text) to authenticated;

-- Reescreve owner_create_institution (assinatura de 5 args, a única em
-- uso -- ver 20260912150000) a validar o nome antes de gravar.
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
  v_name text;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode criar instituições';
  end if;

  v_id := normalize_and_validate_slug_id(p_id, 'identificador da instituição');
  v_name := validate_display_name(p_name, 'nome da instituição');
  insert into institutions (id, name) values (v_id, v_name);
  insert into institution_billing (institution_id, nif, type, price_per_counter_kz)
  values (v_id, p_nif, p_type, coalesce(p_price_per_counter_kz, 0));

  perform write_audit_log('owner_create_institution', 'institution', v_id, v_id, null, 'success',
    jsonb_build_object('name', v_name, 'nif', p_nif, 'type', p_type));
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
declare
  v_name text;
begin
  if not is_owner() then
    raise exception 'só o dono da plataforma pode editar instituições';
  end if;

  v_name := validate_display_name(p_name, 'nome da instituição');
  update institutions set name = v_name where id = p_id;
  if not found then
    raise exception 'instituição não encontrada';
  end if;

  update institution_billing
     set nif = p_nif, type = p_type, price_per_counter_kz = p_price_per_counter_kz, billing_status = p_billing_status
   where institution_id = p_id;

  perform write_audit_log('owner_update_institution', 'institution', p_id, p_id, null, 'success',
    jsonb_build_object('name', v_name, 'billing_status', p_billing_status));
end;
$$;
