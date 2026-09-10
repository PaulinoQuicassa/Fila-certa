-- Painel de Inteligência (Direcção Geral): terceiro papel de equipa,
-- acima de agente/gestor -- vê todas as filiais de UMA instituição
-- (não todas as instituições, isso é o "owner"). Numa migração à parte
-- de propósito: o Postgres não deixa usar um valor de enum novo na
-- mesma transacção em que foi adicionado.

alter type staff_role add value 'director';
