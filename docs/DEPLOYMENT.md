# Deploy

## Fluxo alvo

```
developer → git push → GitHub → Vercel (build) → produção
                                     ↓
                           preview por pull request
```

## Estado actual (2026-10-04)

| App | Como é publicada hoje | Notas |
|---|---|---|
| App da equipa (`fila-certa-staff`) | **Vercel, manual**: `npx vercel deploy --prod --scope synovaris` | Projecto `fila-certa` ligado a esta pasta via `.vercel/` (não commitado). Também é publicada pelo CI no GitHub Pages (`gh-pages`) |
| Consola do dono (`fila-certa-owner`) | GitHub Pages | Sem `vercel.json` |
| App do cliente Web (`DevSYNOVAR`) | GitHub Pages (`--base-href`) | Android: APK de validação do CI |
| Base de dados | Migrações Supabase aplicadas à mão, via MCP | Registo em `supabase/migrations/` |

## Vercel

Configuração em `vercel.json`:

- `framework: vite`, `buildCommand: npm run build`, `outputDirectory: dist`, `installCommand: npm ci`.
- `rewrites`: todas as rotas para `/index.html` (SPA).
- `headers`: cabeçalhos de segurança; CSP em `Content-Security-Policy-Report-Only`.

Upload ignora o que está em `.vercelignore` (`.env*`, `node_modules`, `dist`, `docs`, `supabase`, `scripts`). A build usa só `src` e `vite.config.ts`.

Variáveis de ambiente (painel da Vercel, ambiente **Production**):

| Variável | Tipo | Valor |
|---|---|---|
| `VITE_SUPABASE_URL` | Config | URL do projecto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Config | Chave publishable (pública por desenho) |

Sem estas variáveis a build sai sem configuração e a app fica em branco (`src/supabase.ts` lança logo no arranque). Por isso o CI do GitHub Pages verifica se o URL ficou embutido no bundle.

## Passos para ligar a Vercel ao GitHub (pendente)

1. No painel da Vercel: projecto `fila-certa` → **Settings → Git** → ligar o repositório `PaulinoQuicassa/Fila-certa`, branch `master`.
2. Confirmar que os pushes para `master` criam deployments de produção e os pull requests criam previews.
3. Só depois de validado: remover o job `deploy` do GitHub Pages em `.github/workflows/ci.yml` e a base `--base=/Fila-certa/`.

Esta ligação instala uma integração no repositório GitHub; por isso fica à espera de aprovação.

## Verificação depois de cada deploy

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://fila-certa-pi.vercel.app/login   # esperado: 200
curl -sI https://fila-certa-pi.vercel.app/ | grep -i content-security           # esperado: presente
```

Mais uma verificação manual no navegador: abrir `/login` directamente, fazer refresh em `/dashboard` e confirmar que a consola não tem erros de CSP.

## Rollback de deploy

Vercel: **Deployments → deployment anterior → Promote to Production**. Não toca na base de dados.

Rollback de base de dados: ver `security-rpc-execute-review.md` e `supabase/rollbacks/`.

## Migrações da base de dados

- Ficheiros em `supabase/migrations/`, com timestamp.
- Ficheiros de rollback fora de `migrations/` (`supabase/rollbacks/`), porque o CLI aplicaria qualquer ficheiro dentro dessa pasta.
- Aplicar só depois de revisão do SQL exacto e com SHA-256 registado.
