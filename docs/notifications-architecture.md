# Motor de notificações + Twilio — arquitectura, configuração e estado

Cobre as Fases 7-14 do pedido de hardening de produção (2026-09-12):
autenticação por telefone/OTP, integração Twilio (SMS e WhatsApp), e o
motor de notificações orientado a eventos com idempotência e
prioridades. Ver também `docs/whatsapp-channel.md` (canal conversacional
Meta, que continua a existir a par disto — secção 4 explica porquê).

## 1. Visão geral

```
Evento de Negócio (fila muda, OTP pedida)
        │
        ▼
sendNotification() ──► notification_deliveries (Postgres, event_id único = idempotência)
        │
        ▼
providerRouter (escolhe fornecedor por canal + fallback opcional)
        │
   ┌────┴─────┐
   ▼          ▼
 SMS       WhatsApp
Twilio    Meta (hoje) | Twilio (Fase 10, pronto por código)
        │
        ▼
update_notification_status (estado real: sent/delivered/failed/read)
```

Código em `supabase/functions/_shared/notifications/`:

| Ficheiro | Papel |
|---|---|
| `types.ts` | Contratos `SmsProvider`/`WhatsAppProvider` — qualquer fornecedor novo implementa isto, nada mais muda |
| `twilioSmsProvider.ts` | Fornecedor real de SMS via Twilio (Messages API) |
| `twilioWhatsAppProvider.ts` | Fornecedor real de WhatsApp via Twilio (Content API — templates aprovados) |
| `metaWhatsAppProvider.ts` | Adapta o cliente Meta já existente (`_shared/meta.ts`) à mesma interface |
| `providerRouter.ts` | Escolhe o fornecedor principal por canal (env var) + fallback (Fase 13) |
| `engine.ts` | `sendNotification()` — ponto único de envio, idempotente, grava estado real |

Migração: `supabase/migrations/20260912120000_notification_engine.sql`
(tabela `notification_deliveries` + `record_notification_attempt` +
`update_notification_status`, ver Fase 14 abaixo).

## 2. Autenticação por telefone/OTP (Fase 7) — já implementada, sem duplicar

O telefone já é a identidade principal do cliente: o Flutter regista-se
por `auth.users.phone` + OTP nativo do **Supabase Auth**
(`phone_confirmed_at`), com a ponte para o WhatsApp feita em
`20260912100000_phone_verified_whatsapp_link.sql`
(`set_whatsapp_notifications`, `whatsapp_notifications_status`,
`record_phone_verified_event`).

**Decisão deliberada**: o envio/validação da própria OTP de login
**não** passa por este motor de notificações nem por
`twilioSmsProvider.sendOtp()` — usa o fornecedor Twilio nativo da Auth
do Supabase (Dashboard → Authentication → Providers → Phone →
Twilio/Twilio Verify), que já implementa correctamente expiração,
limite de tentativas, reenvio e rate limiting ao mesmo nível de
segurança de qualquer outro mecanismo de Auth. Reimplementar isso à
mão neste motor duplicaria uma solução já existente e testada,
exactamente o que a Fase 1 do pedido pede para evitar. `sendOtp()`
existe na interface `SmsProvider` só para um envio manual de código
fora do login (ex.: um fluxo futuro que precise mandar um código sem
passar pela Auth) — não está ligado a nenhum ecrã hoje.

**Pendente de configuração externa**: activar o provider Twilio na
Auth do Supabase precisa de, no [Twilio Console](https://console.twilio.com):
1. Uma conta Twilio com **Account SID** e **Auth Token**.
2. Um **Messaging Service** (recomendado) ou um número Twilio próprio para SMS.
3. Colar essas credenciais em Supabase Dashboard → Authentication →
   Providers → Phone → activar Twilio → Account SID / Auth Token /
   Messaging Service SID.
4. Formato aceite pela app: `+244 9XXXXXXXX` (E.164) — o Flutter já
   converte `09XXXXXXXX` digitado localmente antes de enviar.

Sem isto configurado, o envio de OTP continua a usar o que estiver
definido por omissão no projecto Supabase (ou falha, se nada estiver
configurado) — nenhum código deste repositório pode ligar isto
sozinho, é puramente configuração no painel do Supabase.

## 3. Twilio SMS (Fases 8/9)

`twilioSmsProvider.ts` implementa `SmsProvider` com chamadas reais à
API de Mensagens da Twilio (`POST /Accounts/{Sid}/Messages.json`).
Usado hoje por `sendSms()` (`providerRouter.ts`) sempre que o motor de
notificações manda um evento pelo canal `sms` — nenhum canal chama SMS
directamente ainda (o canal WhatsApp continua o principal), mas a
arquitectura já está pronta: basta uma Edge Function chamar
`sendNotification({ channel: "sms", ... })`.

**Segredos necessários** (`supabase secrets set ...`, nunca no
frontend/Git):

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_SERVICE_SID=...   # ou TWILIO_SMS_FROM=+1... (um número só)
TWILIO_STATUS_CALLBACK_URL=...     # ver secção 8.1 -- URL pública desta mesma Edge Function (twilio-status-callback)
```

## 4. Twilio WhatsApp (Fase 10) — a par do Meta, não substituindo

O canal conversacional (`whatsapp-webhook`, botões/listas, máquina de
estados em `flows.ts`) continua sobre a **Meta Cloud API** — é o que já
está configurado e aprovado em produção, e reescrevê-lo para a Twilio
seria uma migração à parte, sem ganho para o pedido actual (notificar o
cliente sobre a fila). `twilioWhatsAppProvider.ts` implementa a mesma
interface `WhatsAppProvider` que `metaWhatsAppProvider.ts` — trocar de
fornecedor é uma variável de ambiente, nunca uma reescrita de código:

```
WHATSAPP_PROVIDER=meta      # omitir = meta (omissão actual, já em produção)
WHATSAPP_PROVIDER=twilio    # activa a Twilio como fornecedor principal
WHATSAPP_PROVIDER_FALLBACK=twilio   # Fase 13: tenta a Twilio se a Meta falhar, sem trocar a principal
```

**Segredos necessários para activar a Twilio WhatsApp** (nenhum
inventado — têm de vir da Twilio Console depois de aprovação real):

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+1...             # Sender aprovado no Twilio WhatsApp Business Platform
TWILIO_WHATSAPP_TEMPLATE_QUEUE_CALLED=HX...     # Content SID do template "queue_called" aprovado
TWILIO_WHATSAPP_TEMPLATE_QUEUE_NEAR_TURN=HX...  # Content SID do template "queue_near_turn" aprovado
TWILIO_STATUS_CALLBACK_URL=...                  # ver secção 8.1
```

Cada `templateKey` lógico usado pelo motor (`QUEUE_CALLED`,
`QUEUE_NEAR_TURN`) precisa do seu próprio `TWILIO_WHATSAPP_TEMPLATE_*`;
uma variável em falta faz esse envio falhar de forma explícita (nunca
silenciosa) até estar configurada.

## 5. Motor de eventos e idempotência (Fase 11)

`engine.sendNotification()` é chamado hoje por
`whatsapp-notifier/index.ts` para os dois eventos existentes
(`queue_called:<ticket_id>`, `queue_near_turn:<ticket_id>`). O
`eventId` é a chave de idempotência: a tabela `notification_deliveries` tem
`event_id unique`, e `record_notification_attempt` faz o
`insert ... on conflict (event_id) do nothing` — 1 evento nunca produz
duas mensagens, mesmo com reentrega de webhook, retry de rede, ou duas
chamadas concorrentes (fecha a mesma classe de condição de corrida já
corrigida em `pull_ticket`/`owner_remove_owner`, mas ao nível dos
eventos de notificação). O código anterior fazia essa verificação com
um `SELECT` antes do `INSERT`, sem garantia nenhuma contra corrida —
foi substituído, não apenas complementado.

## 6. Prioridades (Fase 12)

| Prioridade | Quando |
|---|---|
| `critical` | OTP/segurança — hoje tratado pela Auth nativa do Supabase, fora deste motor (secção 2) |
| `high` | "É a sua vez" (`queue_called`) |
| `medium` | "Está quase" (`queue_near_turn`) |
| `low` | Avisos informativos gerais — nenhum implementado ainda |

A prioridade fica gravada por linha em `notification_deliveries.priority`
e tem um índice próprio (`notification_deliveries_pending_idx`, por
prioridade+data, só para linhas `queued`/`failed`) — pronto para um
futuro processo de reprocessamento/retry ler primeiro o que é
`critical`/`high`, nunca atrás de `low`. Não existe ainda um worker de
retry automático (fica para uma iteração seguinte, ver secção 9) — hoje
cada tentativa é síncrona, dentro da própria chamada do
`whatsapp-notifier`.

## 7. Fallback entre fornecedores (Fase 13)

`providerRouter.ts` tenta sempre o fornecedor principal primeiro; só
tenta o de reserva se `*_PROVIDER_FALLBACK` estiver definido E for
diferente do principal — nunca inventa um segundo fornecedor. Hoje o
único par real é WhatsApp Meta↔Twilio (ambos implementados); para SMS
só existe a Twilio, por isso `SMS_PROVIDER_FALLBACK` fica pronto na
arquitectura mas sem um segundo fornecedor real para apontar.

## 8. Tabela `notification_deliveries` (Fase 14)

Colunas exactamente como pedido: `event_id` (chave de idempotência,
não pedida explicitamente mas necessária para a garantia acima),
`user_id`, `channel`, `provider`, `provider_message_id`, `status`,
`priority`, `created_at`, `sent_at`, `delivered_at`, `failed_at`,
`error_code`, `error_message`, `retry_count`. Sem conteúdo sensível
(nunca o corpo da mensagem nem a OTP) — só o necessário para
observabilidade e diagnóstico. RLS activa, sem nenhuma policy (só
`service_role`, mesmo padrão de `audit_logs`/`whatsapp_message_log`) —
não existe hoje nenhum ecrã de cliente que precise de ler isto
directamente.

### 8.1 Callback de estado da Twilio (`twilio-status-callback`)

Edge Function nova (`supabase/functions/twilio-status-callback/`) que
recebe os callbacks assíncronos de entrega da Twilio (SMS e WhatsApp)
e actualiza `notification_deliveries` com o estado real
(`delivered`/`read`/`failed`) — antes disto, o estado gravado ficava
parado em `sent` para sempre (o que a API aceitou no pedido inicial),
nunca confirmando se a mensagem chegou de facto (Fase 10: "nunca
considerar mensagem enviada apenas porque a API aceitou o request").

- Assinatura verificada (`_shared/twilioSignature.ts`, HMAC-SHA1 sobre
  a URL configurada + parâmetros do formulário, mesmo algoritmo
  documentado pela Twilio) antes de processar seja o que for.
- Idempotente por construção: procura a linha por
  `provider_message_id` (o `MessageSid` da Twilio) e nunca sobrepõe um
  estado já terminal (`delivered`/`read`/`failed`) — um callback
  repetido ou fora de ordem não altera duas vezes o estado (Fase 20).
- `twilioSmsProvider.ts`/`twilioWhatsAppProvider.ts` já enviam
  `StatusCallback=<TWILIO_STATUS_CALLBACK_URL>` em cada pedido — não é
  preciso configurar nada na consola da Twilio para além do secret.

**Pendente de configuração externa**: `TWILIO_STATUS_CALLBACK_URL` tem
de ser a URL pública real desta função depois de publicada (`supabase
functions deploy twilio-status-callback`), tipicamente
`https://<projecto>.supabase.co/functions/v1/twilio-status-callback` —
sem isto definido, os envios continuam a funcionar, só ficam parados em
`sent` (nunca chegam a `delivered`).

## 9. O que fica para uma iteração seguinte (não implementado agora)

- Um **worker de retry** que releia `notification_deliveries_pending_idx`
  e tente de novo os `failed` com backoff — hoje o retry_count
  incrementa a cada falha, mas nada volta a tentar automaticamente
  ainda.
- **Callback de estado da Meta** (webhook de `statuses`, distinto do
  `twilio-status-callback` da secção 8.1) — a Meta Cloud API só chega
  ao `whatsapp-webhook` existente; hoje não actualiza
  `notification_deliveries` (o `metaWhatsAppProvider.getDeliveryStatus`
  devolve sempre `sent`, ver comentário no próprio ficheiro).
- Um canal `low` (avisos informativos gerais) — não existe nenhum
  evento desse tipo ainda no produto.

## 10. Testes

```
deno test --config supabase/functions/deno.json --allow-env supabase/functions/
```

Cobrem (sem nenhuma credencial real): construção do pedido Twilio,
mapeamento de erros da API para falha real (nunca sucesso silencioso),
credencial em falta a falhar de forma explícita, e o comportamento de
fallback do `providerRouter` (principal falha → reserva assume,
reportado com `usedFallback: true`).
