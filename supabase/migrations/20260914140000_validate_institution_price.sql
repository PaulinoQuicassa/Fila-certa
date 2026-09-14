-- Achado de um teste de penetração real contra produção (2026-09-14):
-- owner_create_institution/owner_update_institution aceitavam
-- price_per_counter_kz negativo sem nenhuma validação -- um preço
-- negativo corrompe silenciosamente o cálculo de MRR em
-- owner_list_institutions_overview (receita mensal = balcões × preço).
-- Corrigido ao nível da coluna (CHECK constraint), não só numa RPC --
-- protege qualquer caminho de escrita futuro, mesmo mensagens de erro
-- claras vêm directamente do Postgres.
alter table institution_billing
  add constraint institution_billing_price_non_negative check (price_per_counter_kz >= 0);
