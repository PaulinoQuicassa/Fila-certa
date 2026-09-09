-- Achado da nova auditoria de RLS/permissões pedida depois de fechar os
-- 3 gaps conhecidos: a migration anterior de GRANTs
-- (20260907100200_revoke_unnecessary_grants.sql) esqueceu a view
-- `counters_with_agent` -- ainda tinha INSERT/UPDATE/DELETE concedidos
-- a anon/authenticated. Inofensivo na prática (a view tem um LEFT JOIN,
-- o Postgres nunca a trata como "simplesmente actualizável"), mas
-- inconsistente com a mesma defesa em profundidade já aplicada a todo
-- o resto -- corrigido para fechar por completo.
revoke insert, update, delete, truncate on counters_with_agent from anon, authenticated;
