-- Fase 5 do plano de migração (docs/migration-plan.md).
-- Racional completo de cada decisão em docs/security.md -- este
-- ficheiro só aplica o que lá está documentado.
--
-- Princípio adoptado (resolve o ponto 20/21 do mandato de migração):
-- nas tabelas onde existe lógica crítica de fila (tickets, counters,
-- ticket_calls, appointments, branch_counters), o RLS NÃO concede
-- nenhum INSERT/UPDATE/DELETE a `authenticated` -- todas as mutações
-- passam obrigatoriamente pelas funções RPC "SECURITY DEFINER" da
-- Fase 9 (ainda não criadas nesta migration). Só tabelas simples e sem
-- concorrência (notifications, user_settings, ratings) têm DML directo
-- via RLS, tal como já não tinham nenhuma transacção no Firestore.

-- ---------------------------------------------------------------------
-- Helper: pertence à equipa de uma instituição?
-- Mesma verificação que a Firestore rule já fazia com
-- get(/databases/.../staff/$(uid)).data.institutionId == institutionId.
-- ---------------------------------------------------------------------

create or replace function public.is_staff_of(p_institution_id text)
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
  );
$$;

-- ---------------------------------------------------------------------
-- institutions / branches / counters / tickets / ticket_calls
-- Leitura aberta a qualquer autenticado (replica ao pormenor a regra
-- Firestore `allow read: if request.auth != null` sobre
-- institutions/**  -- ver docs/security.md, decisão 1, para a
-- justificação de não ser "USING (true) por preguiça").
-- Escrita: nenhuma directa -- só via funções RPC da Fase 9.
-- ---------------------------------------------------------------------

alter table institutions enable row level security;
create policy institutions_select on institutions for select to authenticated using (true);

alter table branches enable row level security;
create policy branches_select on branches for select to authenticated using (true);

alter table counters enable row level security;
create policy counters_select on counters for select to authenticated using (true);

alter table tickets enable row level security;
create policy tickets_select on tickets for select to authenticated using (true);

alter table ticket_calls enable row level security;
create policy ticket_calls_select on ticket_calls for select to authenticated using (true);

alter table branch_counters enable row level security;
create policy branch_counters_select on branch_counters for select to authenticated
  using (is_staff_of(institution_id));
-- sem policy de insert/update: só as funções RPC (SECURITY DEFINER) tocam nesta tabela.

-- ---------------------------------------------------------------------
-- staff
-- Réplica exacta da regra Firestore: só o próprio lê o seu perfil;
-- escrita sempre recusada ao cliente (staff só é criado por
-- service_role, nos scripts de seed).
-- ---------------------------------------------------------------------

alter table staff enable row level security;
create policy staff_select_self on staff for select to authenticated
  using (id = auth.uid());
-- sem policy de insert/update/delete: réplica de `allow write: if false`.

-- ---------------------------------------------------------------------
-- appointments
-- Réplica do problema "duplicação privado + espelho" resolvido numa
-- tabela só (ver database-design.md): o dono vê as suas linhas, a
-- equipa da instituição vê as da sua instituição. Escrita só via RPC
-- (schedule_appointment / cancel_appointment, Fase 9) -- evita ter de
-- expressar em RLS a restrição "só o campo status pode mudar, e só
-- para 'cancelled'", que a Firestore rule fazia com diff().affectedKeys().
-- ---------------------------------------------------------------------

alter table appointments enable row level security;
create policy appointments_select on appointments for select to authenticated
  using (customer_id = auth.uid() or is_staff_of(institution_id));

-- ---------------------------------------------------------------------
-- ratings
-- Leitura aberta a qualquer autenticado (mesma abertura que já existia
-- em institutions/** no Firestore -- alimenta o resumo de qualidade do
-- dashboard). Criação directa permitida (sem concorrência a proteger,
-- ao contrário das tabelas de fila), restrita ao dono da senha e a
-- nunca poder ser alterada depois -- réplica exacta de
-- `allow create` sem `allow update` no Firestore.
-- ---------------------------------------------------------------------

alter table ratings enable row level security;
create policy ratings_select on ratings for select to authenticated using (true);
create policy ratings_insert_own on ratings for insert to authenticated
  with check (
    customer_id = auth.uid()
    and exists (select 1 from tickets where tickets.id = ticket_id and tickets.customer_id = auth.uid())
  );
-- sem policy de update/delete: réplica de nunca haver `allow update` para ratings.

-- ---------------------------------------------------------------------
-- notifications
-- Réplica de users/{uid}/notifications: só o dono lê/escreve as suas.
-- Sem concorrência a proteger (é só um inbox) -- DML directo via RLS,
-- tal como já era no Firestore (o cliente já escrevia isto directamente,
-- nunca via transacção).
-- ---------------------------------------------------------------------

alter table notifications enable row level security;
create policy notifications_select_own on notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_insert_own on notifications for insert to authenticated
  with check (user_id = auth.uid());
create policy notifications_update_own on notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- user_settings
-- Réplica de users/{uid}/settings/preferences: só o dono lê/escreve.
-- ---------------------------------------------------------------------

alter table user_settings enable row level security;
create policy user_settings_select_own on user_settings for select to authenticated
  using (user_id = auth.uid());
create policy user_settings_insert_own on user_settings for insert to authenticated
  with check (user_id = auth.uid());
create policy user_settings_update_own on user_settings for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
