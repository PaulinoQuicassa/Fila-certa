-- Canal WhatsApp -- identidade (telefone -> conta real), estado de
-- conversa persistido, e log de deduplicação de mensagens da Meta.
--
-- Princípio (ver conversa): o webhook do WhatsApp NUNCA implementa
-- lógica de fila própria -- chama exactamente as mesmas RPCs que a app
-- e o site usam (pull_ticket, waiting_ahead_count, branch_wait_stats,
-- cancel_ticket, ...), com uma sessão gerada para a conta
-- (auth.users) ligada a esse telefone -- ver
-- supabase/functions/_shared/citizenSession.ts. Nenhuma tabela nova
-- aqui guarda posição, tempo estimado nem estado da senha -- isso
-- continua a ser calculado como sempre foi.
--
-- As 3 tabelas só são tocadas pelo service_role (dentro das Edge
-- Functions) -- RLS activa, sem nenhuma policy: nem cidadão nem equipa
-- lhes acedem directamente (nem precisam).

create table whatsapp_contacts (
  phone       text primary key, -- formato E.164, ex.: +244912345678
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now()
);
alter table whatsapp_contacts enable row level security;

create table whatsapp_conversation_state (
  phone       text primary key references whatsapp_contacts(phone) on delete cascade,
  state       text not null default 'WELCOME',
  context     jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table whatsapp_conversation_state enable row level security;

-- Chave primária = meta_message_id: a Meta reentrega webhooks (retries
-- de rede); inserir com ON CONFLICT DO NOTHING torna o reprocessamento
-- seguro (idempotência) -- ver Fase 15/19 da conversa.
create table whatsapp_message_log (
  meta_message_id  text primary key,
  phone            text not null,
  direction        text not null check (direction in ('inbound', 'outbound')),
  message_type     text,
  event            text, -- 'message_received' | 'institution_selected' | 'queue_joined' | ...
  ticket_id        uuid references tickets(id),
  created_at       timestamptz not null default now()
);
alter table whatsapp_message_log enable row level security;

create index whatsapp_message_log_phone_idx on whatsapp_message_log (phone, created_at desc);

-- ---------------------------------------------------------------------
-- tickets.channel -- só para reporting distinguir a origem da senha;
-- não é lido por nenhuma RPC existente, omissão preserva o
-- comportamento actual para todas as senhas já criadas.
-- ---------------------------------------------------------------------

alter table tickets add column if not exists channel text not null default 'app'
  check (channel in ('app', 'web', 'whatsapp'));

-- ---------------------------------------------------------------------
-- pull_ticket ganha p_channel (default 'app' -- chamadas existentes da
-- app/site continuam iguais, sem precisar de mudar nada). Assinatura
-- muda (novo parâmetro) -- `create or replace` sozinho criaria uma
-- sobrecarga nova em vez de substituir (mesma lição da migração
-- 20260909150000): apaga-se a versão de 3 args primeiro.
-- ---------------------------------------------------------------------

drop function if exists public.pull_ticket(text, text, text);

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
  v_email text;
begin
  if auth.uid() is null or is_anonymous_session() then
    raise exception 'apenas clientes autenticados (não anónimos) podem tirar senha';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  if v_email is null or v_email not like 'estacao@%' then
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

revoke insert, update, delete, truncate on whatsapp_contacts, whatsapp_conversation_state, whatsapp_message_log
  from anon, authenticated;

-- ---------------------------------------------------------------------
-- services -- catálogo de serviços por instituição. Não existia
-- nenhuma versão disto no Supabase -- estava *hardcoded* em duplicado
-- (lib/pilotInstitutions.ts no React, mock_data.dart no Flutter). O
-- fluxo "escolher serviço" do WhatsApp precisa de o ler de algum lado
-- que não seja uma TERCEIRA cópia -- ver secção 21 do pedido ("propor
-- refactorização antes de duplicar"). As duas apps existentes não são
-- alteradas por esta migração (continuam a funcionar com o catálogo
-- hardcoded que já tinham); só o canal novo lê daqui.
-- ---------------------------------------------------------------------

create table services (
  id              uuid primary key default gen_random_uuid(),
  institution_id  text not null references institutions(id) on delete cascade,
  name            text not null,
  created_at      timestamptz not null default now(),
  unique (institution_id, name)
);
create index services_institution_idx on services (institution_id);

alter table services enable row level security;
create policy services_select on services for select to authenticated, anon using (true);
-- sem insert/update/delete via RLS: só via migração/seed por agora.

-- `select ... where exists` em vez de `insert ... values`: no ambiente
-- efémero do CI, as instituições piloto só são criadas DEPOIS das
-- migrações correrem (scripts/seed-reference-data.mjs, passo à parte)
-- -- um INSERT directo violaria a foreign key. Em produção (onde já
-- existem) semeia tudo normalmente; no CI fica sem efeito, sem partir
-- a migração.
insert into services (institution_id, name)
select v.institution_id, v.name
from (values
  ('banco-exemplo', 'Abertura de conta'),
  ('banco-exemplo', 'Cartão bancário'),
  ('banco-exemplo', 'Empréstimo'),
  ('banco-exemplo', 'Reclamação'),
  ('bpc', 'Atendimento Balcão'), ('bpc', 'Depósitos e Levantamentos'), ('bpc', 'Cartões'),
  ('bpc', 'Crédito Habitação'), ('bpc', 'Crédito Pessoal'), ('bpc', 'Reclamações'),
  ('bfa', 'Atendimento Balcão'), ('bfa', 'Depósitos e Levantamentos'), ('bfa', 'Cartões'),
  ('bfa', 'Crédito Habitação'), ('bfa', 'Crédito Pessoal'), ('bfa', 'Reclamações'),
  ('bai', 'Atendimento Balcão'), ('bai', 'Depósitos e Levantamentos'), ('bai', 'Cartões'),
  ('bai', 'Crédito Habitação'), ('bai', 'Crédito Pessoal'), ('bai', 'Reclamações'),
  ('bci', 'Atendimento Balcão'), ('bci', 'Depósitos e Levantamentos'), ('bci', 'Cartões'),
  ('bci', 'Crédito Habitação'), ('bci', 'Crédito Pessoal'), ('bci', 'Reclamações'),
  ('siac', 'Bilhete de Identidade'), ('siac', 'Registo Civil'), ('siac', 'Trânsito e Matrículas (DTSER)'),
  ('siac', 'Passaporte e Residência'), ('siac', 'Cartório Notarial'), ('siac', 'Registo Automóvel'),
  ('siac', 'Registo Comercial'), ('siac', 'Registo Predial'), ('siac', 'NIF — AGT'), ('siac', 'INSS'),
  ('siac', 'Ficheiro Central'), ('siac', 'Licenciamento Comercial (CAEC)'), ('siac', 'Administração Distrital')
) as v(institution_id, name)
where exists (select 1 from institutions i where i.id = v.institution_id)
on conflict (institution_id, name) do nothing;
