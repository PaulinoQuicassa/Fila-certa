# Arquitectura — Fila Certa

Data: 2026-10-04. Estado real, não o desejado. Cada secção distingue o que está feito do que falta.

## 1. Visão geral

```
                       FILA CERTA
                           │
    ┌──────────────────────┼───────────────────────┐
    │                      │                       │
    ▼                      ▼                       ▼
Cliente (Flutter)     Equipa (React)          Dono (React)
 Android / Web        balcão + gestão         plataforma
 GitHub Pages (web)   Vercel (principal)      GitHub Pages
    │                      │                       │
    └──────────────────────┼───────────────────────┘
                           ▼
                       SUPABASE
          ┌───────────┬────────────┬───────────┐
          │           │            │           │
        Auth      PostgreSQL       RPC        Edge Functions
                      │            │           │
                     RLS     regras de     WhatsApp / Twilio /
                             negócio       notificações
```

## 2. Aplicações

| Aplicação | Repositório | Stack | Utilizador | Hosting actual | Hosting alvo |
|---|---|---|---|---|---|
| App do cliente (Android/Web) | `DevSYNOVAR` | Flutter | Cidadão | Android (APK/Play em preparação); Web no GitHub Pages | Web: Vercel (a decidir) |
| App da equipa (balcão e gestão) | `Fila-certa` (`fila-certa-staff`) | React + Vite | Funcionário, gestor, director | **Vercel** (manual) e GitHub Pages (CI) | Vercel (automático) |
| Consola do dono | `fila-certa-owner` | React + Vite | Dono da plataforma | GitHub Pages | Vercel |

A app da equipa serve, na prática, dois perfis: **balcão** (`/agente`, `/estacao`) e **gestão** (`/dashboard`, `/direcao`). Separá-los em duas apps só se justifica quando houver necessidades de deploy ou de segurança diferentes; hoje o isolamento vem das RPC e do RLS, não da separação de código.

## 3. Repositórios

Decisão: **manter repositórios separados**, sem monorepo.

Justificação:
- As três apps têm **CI, deploy e ciclo de vida diferentes** (Flutter não corre no mesmo pipeline que React).
- O código partilhado é pequeno: tipos e o cliente Supabase são duplicados em cada app. Um pacote partilhado só compensa quando a duplicação causar erros reais.
- Migrar para monorepo agora seria uma reorganização sem ganho de segurança nem de entrega.

Quando reavaliar: se a Web de gestão ganhar código próprio que a equipa também precise, ou se os tipos da base de dados começarem a divergir entre apps.

## 4. Backend (Supabase)

- **Auth:** identidade de todos os perfis. Ver `AUTHORIZATION.md`.
- **PostgreSQL:** dados. Multi-tenant por `institution_id` e `branch_id`.
- **RPC:** todas as operações de escrita e as leituras com regra de negócio. O acesso directo a tabelas é restrito pelo RLS.
- **RLS:** isolamento entre instituições e filiais, e entre clientes.
- **Edge Functions:** WhatsApp (`whatsapp-webhook`, `whatsapp-notifier`), callback do Twilio, notificações.

Regra: nenhuma regra de negócio crítica depende só do frontend. A autorização real está no backend.

Detalhe das funções e das permissões: `API.md`.

## 5. Routing e hosting

- A app da equipa é uma SPA (`BrowserRouter`). Para funcionar em `/login`, `/dashboard`, etc., a Vercel reencaminha todas as rotas para `index.html` (`vercel.json`).
- A `basename` do router vem de `import.meta.env.BASE_URL`. A Vercel usa `/` (por omissão). O GitHub Pages usa `--base=/Fila-certa/` no CI. **Este acoplamento é a causa do problema de `/login`** nos dois hosts: sem rewrite, o refresh ou a abertura directa de uma rota dá 404.
- Alvo: a Vercel é o único host da app da equipa. O GitHub Pages deixa de ser necessário depois da validação (ver `DEPLOYMENT.md`).

## 6. Segurança (resumo)

- Cabeçalhos da Vercel: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS (automático). A CSP está em **Report-Only**, para não bloquear a app enquanto não for verificada no navegador.
- Chaves: só a chave publishable (pública por desenho) e o URL no cliente. Nenhuma `service_role` ou `sb_secret_` em bundles nem no APK (verificado).
- Ver `SECURITY.md`.

## 7. Gap analysis: actual → alvo

| Componente | Actual | Alvo | Estado |
|---|---|---|---|
| Routing da app da equipa | 404 em rotas directas, nos dois hosts | Rewrite para `index.html` | **Feito** (`vercel.json`) |
| Hosting da app da equipa | Vercel manual + GitHub Pages no CI | Vercel automático a partir do Git | Pendente (ver `DEPLOYMENT.md`) |
| Cabeçalhos de segurança | Parcial (HSTS só) | CSP enforced + restantes | **Parcial**: cabeçalhos feitos; CSP em Report-Only |
| Build com base de subcaminho | `--base=/Fila-certa/` no CI | Base `/` | Pendente (só depois de desligar GitHub Pages) |
| Consola do dono | GitHub Pages | Vercel | Pendente (requer aprovação) |
| App do cliente Web | GitHub Pages | Decidir (Vercel ou manter) | Pendente |
| Autorização | RLS + RPC + `is_*` helpers | Mantido | OK; ver `AUTHORIZATION.md` |
| Permissões RPC | Restringidas em 2026-10-04 | Mantido | OK, não alterar |
| Índices FK / RLS initplan | Alertas de desempenho | Migração própria | Pendente (requer aprovação) |
| Firebase | Projecto e chave de serviço | Removido | Em curso (ver `SECURITY.md`) |
| APK Android | Build de validação, debug-signed | Release assinado (Play) | Pendente |
| Monorepo | Não | Não (justificado, §3) | Decisão tomada |

## 8. Diagrama de responsabilidades

| Componente | Responsabilidade |
|---|---|
| App Flutter (cliente) | Experiência do cidadão: escolher, emitir senha, acompanhar, notificações |
| Web da equipa (Vercel) | Operação diária do balcão e gestão |
| Consola do dono | Plataforma: instituições, filiais, serviços, perfis |
| Vercel | Hosting Web, previews, produção |
| GitHub | Código e CI |
| Supabase Auth | Identidade |
| PostgreSQL | Dados |
| RPC | Regras de negócio |
| RLS | Isolamento dos dados |
| Edge Functions | Processamento server-side e integrações |
| WhatsApp | Canal externo, webhook com validação de assinatura |
| Realtime | Actualizações em tempo real (com polling onde o RLS não permite eventos) |
