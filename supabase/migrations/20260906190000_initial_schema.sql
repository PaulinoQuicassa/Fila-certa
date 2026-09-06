-- Fase 4 do plano de migração (docs/migration-plan.md).
-- Esquema derivado de docs/database-design.md, que por sua vez deriva
-- do modelo Firestore real documentado em docs/firebase-audit.md.
-- Só estrutura de dados aqui -- sem RLS (fica em 20260906190100_rls.sql)
-- e sem funções RPC (fica para a Fase 9, ainda não pedida).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

create type staff_role as enum ('agent', 'manager');
create type counter_status as enum ('available', 'serving', 'paused');
-- 'called' do TicketStatus original do Firestore não entra aqui: confirmado
-- por grep nos dois repos que nunca é escrito (ver firebase-audit.md, secção 3).
create type ticket_status as enum ('waiting', 'serving', 'done', 'no_show');
create type no_show_reason as enum ('customer_cancelled', 'staff_marked');
create type appointment_status as enum ('scheduled', 'cancelled');

-- ---------------------------------------------------------------------
-- institutions / branches / counters
-- IDs de texto preservados de propósito (ver database-design.md,
-- secção "Convenções") -- já são estáveis e usados nos scripts de seed.
-- ---------------------------------------------------------------------

create table institutions (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table branches (
  id              text not null,
  institution_id  text not null references institutions(id) on delete cascade,
  name            text not null,
  created_at      timestamptz not null default now(),
  primary key (institution_id, id)
);

create table counters (
  id                text not null,
  branch_id         text not null,
  institution_id    text not null,
  label             text not null,
  status            counter_status not null default 'available',
  current_ticket_id uuid, -- FK para tickets adicionada depois de tickets existir
  -- referencia auth.users em vez de staff de propósito: staff tem uma FK
  -- para counters (staff.counter_id), e counters é criada antes de staff
  -- -- referenciar staff(id) aqui criaria uma dependência circular entre
  -- as duas tabelas.
  current_agent_id  uuid references auth.users(id),
  primary key (institution_id, branch_id, id),
  foreign key (institution_id, branch_id) references branches(institution_id, id)
);

-- ---------------------------------------------------------------------
-- staff
-- staff.id = auth.users.id (mesma relação 1:1 que já existia entre o
-- documento staff/{uid} do Firestore e o Firebase Auth UID).
-- ---------------------------------------------------------------------

create table staff (
  id              uuid primary key references auth.users(id) on delete cascade,
  name            text not null,
  role            staff_role not null,
  institution_id  text not null references institutions(id),
  branch_id       text not null,
  counter_id      text,
  created_at      timestamptz not null default now(),
  foreign key (institution_id, branch_id) references branches(institution_id, id),
  foreign key (institution_id, branch_id, counter_id) references counters(institution_id, branch_id, id)
);

-- ---------------------------------------------------------------------
-- tickets
-- ---------------------------------------------------------------------

create table tickets (
  id                          uuid primary key default gen_random_uuid(),
  institution_id              text not null,
  branch_id                   text not null,
  code                        text not null,
  service                     text not null, -- texto livre, ver database-design.md "Nota sobre service"
  priority                    boolean not null default false,
  status                      ticket_status not null default 'waiting',
  counter_id                  text,
  created_at                  timestamptz not null default now(),
  called_at                   timestamptz,
  done_at                     timestamptz,
  transferred_to_counter_id   text,
  no_show_reason              no_show_reason,
  was_transferred             boolean not null default false,
  customer_on_the_way         boolean not null default false,
  customer_id                 uuid references auth.users(id),
  foreign key (institution_id, branch_id) references branches(institution_id, id),
  foreign key (institution_id, branch_id, counter_id) references counters(institution_id, branch_id, id)
);

alter table counters
  add constraint counters_current_ticket_fkey
  foreign key (current_ticket_id) references tickets(id);

alter table tickets
  add constraint tickets_transferred_to_counter_fkey
  foreign key (institution_id, branch_id, transferred_to_counter_id) references counters(institution_id, branch_id, id);

-- Índices justificados por queries reais já existentes (ver
-- database-design.md e firebase-audit.md, secção 3, coluna "Ficheiros
-- que acedem"):
create index tickets_waiting_idx on tickets (branch_id, status) where status = 'waiting'; -- callNext / subscribeWaitingQueue
create index tickets_branch_created_idx on tickets (branch_id, created_at); -- "senhas de hoje" do dashboard
create index tickets_customer_idx on tickets (customer_id); -- "Os meus atendimentos"
create index tickets_customer_active_idx on tickets (customer_id, status) where status in ('waiting', 'serving'); -- avisos globais (activeTicketStore)

-- ---------------------------------------------------------------------
-- ticket_calls -- substitui liveBoard/current (ver database-design.md
-- "Problema → Proposta" para a justificação de ser log append-only)
-- ---------------------------------------------------------------------

create table ticket_calls (
  id              uuid primary key default gen_random_uuid(),
  institution_id  text not null,
  branch_id       text not null,
  ticket_id       uuid not null references tickets(id),
  code            text not null,
  counter_label   text not null,
  called_at       timestamptz not null default now(),
  foreign key (institution_id, branch_id) references branches(institution_id, id)
);

create index ticket_calls_branch_idx on ticket_calls (institution_id, branch_id, called_at desc); -- "última senha chamada" / painel TV

-- ---------------------------------------------------------------------
-- appointments -- unifica users/{uid}/appointments + espelho
-- institucional (ver database-design.md "Problema → Proposta")
-- ---------------------------------------------------------------------

create table appointments (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  institution_id  text not null,
  branch_id       text not null,
  customer_id     uuid not null references auth.users(id),
  service         text not null,
  date            date not null,
  time            text not null,
  status          appointment_status not null default 'scheduled',
  created_at      timestamptz not null default now(),
  foreign key (institution_id, branch_id) references branches(institution_id, id)
);

create index appointments_customer_idx on appointments (customer_id);
create index appointments_branch_created_idx on appointments (institution_id, branch_id, created_at); -- KPI "agendamentos hoje"

-- ---------------------------------------------------------------------
-- ratings -- aspects como colunas tipadas em vez de mapa solto
-- (ver database-design.md "Problema → Proposta")
-- ---------------------------------------------------------------------

create table ratings (
  id                    uuid primary key default gen_random_uuid(),
  ticket_id             uuid not null unique references tickets(id),
  institution_id        text not null,
  branch_id             text not null,
  customer_id           uuid not null references auth.users(id),
  service               text not null,
  overall               smallint not null check (overall between 1 and 5),
  recommend             boolean not null,
  comment               text not null default '',
  aspect_atendimento    smallint not null check (aspect_atendimento between 1 and 5),
  aspect_tempo_espera   smallint not null check (aspect_tempo_espera between 1 and 5),
  aspect_organizacao    smallint not null check (aspect_organizacao between 1 and 5),
  aspect_instalacoes    smallint not null check (aspect_instalacoes between 1 and 5),
  created_at            timestamptz not null default now(),
  foreign key (institution_id, branch_id) references branches(institution_id, id)
);

-- ---------------------------------------------------------------------
-- notifications / user_settings (privados do cliente)
-- ---------------------------------------------------------------------

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  subtitle    text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index notifications_user_unread_idx on notifications (user_id, read); -- contagem de não lidas (sino do HomeScreen)

create table user_settings (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  queue_alerts            boolean not null default true,
  appointment_reminders   boolean not null default true,
  promotions              boolean not null default false,
  whatsapp                boolean not null default true,
  language                text not null default 'pt'
);

-- ---------------------------------------------------------------------
-- branch_counters -- substitui institutions/.../meta/ticketSeq
-- (só escrito pelas funções RPC da Fase 9, nunca directamente pelo
-- cliente -- ver docs/security.md)
-- ---------------------------------------------------------------------

create table branch_counters (
  institution_id  text not null,
  branch_id       text not null,
  seq             bigint not null default 0,
  primary key (institution_id, branch_id),
  foreign key (institution_id, branch_id) references branches(institution_id, id)
);
