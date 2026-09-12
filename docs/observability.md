# Observabilidade (Sentry) — Fase 16

## 1. Arquitectura

| App | Projecto Sentry | DSN | Estado |
|---|---|---|---|
| `fila-certa-staff` (React) | Synovaris / fila-certa-staff | hardcoded em `src/sentry.ts` (não secreta) | Já existia; redacção e integrações corrigidas nesta ronda |
| `projectogestaodefilas` (Flutter, cliente) | Synovaris / fila-certa-client | hardcoded em `lib/main.dart` (não secreta) | Já existia; redacção adicionada nesta ronda |
| `fila-certa-owner` (React) | — (nenhum projecto próprio ainda) | `VITE_SENTRY_DSN` (variável de ambiente, opcional) | Novo nesta ronda — sem DSN configurada, `initSentry()` é um no-op seguro |
| Edge Functions (`supabase/functions/`) | Synovaris / fila-certa-staff (reaproveita a mesma DSN do React) | hardcoded em `supabase/functions/_shared/sentry.ts` | Novo nesta ronda — sem SDK, POST directo ao protocolo de envelope do Sentry |

Cada evento das Edge Functions leva as tags `runtime: "edge-function"` e
`function: "<nome-da-função>"`, e o campo `server_name` — dá para
filtrar no Sentry por "erros que vêm do backend" sem misturar com os
do React, mesmo partilhando o mesmo projecto.

## 2. O que passou a ser monitorizado nesta ronda

- **Autenticação**: falhas de login (staff e dono) — `AuthContext.tsx`
  em ambos os React apps.
- **MFA** (dono): falha ao iniciar a inscrição TOTP, falha ao carregar
  o factor para o desafio de login — `MfaEnroll.tsx`/`MfaChallenge.tsx`.
- **OTP/telefone** (cliente Flutter): `sign_up`, `sign_in`,
  `send_otp`, `verify_otp` — `auth_service.dart`, com a tag `flow` a
  distinguir qual.
- **RPCs críticas**: qualquer chamada RPC falhada nos dois React apps
  (`lib/queue.ts` no staff, `lib/admin.ts` no dono) — antes só as
  leituras via subscrição reportavam, as acções (tirar senha, chamar,
  criar/remover instituição/filial/balcão/staff/dono) não.
- **Sessão do dono**: uma falha ao determinar o estado de MFA/perfil no
  arranque da sessão já não fica presa num ecrã em branco sem registo
  (bug real encontrado nesta revisão, corrigido em `AuthContext.tsx`).
- **Webhooks**: erro a processar uma mensagem do WhatsApp
  (`whatsapp-webhook/index.ts`).
- **Motor de notificações**: qualquer falha de envio (Twilio/Meta),
  com tags `channel`/`priority`/`provider` (`_shared/notifications/engine.ts`).

## 3. Redacção (Fase 16: nunca OTP/password/tokens/telefone completo)

Todos os quatro pontos de `Sentry.init`/`captureException` aplicam a
mesma regra, cada um na sua linguagem:

- Qualquer chave de contexto que pareça `token`/`password`/`senha`/
  `secret`/`otp`/`código` é substituída por `[redigido]` antes de sair
  -- mesmo que alguém no futuro passe isso por engano num `extra`.
- Qualquer string que pareça um número de telefone (7+ dígitos
  seguidos, com ou sem `+`/espaços/hífens) fica só com os 3 primeiros
  caracteres visíveis.
- Qualquer string que pareça um JWT (`eyJ...`) é removida por completo.
- `sendDefaultPii = false` em todos os SDKs (nunca captura IP/cookies/
  headers de autenticação automaticamente).

Isto é uma **rede de segurança**, não uma licença para passar dados
sensíveis propositadamente — nenhum ponto de instrumentação desta
ronda passa telefone completo, password, token ou código OTP/MFA como
argumento.

## 4. Alertas — configuração manual pendente

O Sentry não tem uma API/CLI utilizável sem um token de organização
(que não existe nesta conversa) — os alertas abaixo têm de ser criados
manualmente em **Sentry → Alerts → Create Alert**, no projecto
"Synovaris / fila-certa-staff" (cobre React + Edge Functions) e,
depois de configurado, em "fila-certa-client":

| Alerta | Condição sugerida |
|---|---|
| Falhas de OTP | `tags.flow:send_otp OR tags.flow:verify_otp`, subida de contagem de eventos (ex.: >20 em 10 min) |
| Falhas Twilio/Meta | `tags.channel:sms OR tags.channel:whatsapp` em `notification-engine`, subida de contagem |
| Notificações failed | mesmo filtro acima, agrupado por `tags.priority:critical` e `tags.priority:high` com limiar mais baixo (essas nunca devem falhar em silêncio) |
| Erros de autorização | issues com mensagem a conter "não é dono"/"apenas clientes autenticados"/`not-owner`/`no-staff-profile`, subida de contagem |
| Erros 5xx | issues das Edge Functions (`tags.runtime:edge-function`) com nível `error`, qualquer subida |
| Degradação de latência | não aplicável ainda -- `tracesSampleRate` está a 0 em todos os SDKs (só rastreio de erros); activar tracing amostrado é um passo à parte, fora do âmbito desta ronda |

## 5. Pendente de configuração externa

1. Criar um projecto Sentry próprio para `fila-certa-owner` (ou decidir
   reutilizar deliberadamente o de `fila-certa-staff` como as Edge
   Functions fazem) e definir `VITE_SENTRY_DSN` como secret do GitHub
   Actions + no ambiente de build.
2. Criar os alertas da secção 4 nos projectos Sentry existentes.
3. Confirmar quota/plano Sentry suporta o volume esperado de eventos
   das Edge Functions (novo emissor de eventos que não existia antes).
