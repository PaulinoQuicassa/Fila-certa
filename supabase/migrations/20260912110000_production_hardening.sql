-- Hardening de produção (2026-09-12) -- corrige 4 achados de uma
-- auditoria de segurança dedicada: condição de corrida em
-- owner_remove_owner (Alto), condição de corrida em pull_ticket
-- (Médio), bypass do quiosque por padrão de email (Médio), e ausência
-- de validação de formato nos IDs de instituição/filial/balcão
-- (Médio). Também remove is_staff_of() -- código morto desde o
-- hardening de branch-scoping, identificado como armadilha para uma
-- migração futura reintroduzir por engano a fuga cross-branch já
-- corrigida.

-- ---------------------------------------------------------------------
-- 1. owner_remove_owner -- atómico, e nunca a auto-remoção
-- ---------------------------------------------------------------------
-- Antes: "SELECT count(*) -> DELETE" em dois passos separados, sem
-- lock nenhum -- duas remoções quase simultâneas podiam ambas ler "há
-- 2 donos" antes de qualquer confirmar o DELETE, zerando a tabela
-- owners (e, como adicionar um dono também exige ser dono, ninguém
-- conseguiria recuperar pela app). Corrigido com um advisory lock
-- transaccional (liberta-se sozinho no fim, sucesso ou erro) que
-- serializa todas as chamadas a esta função. Também bloqueia agora a
-- auto-remoção directamente no RPC (antes só a UI da consola
-- impedia -- contornável via DevTools).
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
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Contas de quiosque -- mecanismo explícito em vez de padrão de email
-- ---------------------------------------------------------------------
-- Antes: `pull_ticket` isentava do limite "uma senha activa por
-- serviço" quem tivesse `email LIKE 'estacao@%'` -- qualquer cliente
-- que se auto-registasse com um email desse padrão ficava
-- automaticamente isento, podendo inundar a fila real de uma filial.
-- A isenção em si é legítima (a conta de quiosque acumula UMA senha
-- por cada pessoa que chega fisicamente sem app, precisa de várias
-- activas em simultâneo) -- o problema era decidir quem tem essa
-- isenção só por adivinhar o padrão do email.
create table if not exists kiosk_accounts (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  label       text,
  created_at  timestamptz not null default now()
);
alter table kiosk_accounts enable row level security;
-- Sem nenhuma policy: só as funções abaixo (security definer) leem/
-- escrevem -- mesmo padrão de audit_logs (sem insert/update/delete
-- directo do cliente).

-- Bootstrap: qualquer conta já existente que o mecanismo antigo
-- (padrão de email) já tratava como quiosque entra automaticamente
-- aqui, para não mudar o comportamento já em produção com esta
-- migração.
insert into kiosk_accounts (user_id, label)
select id, email from auth.users where email like 'estacao@%'
on conflict (user_id) do nothing;

create or replace function public.is_kiosk_account(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from kiosk_accounts where user_id = p_user_id);
$$;

revoke all on function public.is_kiosk_account(uuid) from public;
grant execute on function public.is_kiosk_account(uuid) to authenticated;

-- Gestão da lista -- só o dono da plataforma decide quem é quiosque,
-- nunca uma inferência automática a partir de dados que o próprio
-- cliente controla (como o email).
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
end;
$$;

revoke all on function public.owner_set_kiosk_account(uuid, boolean, text) from public;
grant execute on function public.owner_set_kiosk_account(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. pull_ticket -- usa o novo mecanismo de quiosque + fecha a
--    condição de corrida do "uma senha por serviço"
-- ---------------------------------------------------------------------
-- Antes: "SELECT EXISTS -> INSERT" em dois passos, sem nenhum lock --
-- dois pedidos concorrentes do mesmo cliente para o mesmo serviço
-- (duplo toque, dois separadores, retry de rede) podiam ambos passar
-- a verificação antes de qualquer inserir, criando duas senhas activas
-- simultâneas. Corrigido com um advisory lock transaccional scoped a
-- (cliente, instituição, filial, serviço) -- serializa só pedidos que
-- colidiriam mesmo, sem afectar pedidos de clientes/serviços
-- diferentes a correr ao mesmo tempo.
create or replace function public.pull_ticket(
  p_institution_id text, p_branch_id text, p_service text, p_channel text default 'app'
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

revoke execute on function public.pull_ticket(text, text, text, text) from public;
grant execute on function public.pull_ticket(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Validação de formato para IDs de instituição/filial/balcão
-- ---------------------------------------------------------------------
-- Antes: texto livre sem validação nenhuma, nem no cliente (consola do
-- dono) nem no servidor -- risco de IDs visualmente idênticos mas
-- tecnicamente diferentes (espaços invisíveis, homóglifos Unicode), ou
-- caracteres que quebrem suposições de outras apps (URLs, QR codes).
-- Validado aqui (servidor, nunca contornável) -- a validação do lado
-- do cliente em fila-certa-owner é só UX, esta é que é a garantia real.
create or replace function public.normalize_and_validate_slug_id(p_id text, p_label text default 'identificador')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  v_id := lower(trim(p_id));
  if v_id !~ '^[a-z0-9-]{2,40}$' then
    raise exception '% inválido -- só letras minúsculas, números e hífen, entre 2 e 40 caracteres (recebido: "%")', p_label, p_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.normalize_and_validate_slug_id(text, text) from public;
grant execute on function public.normalize_and_validate_slug_id(text, text) to authenticated;

create or replace function public.owner_create_institution(p_id text, p_name text)
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
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Limpeza -- is_staff_of() é código morto desde o hardening de
--    branch-scoping (least_privilege_hardening + close_known_rls_gaps,
--    2026-09-06/07): confirmado que nenhuma policy/RPC actual chama
--    esta versão (todas usam is_staff_of_branch, que também verifica a
--    filial). Mantê-la só corre o risco de uma migração futura a
--    reutilizar por engano e reintroduzir a fuga cross-branch já
--    corrigida.
-- ---------------------------------------------------------------------
drop function if exists public.is_staff_of(text);
