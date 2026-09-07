# Fila Certa — Staff (Agente · Painel Público · Dashboard)

App web (React + TypeScript + Vite) para a equipa das instituições que
usam a Fila Certa: agente de balcão, ecrã público de chamada (TV) e
dashboard do gestor. É um **repositório separado** da app cliente Flutter
(`projectogestaodefilas`, GitHub `PaulinoQuicassa/DevSYNOVAR`) — código
diferente, **mesmo projecto Supabase** (`qdfpqispcntitvczybfl`).

## Porque um repositório separado

- Público diferente (equipa institucional vs. cliente final), ciclo de
  distribuição diferente (web para tablets/TVs, sem lojas de app).
- O Postgres do Supabase é o backend partilhado — os dois códigos falam
  com a mesma base de dados, com RLS a isolar o que cada papel pode ver
  (ver `docs/security-rls.md`).

## Stack

React 19 + TypeScript + Vite · `react-router-dom` · `@supabase/supabase-js`
(Auth + Postgres + Realtime, client SDK) · `firebase-admin` (só para os
scripts de operação em `scripts/`, que leem o arquivo histórico no
Firestore — não faz parte da app; ver "Histórico" abaixo).

## Modelo de dados (Postgres/Supabase)

Ver `docs/database-design.md` para o schema completo. Resumo:

```
institutions(id, name)
branches(institution_id, id, name)
counters(institution_id, branch_id, id, label, status, current_ticket_id, current_agent_id)
staff(id = auth.users.id, name, role: 'agent'|'manager', institution_id, branch_id, counter_id?)
tickets(id, institution_id, branch_id, code, service, priority, status, counter_id, customer_id, created_at, called_at, done_at, ...)
ticket_calls(id, institution_id, branch_id, ticket_id, code, counter_label, called_at)  -- log append-only, substitui o antigo "liveBoard"
appointments(code, institution_id, branch_id, customer_id, service, date, time, status)
ratings(id, ticket_id, institution_id, branch_id, customer_id, overall, recommend, comment, aspect_*)
notifications(id, user_id, title, subtitle, read, created_at)
user_settings(user_id, queue_alerts, appointment_reminders, promotions, whatsapp, language)
branch_counters(institution_id, branch_id, seq)  -- sequência atómica para códigos de senha/agendamento
```

Toda a mutação (tirar/chamar/concluir/transferir/cancelar/pausar) passa
por funções RPC `SECURITY DEFINER` (`supabase/migrations/*_rpc_functions.sql`)
— nunca por `INSERT`/`UPDATE` directo do cliente. `institutionId`/
`branchId` estão fixos por instância publicada (ver `.env.example`) —
seis instituições reais já activas em produção.

## Correr localmente

```bash
npm install
npm run dev      # Vite, já ligado ao projecto Supabase real (ver .env.local)
```

Contas de staff de teste (password `teste123` para todas):
- `agente@filacerta.test` / `gestor@filacerta.test` → Banco Exemplo
- `agente@bpc.test` / `gestor@bpc.test`, e equivalentes para `bfa`/`bai`/`bci`/`siac`
- `/painel` → ecrã público, sem login (sessão anónima do Supabase)

Não há emulador local — o desenvolvimento corre sempre contra o projecto
Supabase real (`qdfpqispcntitvczybfl`), com contas/dados de teste
isolados por instituição.

## Estrutura

```
src/
├── supabase.ts          # init do cliente Supabase (URL + publishable key)
├── types.ts
├── auth/AuthContext.tsx  # Supabase Auth (staff)
├── lib/queue.ts          # toda a leitura (postgres_changes + refetch)/escrita (RPC) na fila
├── pages/
│   ├── Login.tsx
│   ├── AgentScreen.tsx   # /agente
│   ├── PublicDisplay.tsx # /painel (sessão anónima)
│   └── Dashboard.tsx     # /dashboard
└── styles/tokens.css     # tokens de marca (fc-*)
supabase/migrations/       # schema, RLS, RPCs -- fonte da verdade do backend
scripts/                   # ferramentas de operação (ver "Histórico" abaixo) + testes de integração reais (test-*.mjs)
docs/                      # auditoria, arquitectura, segurança, testes -- ver docs/migration-plan.md para o histórico completo
```

## Histórico: migração Firebase → Supabase

Este projecto começou sobre Firebase (Auth + Firestore). Foi migrado por
completo para Supabase — **Firebase foi removido definitivamente do
código** (não há `firebase`/`cloud_firestore`/`firebase_auth` em nenhum
dos dois repositórios). O projecto Firebase original (`filacerta-d74f0`)
guarda só um arquivo histórico do Firestore de antes da migração
(`scripts/backup-firestore.mjs`/`count-firestore-data.mjs` continuam a
usar `firebase-admin` só para consultar esse arquivo, nunca para a app
em produção) e continua a servir o Hosting das duas apps (não migrado —
decisão explícita, ver `docs/migration-plan.md`, Fase 14/15).

Ver `docs/migration-plan.md` para o histórico fase a fase completo,
`docs/security-rls.md` para o modelo de segurança actual, e
`docs/frontend-migration-audit.md` para a confirmação de que não resta
nenhuma dependência funcional de Firebase.

## Publicar (GitHub Pages)

O alojamento não é Firebase Hosting (removido em 2026-09-07, por
decisão explícita de não manter Firebase para nenhuma finalidade,
incluindo hosting) -- é GitHub Pages, servido a partir de uma branch
órfã `gh-pages` deste repositório (repositório público, exigido pelo
plano gratuito do GitHub Pages).

```bash
npm run build                       # gera dist/, mas SEM o base path certo
MSYS_NO_PATHCONV=1 npx vite build --base=/Fila-certa/   # build com o base path do GitHub Pages
cp dist/index.html dist/404.html    # fallback de SPA (GitHub Pages não tem rewrites)
touch dist/.nojekyll
# depois: copiar dist/ para uma worktree da branch gh-pages, commit, push -f
```

URL publicado: https://paulinoquicassa.github.io/Fila-certa/

## Estado actual

Funcional em produção contra o Supabase real: login por papel (agente/
gestor), fluxo completo de chamada de senha (chamar/concluir/não
compareceu/transferir/pausar) sincronizado em tempo real entre `/agente`,
`/painel` e `/dashboard`, com RLS a isolar cada instituição/filial (ver
`docs/security-rls.md`).
