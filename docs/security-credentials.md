# Credenciais de staff — estado e rotação

## O que aconteceu

Uma auditoria de segurança em 2026-09-12 encontrou uma password fixa,
partilhada pelas 12 contas reais de staff (das 6 instituições piloto:
BAI, Banco Sol, BCI, BFA, BPC, SIAC), commitada em texto simples no
`README.md` e em 8 scripts deste repositório. Como essas contas já
estavam a ser usadas em produção (não só em teste), isto foi
classificado como achado **Crítico**: qualquer pessoa com acesso ao
repositório conseguia autenticar-se como gestor/agente de qualquer uma
das 6 instituições reais.

## O que já foi corrigido (código)

- Nenhum script ou documento deste repositório tem hoje uma password
  hardcoded. `scripts/lib/test-env.mjs` exige `TEST_STAFF_PASSWORD` (e
  `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`) por
  variável de ambiente -- qualquer script que precise de autenticar como
  staff falha alto e claro se a variável não estiver definida, em vez de
  usar um valor por omissão.
- Nenhum script tem por omissão a URL/chave de **produção** -- antes
  disto, correr um script de teste sem definir `SUPABASE_URL` acabava
  silenciosamente a apontar para o projecto real.
- `scripts/rotate-staff-passwords.mjs` (novo) -- rotaciona a password
  das 12 contas reais de staff via API Admin do Supabase, sem nunca
  imprimir a password recebida.

## O que ainda falta -- só o dono da conta Supabase consegue fazer

**Rodar já a password das 12 contas reais.** Considerar a password
antiga comprometida até isto ser feito -- o código estar corrigido não
muda a password que já está activa nas contas reais.

```
SUPABASE_URL=https://qdfpqispcntitvczybfl.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<a chave service_role do Dashboard> \
SUPABASE_ANON_KEY=sb_publishable_HLelr-FOPvSL9a5w8_feUw_FfKIrOoQ \
TEST_STAFF_PASSWORD=<uma password nova, forte, escolhida por si> \
node scripts/rotate-staff-passwords.mjs
```

A `service_role key` está em Project Settings → API do Dashboard do
Supabase -- nunca commitada nem partilhada nesta conversa. Escolha uma
password forte e nova (nunca a antiga, nem uma palavra do dicionário) --
continua a ser partilhada pelas 12 contas (piloto sem clientes reais,
só staff de confiança), mas já não pode ficar visível a quem tiver
acesso ao código.

Depois de rodar, para correr qualquer script de teste (`scripts/test-*.mjs`)
ou o seed, defina as mesmas variáveis de ambiente com a password nova:

```
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
TEST_STAFF_PASSWORD=<a mesma password nova> \
node scripts/test-phase9.mjs
```

## CI

O scanner de segredos do CI (`.github/workflows/ci.yml`) foi reforçado
para também recusar o padrão da password antiga e referências a
`SUPABASE_URL`/`ANON_KEY` com fallback para a URL/chave reais de
produção dentro de `scripts/` -- ver esse workflow para os padrões
exactos.
