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

1. **Retenção de `ticket_calls`/`audit_logs`/notificações** — sem
   política ainda.
2. **Testes automatizados Flutter** — reescrever `test/widget_test.dart`
   sem `fake_cloud_firestore` (ver `docs/testing.md`); continuam `skip`
   e agora também documentados como tal no CI (Ronda 4).
3. **Papel de administração da plataforma** (Platform Admin) —
   onboarding de instituições continua manual, sem visão global.
4. **Notificações push** (FCM/APNs ou equivalente) — depois da base
   operacional consolidada.
5. **Backups automáticos reais** — só resolvido com upgrade de plano
   (decisão de custo do utilizador) ou uma solução externa (ex.: um
   `pg_dump` agendado fora do Supabase, com credenciais de base de
   dados directas — não tentado ainda).
6. **Migrações de produção continuam manuais** (decisão deliberada da
   Ronda 4, não uma lacuna a fechar sem mais contexto) — sem ambiente
   de staging, automatizar isto teria mais risco do que benefício por
   agora.
7. **Sem protecção de branch** (`master`/`main` aceitam push directo
   sem PR obrigatório) — decisão em aberto, não tomada nesta ronda por
   estar fora do âmbito pedido.

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

## Ronda 4 (2026-09-07) — CI/CD: controlo de qualidade e deploy seguro

Pipeline de qualidade + deploy automático nos dois repos, substituindo
o processo manual usado até aqui (lint/build/deploy corridos à mão
nesta máquina). Ver `docs/rollback.md` para o procedimento de reversão.

**`fila-certa-staff/.github/workflows/ci.yml`** (push/PR para `master`)
— 3 jobs:
1. **Qualidade e segurança (Web)**: TypeScript (`tsc -b`), lint, build,
   verificação de segredos acidentais (`.env`, `service_role`, chaves
   privadas — via `git grep`, só ficheiros rastreados), verificação
   permanente de não-regressão de Firebase (falha o build se
   `firebase`/`firestore`/`google-services`/`firebase_options`/
   `FirebaseAuth`/`FirebaseFirestore` aparecer fora das excepções
   documentadas: `scripts/backup-firestore.mjs`,
   `scripts/count-firestore-data.mjs`, `firebase-admin` em
   `package.json`), `npm audit` (só bloqueia em alto/crítico).
2. **Testes Supabase — ambiente local efémero**: `supabase start`
   (Docker, só disponível nos runners do GitHub) sobe um Postgres limpo
   e aplica automaticamente todas as migrations versionadas — prova que
   são reproduzíveis do zero, não só que funcionam em produção. Semeia
   dados de referência (`scripts/seed-reference-data.mjs`, novo,
   idempotente) e corre os 8 scripts de regressão (RPC, RLS, Realtime,
   concorrência, auditoria) contra este ambiente, nunca contra
   produção. Uma falha aqui bloqueia o deploy — sem excepções "7/8 já
   chega".
3. **Deploy (GitHub Pages) + Smoke Test**: só corre em push directo a
   `master` (não em PR) e só depois dos dois jobs anteriores passarem.
   Build com `--base=/Fila-certa/`, publica via `git worktree` no
   branch `gh-pages`, smoke test real pós-deploy (HTTP 200, HTML da
   app presente, sem Firebase).

**`projectogestaodefilas/.github/workflows/ci.yml`** (push/PR para
`main`) — equivalente para a app cliente Flutter: `flutter analyze`
bloqueante, `flutter test` (os 4 testes de widget existentes
mantêm-se `skip`, documentados desde a migração — ver comentário no
topo de `test/widget_test.dart` — não reescritos para fingir cobertura
que não existe), as mesmas verificações de segredos/Firebase, build
web e deploy com smoke test para `https://paulinoquicassa.github.io/DevSYNOVAR/`.
Corrigido um único aviso pré-existente de `flutter analyze`
(`prefer_const_constructors` em `lib/screens/queue_screen.dart:200`)
para o gate poder ser bloqueante sem ficar preso num aviso cosmético
sem relação com esta ronda.

**Decisões deliberadas, fora do âmbito desta ronda:**
- **Migrações de base de dados continuam manuais** (mesmo processo já
  usado durante toda a migração, via Management API). Não foi
  automatizada a aplicação de novas migrations a produção como parte
  do deploy — não existe ambiente de staging, e alterações de esquema
  não são triviais de reverter; o próprio pedido original desta fase
  pede revisão antes de produção. Migrations continuam versionadas em
  `supabase/migrations/` e testadas no Postgres efémero do CI antes de
  qualquer aplicação manual a produção.
- **Sem regras de protecção de branch** (`master`/`main` continuam sem
  exigir PR/review para push directo) — mantém a prática já em uso
  durante toda esta migração; criar essa exigência agora seria uma
  mudança de processo não pedida explicitamente. Fica como ponto em
  aberto, não como decisão silenciosa.
- **Zero GitHub Secrets configurados** em ambos os repositórios
  (confirmado via `gh secret list`) — e não são necessários com este
  desenho: o Supabase local efémero gera as suas próprias credenciais
  em tempo de execução (capturadas de `supabase status`), e o push
  para `gh-pages` usa o `GITHUB_TOKEN` automático do workflow.
- **`permissions:` explícitas** adicionadas a ambos os workflows
  (`contents: write` para o push ao `gh-pages`) — o valor por omissão
  do repositório é só leitura (`default_workflow_permissions: read`),
  confirmado via API; sem isto o passo de deploy falharia
  silenciosamente por falta de autorização.

**Validado**: ambos os pipelines correram de ponta a ponta com sucesso
real (não simulado) — `fila-certa-staff` run `34149079490` (3/3 jobs),
`DevSYNOVAR` run `34149782974` (3/3 jobs) — incluindo o deploy e o
smoke test pós-deploy contra os sites publicados reais.

### Incidente durante esta ronda: sem novos incidentes de dados

Ao contrário da Ronda 3, esta ronda não teve nenhum incidente de perda
ou corrupção de dados. As iterações de correcção do workflow (grep vs.
`git grep`, `npm ci` em falta, exclusões do Firebase-check,
`permissions:` em falta) foram todas descobertas e corrigidas através
de execuções reais do pipeline no GitHub Actions, nunca por
adivinhação.
