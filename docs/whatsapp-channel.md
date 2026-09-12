# Canal WhatsApp — arquitectura, configuração e operação

O WhatsApp é **mais um canal de acesso ao Fila Certa**, não uma segunda
aplicação. Toda a lógica de fila (criar senha, calcular posição, tempo
estimado, cancelar) continua a viver nas mesmas RPCs Postgres que a app
e o site já usam — `pull_ticket`, `waiting_ahead_count`,
`branch_wait_stats`, `cancel_ticket`. O canal WhatsApp só resolve
**identidade** (telefone → conta) e **transporte** (Meta ↔ Supabase).

```
WhatsApp → Meta Cloud API → whatsapp-webhook (Edge Function) → RPCs existentes → Postgres
                                                                       │
tickets muda (INSERT/UPDATE) → Database Webhook → whatsapp-notifier → Meta Cloud API → WhatsApp
```

## 1. Identidade: telefone → cidadão

Cada número de WhatsApp fica ligado a uma conta real (`auth.users`),
criada automaticamente na primeira interacção, com um email sintético
determinístico (`<dígitos-do-telefone>@whatsapp.filacerta.local`,
nunca usado para login por password). A partir daí, todas as chamadas
às RPCs de fila correm com uma sessão real dessa conta — RLS funciona
sem nenhuma alteração, exactamente como quando é a app do cidadão a
chamar. Ver `supabase/functions/_shared/citizenSession.ts`.

Tabelas novas (migração `20260910110000_whatsapp_channel.sql`):

| Tabela | Para quê |
|---|---|
| `whatsapp_contacts` | telefone ↔ `auth.users.id` |
| `whatsapp_conversation_state` | estado da conversa (a Edge Function não tem memória entre chamadas) |
| `whatsapp_message_log` | deduplicação de reentregas da Meta + auditoria mínima |
| `services` | catálogo de serviços por instituição — não existia no Supabase (estava só *hardcoded* no React/Flutter); criado para o WhatsApp não ser uma terceira cópia |

Nenhuma delas é acedida por `anon`/`authenticated` — só pelo
`service_role`, dentro das Edge Functions.

## 2. Estrutura do código

```
supabase/functions/
├── _shared/
│   ├── meta.ts               assinatura HMAC, cliente Graph API, registo de templates
│   ├── citizenSession.ts     resolve/cria o contacto, gera a sessão da conta ligada
│   ├── conversationState.ts  ler/gravar o estado da conversa
│   └── messageLog.ts         deduplicação + eventos de auditoria
├── whatsapp-webhook/
│   ├── index.ts              handshake GET + recepção POST (só transporte)
│   ├── parseIncoming.ts      extrai {from, messageId, replyId, text} do payload da Meta
│   └── flows.ts              máquina de estados -- só chama RPCs existentes
└── whatsapp-notifier/
    └── index.ts               chamado pelo Database Webhook, nunca pelo público
```

## 3. Fluxo de estados

```
WELCOME ──(1)──► SELECT_INSTITUTION ──► SELECT_SERVICE ──► CONFIRM_QUEUE ──► (cria a senha) ──► WELCOME
        ──(2)──► ver senha activa (sem mudar de estado)
        ──(3)──► contacto humano (sem mudar de estado)

Com senha activa: AWAIT_CANCEL_CONFIRM ──sim──► cancela ──► WELCOME
                                       ──não──► volta a mostrar a senha
```

Só botões/listas (`interactive` messages) — nunca texto livre
interpretado, reduz ambiguidade e risco no MVP.

## 4. Configuração na Meta (passo a passo)

1. Criar uma app em [developers.facebook.com](https://developers.facebook.com) → tipo "Business" → adicionar o produto **WhatsApp**.
2. No painel do produto WhatsApp, anotar o **Phone Number ID** (número de teste fornecido automaticamente, ou o número real depois de verificado).
3. Gerar um **token de acesso** (temporário para testes, ou permanente via um System User depois de aprovado para produção).
4. Em **App Settings → Basic**, anotar o **App Secret**.
5. Escolher um **Verify Token** à sua escolha (uma string qualquer, só tem de bater certo dos dois lados) — é o `META_VERIFY_TOKEN` abaixo.
6. Criar os templates (secção 6) e aguardar aprovação da Meta antes de os usar em produção.

## 5. Variáveis de ambiente (secrets do Edge Function, nunca no repo/frontend)

```
supabase secrets set META_ACCESS_TOKEN=...
supabase secrets set META_APP_SECRET=...
supabase secrets set META_VERIFY_TOKEN=...
supabase secrets set META_PHONE_NUMBER_ID=...
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` já
ficam automaticamente disponíveis a qualquer Edge Function do projecto
— não precisam de ser definidas manualmente.

`whatsapp-notifier` já não chama `sendTemplate` directamente — passa
pelo motor de notificações (`_shared/notifications/engine.ts`), que
grava o estado real de cada envio e permite trocar/adicionar um
fornecedor (Twilio, como fallback ou principal) sem tocar neste canal.
Ver `docs/notifications-architecture.md`.

## 6. Templates Meta

Mensagens dentro da janela de 24h (depois de o cidadão escrever)
usam `text`/`interactive` livremente — é o que `flows.ts` já faz. As
duas notificações que o **servidor inicia** sem o cidadão ter escrito
nada (aviso de proximidade, chamada) só podem sair como **template
aprovado**, fora dessa janela:

| Nome lógico (código) | Nome/idioma no Meta Business Manager | Variáveis |
|---|---|---|
| `QUEUE_NEAR_TURN` | `queue_near_turn` / `pt_PT` | `{{1}}` = código da senha |
| `QUEUE_CALLED` | `queue_called` / `pt_PT` | `{{1}}` = código da senha, `{{2}}` = balcão |

Os nomes reais têm de ser criados e aprovados no Meta Business
Manager **antes** de os usar — o registo em
`supabase/functions/_shared/meta.ts` (`TEMPLATES`) é só um mapa; se o
nome/idioma não existir do lado da Meta, o envio falha.

## 7. Ligar as notificações automáticas (Database Webhook)

**Só em produção** — não corre como migração automática porque o URL
da função é específico do ambiente (correr isto no CI apontaria para
produção a partir dos testes locais). Depois de publicar
`whatsapp-notifier` (secção 8), corra no SQL Editor:

```sql
create trigger tickets_whatsapp_notify
after insert or update on public.tickets
for each row
execute function supabase_functions.http_request(
  'https://qdfpqispcntitvczybfl.supabase.co/functions/v1/whatsapp-notifier',
  'POST',
  '{"Content-type":"application/json","Authorization":"Bearer sb_publishable_HLelr-FOPvSL9a5w8_feUw_FfKIrOoQ"}',
  '{}',
  '5000'
);
```

A chamada é assíncrona (`pg_net`) — nunca bloqueia nem falha
`call_next`/`pull_ticket`/etc. se a função estiver em baixo.

## 8. Deployment

```bash
# ligar o projecto local ao Supabase (uma vez)
supabase link --project-ref qdfpqispcntitvczybfl

# aplicar as migrações novas (tabelas + pull_ticket com channel)
supabase db push

# publicar as duas funções
supabase functions deploy whatsapp-webhook
supabase functions deploy whatsapp-notifier

# definir os secrets (secção 5)
supabase secrets set META_ACCESS_TOKEN=... META_APP_SECRET=... META_VERIFY_TOKEN=... META_PHONE_NUMBER_ID=...
```

No Meta Business Manager, configurar o webhook do produto WhatsApp com:
- **Callback URL**: `https://qdfpqispcntitvczybfl.supabase.co/functions/v1/whatsapp-webhook`
- **Verify Token**: o mesmo valor de `META_VERIFY_TOKEN`
- **Campos subscritos**: `messages`

Por fim, correr a trigger da secção 7.

## 9. Testes

`supabase/functions/_shared/meta.test.ts` e
`supabase/functions/whatsapp-webhook/parseIncoming.test.ts` cobrem a
parte **testável sem credenciais reais da Meta**: verificação de
assinatura (aceita/rejeita/corpo alterado) e extracção de mensagens de
vários formatos (texto, botão, lista, notificação de estado, payload
malformado). Correr com:

```bash
deno test supabase/functions/
```

**Não é possível** testar o fluxo end-to-end contra a Meta real sem uma
app/número configurado (secção 4) — depois de configurado, o caminho
de teste manual é: enviar "oi" para o número de teste → percorrer os
botões → confirmar que aparece uma senha nova nas outras apps (app do
cliente, dashboard do gestor) com `channel = 'whatsapp'`.

## 10. Troubleshooting

| Sintoma | Causa provável |
|---|---|
| Meta não consegue verificar o webhook (handshake falha) | `META_VERIFY_TOKEN` não bate certo, ou a função não está publicada |
| `401 Invalid signature` em todos os pedidos | `META_APP_SECRET` errado/não definido como secret |
| Mensagens duplicadas processadas duas vezes | Verificar se `whatsapp_message_log` tem mesmo a chave primária em `meta_message_id` (deduplicação depende disto) |
| "Está quase"/"É a sua vez" nunca chegam | Confirmar que a trigger da secção 7 existe (`\d tickets` no SQL Editor deve mostrar `tickets_whatsapp_notify`) e que os templates estão aprovados na Meta |
| Erro `could not generate session` | `SUPABASE_SERVICE_ROLE_KEY` em falta ou inválida nos secrets da função |
| Cidadão aparece com nome estranho nos relatórios | Contas WhatsApp têm `user_metadata.channel = 'whatsapp'` — filtrar por isso ao distinguir de contas reais com signup próprio |
