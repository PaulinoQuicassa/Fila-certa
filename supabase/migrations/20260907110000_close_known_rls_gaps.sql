-- Fecha os 3 gaps de RLS já identificados e conscientemente deixados
-- em aberto no hardening de 2026-09-06/07 (docs/security-rls.md,
-- secção 5 "Fora de âmbito desta ronda"). Mesma causa raiz, mesmo
-- princípio (least privilege por filial) já aplicado a
-- tickets/counters/ticket_calls -- aqui só se completa a mesma camada,
-- não se inventa nenhuma regra nova.

-- ---------------------------------------------------------------------
-- ratings: tinha SELECT aberto a qualquer autenticado (`using (true)`).
-- Qualquer cliente conseguia ler comentários/notas de avaliação de
-- qualquer instituição, incluindo o customer_id de quem avaliou.
-- Mesma regra que já existe em tickets: o próprio dono, ou a equipa da
-- filial onde a avaliação foi feita.
-- ---------------------------------------------------------------------

drop policy if exists ratings_select on ratings;
create policy ratings_select on ratings for select to authenticated
  using (customer_id = auth.uid() or is_staff_of_branch(institution_id, branch_id));

-- ---------------------------------------------------------------------
-- appointments: usava is_staff_of(institution_id) -- um gestor/agente
-- via a agenda de QUALQUER filial da mesma instituição, não só a sua.
-- ---------------------------------------------------------------------

drop policy if exists appointments_select on appointments;
create policy appointments_select on appointments for select to authenticated
  using (customer_id = auth.uid() or is_staff_of_branch(institution_id, branch_id));

-- ---------------------------------------------------------------------
-- branch_counters: idem -- usava is_staff_of(institution_id). Esta
-- tabela só guarda um contador de sequência (nunca teve nenhum
-- consumidor real no frontend, só é escrita internamente pelas RPCs
-- pull_ticket/next_appointment_code), mas o princípio aplica-se na
-- mesma: nenhum motivo para um agente ver o contador de outra filial.
-- ---------------------------------------------------------------------

drop policy if exists branch_counters_select on branch_counters;
create policy branch_counters_select on branch_counters for select to authenticated
  using (is_staff_of_branch(institution_id, branch_id));
