# Programa de reorganização — Fila Certa como plataforma

Data de início: 2026-10-05. Estado: **Fase 0 concluída**; Fases 1 a 7 planeadas.

Objectivo: uma estrutura em monorepo, com três apps (cliente Flutter, balcão
Web, gestão Web), um backend Supabase comum e deploys Web na Vercel.

Restrições que se mantêm durante todo o programa:
- Não alterar permissões RPC (`20261004120000_restrict_rpc_execute`), RLS, dados, `pull_ticket` nem a Capacidade Inteligente.
- Não apagar repositórios. Arquivar apenas, e só no fim.
- Cada fase termina com um **ponto de verificação**. Não se avança sem ele.

## Decisões tomadas (por defeito, para não bloquear)

| Tema | Decisão | Motivo |
|---|---|---|
| Monorepo | Sim, em `fila-certa-platform` (repositório novo) | Pedido explícito; permite partilha de tipos e cliente Supabase |
| Histórico | Preservado com `git subtree` por app | Não perder auditoria nem blame |
| Balcão Web | `apps/counter-web`, derivado da app da equipa | Mesmo código que hoje opera o balcão |
| Gestão Web | `apps/management-web`, derivado da app da equipa | Painel de direcção e configuração |
| Consola do dono | `apps/owner-console`, app própria | Papel e permissões diferentes; deploy separado |
| Cliente Flutter | `apps/customer-mobile` | Projecto Flutter inteiro, sem alterações de código |
| Web do cliente | Mantém GitHub Pages nesta fase | Destino por decidir; não bloqueia o resto |
| Repositórios antigos | **Arquivados**, não apagados, no fim | Reversibilidade |
| Firebase | Fora do programa; revogação é acção do dono | Tarefa de segurança à parte |

## Fases

### Fase 0 — Ponto de regresso (concluída)
- Tag `pre-plataforma-2026-10-05` em cada repositório (staff, cliente, dono), enviada ao GitHub.
- Alterações locais não commitadas detectadas e **não incluídas** no programa:
  - staff: `docs/security.md`
  - cliente: `pubspec.lock`
  - dono: `.github/workflows/ci.yml`, `src/sentry.ts`
- **Saída:** tags existem remotamente. ✔
- **Reversão:** não aplicável (não altera nada).

### Fase 1 — Repositório da plataforma e histórico
- Criar `fila-certa-platform` vazio no GitHub.
- Importar cada app com `git subtree add --prefix=apps/<nome> <repo> <ramo>` (histórico preservado).
- `supabase/` vem do repositório da equipa (migrações, funções).
- **Saída:** `git log --follow` mostra histórico de cada app; nenhuma app foi alterada.
- **Verificação:** contagem de commits por app igual à origem.
- **Reversão:** apagar o repositório novo. Os originais não mudam.

### Fase 2 — Pacotes partilhados
- `packages/types` (tipos de linha da base de dados, hoje duplicados em `src/types.ts` e `lib/models/`).
- `packages/supabase` (cliente Supabase com leitura de configuração única).
- Apenas o que é realmente comum. `ui`, `auth` e `validation` ficam por criar até haver código partilhado real.
- Gerido com npm workspaces (`package.json` na raiz). O Flutter não entra no workspace.
- **Saída:** `counter-web`, `management-web` e `owner-console` compilam com os pacotes partilhados.
- **Verificação:** `npm run build` e `tsc -b` em cada app.
- **Reversão:** reverter o commit de cada app para o import local.

### Fase 3 — Apps Web e Vercel
- `apps/counter-web` e `apps/management-web` com `vercel.json` próprio (rewrites SPA, cabeçalhos).
- `apps/owner-console` com o mesmo padrão.
- Projectos Vercel: `fila-certa` passa a apontar para `apps/counter-web` (Root Directory). Criar `fila-certa-gestao` e `fila-certa-dono`.
- Variáveis de ambiente por projecto (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`), sem BOM.
- **Saída:** cada URL de produção responde 200 em `/`, `/login` e `/dashboard`, com cabeçalhos presentes.
- **Verificação:** `curl` a cada URL, e login de teste no balcão e na gestão.
- **Reversão:** Vercel → deployment anterior → Promote; ou repor o Root Directory.

### Fase 4 — CI/CD
- Um workflow por app em `.github/workflows/`, com filtros de caminho (`paths:`) para que cada app só corra quando muda.
- Job de testes Supabase e Edge Functions a correr uma vez, no `supabase/`.
- Flutter: workflow próprio (análise, testes, build Android de validação).
- **Saída:** um push que toca só em `apps/counter-web` não corre o build de Flutter.
- **Verificação:** runs verdes e filtros confirmados nos logs.
- **Reversão:** reativar os workflows dos repositórios antigos.

### Fase 5 — Segurança Web
- Headers em todos os `vercel.json`: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS.
- CSP: manter em Report-Only até haver verificação na consola de cada app. Depois impor.
- Verificação de exposição: sem `service_role`/`sb_secret_` em bundles; sem source maps.
- **Saída:** CSP imposta sem violações nos ecrãs principais de cada app.
- **Reversão:** trocar `Content-Security-Policy` por `Content-Security-Policy-Report-Only`.

### Fase 6 — Documentação
- `docs/` na raiz da plataforma: `ARCHITECTURE.md`, `AUTHORIZATION.md`, `DEPLOYMENT.md`, `SECURITY.md`, `ENVIRONMENT.md`, `API.md`.
- Caminhos e comandos actualizados para a nova estrutura.
- `README.md` na raiz com a matriz de responsabilidades.
- **Saída:** nenhum caminho antigo nos documentos.

### Fase 7 — Desactivação dos repositórios antigos
- Desactivar GitHub Pages da consola do dono (quando a Vercel estiver validada).
- Arquivar `Fila-certa`, `fila-certa-owner` e `DevSYNOVAR` no GitHub (não apagar).
- **Saída:** apenas `fila-certa-platform` recebe commits; os antigos estão arquivados.
- **Reversão:** desarquivar.

## Acções fora do programa (do dono)

1. Revogar a chave `firebase-adminsdk-fbsvc@filacerta-d74f0` e apagar o JSON do Ambiente de trabalho.
2. Eliminar o projecto Firebase `filacerta-d74f0` (consola do Firebase ou `gcloud auth login`).
3. Decidir o destino da Web do cliente (Vercel ou GitHub Pages).
4. Autorizar a limpeza das senhas de teste de 24 de Setembro na SIAC.

## Estado

| Fase | Estado |
|---|---|
| 0 — Ponto de regresso | Concluída |
| 1 — Repositório e histórico | Concluída (`PaulinoQuicassa/fila-certa-platform`, privado; `apps/staff-web` transitório até à Fase 2; `supabase/` na raiz) |
| 2 — Pacotes partilhados | Pendente |
| 3 — Apps Web e Vercel | Pendente |
| 4 — CI/CD | Pendente |
| 5 — Segurança Web | Pendente |
| 6 — Documentação | Pendente |
| 7 — Desactivação | Pendente |
