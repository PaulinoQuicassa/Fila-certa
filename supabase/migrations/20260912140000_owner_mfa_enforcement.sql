-- MFA obrigatório para donos da plataforma (Fase 6 do hardening).
--
-- Mecanismo real da Auth do Supabase (TOTP -- `auth.mfa.enroll`/
-- `challenge`/`verify` no cliente, ver fila-certa-owner), nunca um
-- segundo factor "local" inventado neste repositório.
--
-- `is_owner()` passa a exigir AAL2 (`auth.jwt()->>'aal' = 'aal2'`)
-- sempre que a conta TEM um factor TOTP verificado -- é assim que a
-- própria Supabase documenta obrigar MFA sem trancar fora quem ainda
-- não activou: uma conta sem nenhum factor verificado continua a
-- passar (v_has_mfa = false -> true), mas a partir do momento em que
-- activa um, aal2 torna-se obrigatório para SEMPRE nessa conta -- não
-- há forma de voltar a aal1 e continuar a usar is_owner(). O lado do
-- cliente (fila-certa-owner) torna a inscrição obrigatória na própria
-- UI (ecrã bloqueante logo a seguir ao login para quem ainda não
-- activou) -- ver docs/owner-mfa.md; isto aqui é a garantia real do
-- lado do servidor, que nenhuma alteração de UI consegue contornar.
create or replace function public.is_owner()
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_is_owner boolean;
  v_has_verified_mfa boolean;
begin
  select exists (select 1 from owners where owners.id = auth.uid()) into v_is_owner;
  if not v_is_owner then
    return false;
  end if;

  select exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) into v_has_verified_mfa;

  if v_has_verified_mfa then
    return coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
  end if;

  return true;
end;
$$;

-- Exposto ao cliente para a consola do dono saber, sem adivinhar,
-- exactamente porque é que uma acção foi recusada (sessão em aal1 numa
-- conta já inscrita) em vez de "não é dono" -- distinção que a UI
-- precisa para mostrar o ecrã certo (challenge de MFA vs. acesso
-- negado a sério).
create or replace function public.owner_mfa_status()
returns table (is_owner boolean, has_verified_factor boolean, current_aal text)
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (select 1 from owners where owners.id = auth.uid()),
    exists (select 1 from auth.mfa_factors where user_id = auth.uid() and status = 'verified'),
    coalesce((select auth.jwt() ->> 'aal'), 'aal1');
$$;

revoke all on function public.owner_mfa_status() from public;
grant execute on function public.owner_mfa_status() to authenticated;
