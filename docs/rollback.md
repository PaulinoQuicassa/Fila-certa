# Rollback — Fila Certa

Procedimento de reversão para os dois repositórios, criado na Ronda 4
(CI/CD) de `docs/commercial-readiness.md`. Nenhum destes passos é
automatizado — reversão é sempre uma decisão humana deliberada, nunca
um passo do pipeline.

## Frontend (React `fila-certa-staff` / Flutter `projectogestaodefilas`)

O deploy publica sempre no branch `gh-pages` do respectivo repositório,
um commit por deploy (`deploy: <sha do commit de origem>`). Reverter é
sempre reproduzível a partir do histórico do `gh-pages`, sem depender
de nenhum artefacto guardado à parte:

```bash
# ver os deploys recentes (cada um corresponde a um commit em master/main)
git log --oneline origin/gh-pages

# reverter para um deploy anterior específico
git fetch origin gh-pages
git push origin <sha-do-deploy-anterior>:gh-pages --force
```

`--force` é necessário aqui porque `gh-pages` é um branch só de
publicação (não histórico de código a preservar) — mas confirmar
sempre com `git log` antes qual SHA é o correcto, o push é imediato
para produção.

Alternativa mais simples quando o problema está no próprio código
(não só no build publicado): reverter o commit em `master`/`main` e
deixar o pipeline normal de CI/CD publicar a versão revertida (mesmo
caminho de sempre, sem atalhos manuais).

## Base de dados (Supabase, projecto `qdfpqispcntitvczybfl`)

**Reversão de código nunca implica reversão de dados.** As migrations
em `supabase/migrations/` são aplicadas sequencialmente e destinadas a
avançar, não a recuar — não existe `down migration` automática neste
projecto.

- **Migração aditiva** (nova tabela/coluna/função, sem alterar dados
  existentes): reverter o código que a usa é suficiente na maioria dos
  casos — a estrutura nova fica sem uso, inofensiva.
- **Migração destrutiva** (`DROP COLUMN`, `DROP TABLE`, renomear,
  alterar tipo de coluna com perda de precisão, `TRUNCATE`): **não
  reverter às cegas**. Antes de qualquer alteração deste tipo em
  produção:
  1. Correr `scripts/backup-supabase.mjs` (dump completo das tabelas
     de negócio + lista de utilizadores Auth) imediatamente antes.
  2. Escrever a migration de reversão manualmente, específica para o
     caso (não existe automatismo genérico que reconstrua dados
     apagados).
  3. Aplicar a reversão via o mesmo processo já usado durante toda a
     migração (Management API / SQL directo), nunca editando o
     histórico de migrations já aplicado.
- **Nenhuma migration é reaplicada automaticamente a produção pelo
  CI/CD** (decisão deliberada da Ronda 4) — o Postgres efémero do CI
  só prova que as migrations são reproduzíveis do zero num ambiente
  limpo, não substitui revisão humana antes de produção.

## Quando NÃO reverter

Se o problema for um erro de utilização (dados errados inseridos por
um utilizador real, não um bug), reverter código ou migrations não
ajuda — é um caso de correcção de dados pontual (`UPDATE`/`DELETE`
manual, com backup prévio), não de rollback de deploy.
