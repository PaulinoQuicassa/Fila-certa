# Ambientes e variáveis

## Ambientes

| Ambiente | Onde corre | Base de dados | Notas |
|---|---|---|---|
| Local | `npm run dev` | Supabase de produção (URL em `.env.local`) | Não há Supabase local configurado para a app da equipa |
| Preview | Vercel, por pull request (pendente) | Produção | Ainda não ligado ao Git |
| Produção | Vercel (`fila-certa-pi.vercel.app`) e GitHub Pages | Produção | Base de dados única para todos os ambientes |

Não existe ambiente de teste separado para a base de dados (o pedido de branch foi recusado em 2026-10-04). Testes de escrita são feitos com contas de teste e com cuidado.

## Variáveis da app da equipa (Vite)

Lidas em build time com o prefixo `VITE_` (ficam visíveis no bundle):

| Variável | Obrigatória | Onde | Notas |
|---|---|---|---|
| `VITE_SUPABASE_URL` | sim | `.env.local`; Vercel Production; CI | |
| `VITE_SUPABASE_ANON_KEY` | sim | idem | Chave publishable |
| `VITE_STATION_EMAIL` | para a Estação | `.env.local` | Conta de quiosque |
| `VITE_STATION_PASSWORD` | para a Estação | `.env.local` | Nunca em CI público |

Modelo: `.env.example`. Valores reais: `.env.local` (ignorado pelo Git).

## Variáveis que não podem ter prefixo `VITE_`

Qualquer variável com `VITE_` é pública. Segredos (service_role, tokens Twilio e Meta) ficam só em Edge Functions (`supabase secrets`) e em `.env.secrets.local` (ignorado pelo Git).

## Verificar antes de publicar

```bash
grep -rn "service_role\|sb_secret_" dist/ && echo "ERRO: segredo no bundle" || echo "ok"
```

## Problemas já vistos

- Build sem `VITE_SUPABASE_URL` → ecrã em branco (sem erro visível ao utilizador).
- Build com `--base=/Fila-certa/` (GitHub Pages) → assets e rotas quebram se o host for a raiz.
- `vercel link` altera `.env.local` (acrescenta `VERCEL_OIDC_TOKEN`) e `.gitignore`. Verificar depois de qualquer `vercel link`.
