# Fila Certa — do piloto ao produto comercial

Iniciado em 2026-09-07, depois de a migração Firebase→Supabase ter sido
formalmente encerrada (ver `docs/migration-plan.md`). Este documento
acompanha o trabalho de robustez/segurança/escalabilidade pedido para
o Fila Certa deixar de ser um piloto e passar a produto vendável a
instituições reais.

## Auditoria inicial (2026-09-07) — factos verificados directamente no projecto ao vivo

| Área | Estado encontrado | Severidade |
|---|---|---|
| **Backups** | Plano gratuito, `pitr_enabled: false`, `backups: []` — zero backups automáticos. Projectos gratuitos também pausam após ~1 semana sem tráfego | 🔴 Crítico |
| RLS | Activo nas 11 tabelas, confirmado directamente na base de dados (não só nos testes) | ✅ Sólido |
| GRANTs | `anon`/`authenticated` tinham INSERT/UPDATE/DELETE/TRUNCATE em todas as tabelas (omissão do Supabase) — RLS era a única camada | 🟠 Corrigido nesta ronda |
| Auditoria (quem fez o quê) | Inexistente | 🟠 Corrigido nesta ronda |
| Concorrência da fila | `SKIP LOCKED` testado com balcões simultâneos | ✅ Sólido |
| Isolamento multi-instituição/filial | Testado (10 cenários) | ✅ Sólido |
| Config. de Auth | Password mínima 6, sem verificação HIBP, sem CAPTCHA, sessões sem expiração forçada | 🟡 Fraco para produto comercial |
| Administração da plataforma | Sem papel "admin"; onboarding de instituições é manual via script | 🟡 Sem self-service |
| Performance/escalabilidade | Índices adequados ao padrão de acesso actual; nunca testado sob carga real | 🟡 Desconhecido |
| Logs/monitorização de erros | Nenhum (sem Sentry ou equivalente, sem alerta de uptime) | 🟡 Em falta |
| CI/CD | Inexistente | 🟡 Em falta |
| Notificações | Só in-app; sem push (FCM/APNs) | 🟡 Em falta |
| Testes automatizados | Scripts de integração reais e sólidos; widget tests `skip` | 🟡 Parcial |
| `ticket_calls` | Cresce sem política de retenção | 🟢 Baixo risco, anotado |

## Decisões tomadas

- **Backups**: plano Pro não escolhido (custo). Mitigação: backup manual
  periódico via `scripts/backup-supabase.mjs` (dump completo de todas
  as tabelas + lista de utilizadores Auth para JSON local, mesmo padrão
  do backup do Firestore da Fase 0). **Não resolve a pausa automática
  do plano gratuito** — isso só se resolve com upgrade, decisão em
  aberto.
- **Próxima prioridade escolhida**: `audit_logs` (antes de logs de erro/
  monitorização ou CI/CD).

## Trabalho concluído nesta ronda

### 1. `scripts/backup-supabase.mjs`
Backup manual (correr quando fizer sentido, ex.: semanalmente ou antes
de uma alteração grande): `SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup-supabase.mjs`.
Exporta todas as tabelas de negócio + lista de contas Auth para
`~/Desktop/fila-certa-backups/`. O esquema (DDL) já está garantido
pelas migrations versionadas — não precisa de backup à parte.

### 2. `audit_logs` (`20260907100000_audit_logs.sql`, `20260907100100_audit_rpcs.sql`)
Tabela append-only: `actor_id`, `action`, `entity`/`entity_id`,
`institution_id`/`branch_id`, `result`, `details` (jsonb). Instrumenta
as 11 RPCs de mutação existentes — cada uma escreve um registo depois
de a acção ter sucesso. Só a equipa da própria filial lê o seu
registo (`is_staff_of_branch`); ninguém escreve directamente, só a
função interna `write_audit_log(...)`.

**Limitação aceite**: só sucessos ficam auditados (uma tentativa
negada reverte a transacção inteira, incluindo o registo). Capturar
negações exigiria transacção autónoma (`dblink`/`pg_background`) —
não implementado, considerado overengineering para o valor actual.

### 3. Defesa em profundidade — GRANTs (`20260907100200_revoke_unnecessary_grants.sql`)
Revogados INSERT/UPDATE/DELETE/TRUNCATE de `anon`/`authenticated` em
todas as tabelas que só devem mutar via RPC, e UPDATE/DELETE onde nunca
existiu policy (`ratings`, `notifications`, `user_settings`). Efeito: se
o RLS de uma tabela for desactivado por engano no futuro, essas
operações continuam bloqueadas ao nível do GRANT.

### Validação
`scripts/test-audit-logs.mjs` (novo, 5 cenários) + regressão completa
(`test-phase9`, `test-phase12`, `test-realtime-delivery`,
`test-security-hardening`, `test-public-aggregates`,
`test-flutter-data-paths`) — 7/7 scripts verdes. Um teste antigo
(`test-phase9.mjs`, cenário 9) tinha uma asserção escrita para a forma
antiga de recusa (RLS devolvia 0 linhas); actualizada para aceitar
também a recusa mais forte agora possível (`42501 permission denied`,
nem chega a avaliar RLS).

## Pendente (por prioridade, a decidir)

1. **Backups automáticos reais** — só resolvido com upgrade de plano
   (decisão de custo do utilizador) ou uma solução externa (ex.: um
   `pg_dump` agendado fora do Supabase, com credenciais de base de
   dados directas — não tentado ainda).
2. **Gaps de segurança conhecidos, ainda não corrigidos**:
   `ratings_select` aberto a qualquer autenticado; `appointments`/
   `branch_counters` isolados por instituição, não por filial.
3. **Observabilidade**: rastreio de erros (Sentry ou equivalente),
   alerta de uptime.
4. **CI/CD**: lint/build/testes automáticos antes de deploy.
5. **Notificações push** (FCM/APNs ou equivalente) — decisão de
   arquitectura, não implementado.
6. **Testes automatizados Flutter** — reescrever `test/widget_test.dart`
   sem `fake_cloud_firestore` (ver `docs/testing.md`).
7. **Retenção de `ticket_calls`** — sem política ainda.
8. **Papel de administração da plataforma** — onboarding de
   instituições continua manual.
