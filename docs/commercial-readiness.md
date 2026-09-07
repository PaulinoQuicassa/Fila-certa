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

## Ronda 2 (2026-09-07) — fecho dos gaps de RLS conhecidos

Prioridade escolhida pelo utilizador: fechar os 3 gaps já identificados
antes de qualquer funcionalidade nova (observabilidade, CI/CD, etc.).

`20260907110000_close_known_rls_gaps.sql`:
- **`ratings_select`**: de `using (true)` para `customer_id = auth.uid()
  or is_staff_of_branch(institution_id, branch_id)` — mesma regra de
  `tickets`.
- **`appointments_select`**: de `is_staff_of(institution_id)` (só
  instituição) para `is_staff_of_branch(institution_id, branch_id)`.
- **`branch_counters_select`**: idem.

**Achado extra desta auditoria** (`20260907110100_revoke_view_grants.sql`):
a view `counters_with_agent` tinha ficado fora da revogação de GRANTs da
ronda anterior — ainda tinha INSERT/UPDATE/DELETE concedidos a
`anon`/`authenticated`. Inofensivo na prática (a view tem um `LEFT JOIN`,
o Postgres nunca a trata como automaticamente actualizável), mas
corrigido para consistência da mesma defesa em profundidade.

**Nova auditoria de RLS/permissões pedida explicitamente, feita**:
confirmado directamente na base de dados — RLS activo nas 12 tabelas,
todas as 16 policies a corresponder exactamente ao desenho, GRANTs sem
mais nenhum resíduo desnecessário.

**Validado** com `scripts/test-rls-gaps-closed.mjs` (novo, 6 cenários,
incluindo uma filial temporária para provar isolamento cross-branch
dentro da mesma instituição, não só cross-institution) + regressão
completa: **8/8 scripts verdes**.

## Pendente (por prioridade)

1. **CI/CD** (próxima prioridade escolhida): lint/build/testes
   automáticos antes de deploy, incluindo os testes de RLS/segurança já
   existentes.
2. **Retenção de `ticket_calls`/`audit_logs`/notificações** — sem
   política ainda.
3. **Testes automatizados Flutter** — reescrever `test/widget_test.dart`
   sem `fake_cloud_firestore` (ver `docs/testing.md`).
4. **Papel de administração da plataforma** (Platform Admin) —
   onboarding de instituições continua manual, sem visão global.
5. **Notificações push** (FCM/APNs ou equivalente) — depois da base
   operacional consolidada.
6. **Backups automáticos reais** — só resolvido com upgrade de plano
   (decisão de custo do utilizador) ou uma solução externa (ex.: um
   `pg_dump` agendado fora do Supabase, com credenciais de base de
   dados directas — não tentado ainda).

## Ronda 3 (2026-09-07) — Observabilidade: Sentry + uptime via GitHub Actions

Serviço externo gratuito escolhido pelo utilizador. Sentry para
rastreio de erros (5 mil eventos/mês grátis), GitHub Actions para
monitorização de uptime (já autenticado nesta sessão, sem conta nova).

**Sentry** — 2 projectos separados (`fila-certa-client`/Flutter,
`fila-certa-staff`/React), sem tracing/session replay (só erros, para
não gastar quota sem necessidade comprovada):
- React: `src/sentry.ts` (init + `reportError(error, context)`),
  `Sentry.ErrorBoundary` à volta de toda a app (`App.tsx`, com fallback
  amigável em vez de ecrã branco), e o wrapper `run()` do `AgentScreen`
  (único ponto de entrada de todas as acções do balcão) reporta com
  contexto (instituição/filial/balcão).
- Flutter: `SentryFlutter.init(...)` envolve o `appRunner` em
  `main.dart` — captura automática de erros não tratados e de futures
  sem `await`, sem código extra. `choose_service_screen.dart` (entrar
  na fila, fluxo crítico) reporta explicitamente com contexto.
- Deliberadamente sem alterações: `Login.tsx`/`auth_service.dart`
  (password errada não é bug), `location_service.dart` (permissão de
  GPS negada é esperado), `Dashboard.tsx` (sem nenhum acto próprio com
  try/catch).
- Validado com um evento de teste real enviado directamente à API de
  ingestão de cada projecto (200, ID de evento devolvido) — confirma os
  2 DSNs correctos antes de confiar na app para os disparar.

**Uptime** (`.github/workflows/uptime.yml`, repo `fila-certa-staff`):
corre a cada 15 minutos, verifica as duas apps (GitHub Pages) e uma RPC
pública real do Supabase (`branch_wait_stats` — exercita
Auth+PostgREST+RPC+DB, não só o domínio). Em falha: o workflow falha
(GitHub notifica por email o dono do repositório) e abre/actualiza uma
issue única (label `uptime`); fecha-se sozinha quando as 3 verificações
voltam a passar. Testado com uma corrida manual (`workflow_dispatch`) —
sucesso confirmado.

### Incidente durante esta ronda: corrupção de `.git/config`

Uma interrupção abrupta da sessão anterior, a meio de uma operação
`git worktree` no repositório `fila-certa-staff`, deixou o
`.git/config` local completamente zerado (ficheiro do tamanho certo,
conteúdo todo `0x00` — sintoma clássico de escrita interrompida antes
do conteúdo real ser gravado). Diagnosticado e reparado sem perda de
dados: `git fsck` confirmou que todos os objectos/refs reais estavam
intactos (incluindo um commit "pendente" — órfão de uma ref também
corrompida — que era exactamente o build do GitHub Pages que estava a
ser publicado no momento do corte); o `config` foi reconstruído à mão
(remote + tracking de branch, usando o repositório irmão intacto como
referência de formato) e as refs corrompidas do `gh-pages` foram
reparadas apontando-as para o commit recuperado. Nada foi perdido; o
deploy que estava em curso no momento do corte já tinha realmente
chegado ao GitHub antes da corrupção local, só a contabilidade local é
que ficou incoerente.

### Achado à parte, corrigido: branch por omissão errado no GitHub

O repositório `Fila-certa` tinha o branch **`main`** como default no
GitHub (um stub antigo, 18 commits atrás de `master`, que é onde todo
o trabalho real desta migração sempre aconteceu), por isso o
`uptime.yml` não era reconhecido pelo GitHub Actions (só lê workflows
do branch por omissão). Corrigido via API
(`default_branch: master`) — `main` não foi apagado nem alterado,
fica só como branch secundário, obsoleto mas inofensivo.
