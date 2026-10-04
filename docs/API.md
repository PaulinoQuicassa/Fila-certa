# API do Fila Certa (Supabase RPC)

Data da auditoria: 2026-10-04. Projecto Supabase: `qdfpqispcntitvczybfl`.

## 1. Arquitectura

Não existe um servidor de API próprio. O Supabase expõe cada função
`public.*` do Postgres como endpoint REST (PostgREST):

```
POST https://qdfpqispcntitvczybfl.supabase.co/rest/v1/rpc/<nome_da_funcao>
Content-Type: application/json
apikey: <SUPABASE_PUBLISHABLE_KEY>
Authorization: Bearer <JWT_DO_UTILIZADOR_OU_A_PUBLISHABLE_KEY>
```

- Os argumentos são enviados como um objecto JSON cujas chaves são os
  nomes dos parâmetros da função (`p_*`).
- Sem sessão, o pedido chega com o papel `anon`. Com sessão, chega com
  `authenticated` e `auth.uid()` preenchido.
- Todas as funções são `SECURITY DEFINER` com `search_path = public`.
  Toda a autorização tem de estar dentro do corpo da função (e/ou no RLS
  das tabelas que lê), porque a função executa com privilégios do dono.
- Erros de negócio são lançados com `raise exception '<mensagem>'`. O
  PostgREST devolve HTTP 400 com `code: "P0001"` e a mensagem no campo
  `message`.

### Clientes que chamam a API

| Cliente | Ficheiro | Funções chamadas |
|---|---|---|
| App do cliente (Flutter) | `projectogestaodefilas/lib/ticket_service.dart` | `pull_ticket`, `queue_capacity_preview`, `watch_branch_capacity`, `waiting_ahead_count`, `branch_queue_summary`, `branch_wait_stats`, `cancel_ticket`, `set_on_the_way`, `report_customer_arrived`, `report_customer_delay`, `next_appointment_code`, `schedule_appointment`, `cancel_appointment`, `whatsapp_notifications_status`, `set_whatsapp_notifications`, `record_phone_verified_event` |
| App da equipa (React) | `fila-certa-staff/src/lib/queue.ts` | `pull_ticket` (Estação), `call_next`, `recall_current`, `complete_current`, `mark_no_show`, `transfer_ticket`, `set_counter_paused`, `list_branch_staff`, `set_counter_services`, `assign_counter_agent`, `branch_wait_stats`, `director_kpis`, `director_trend`, `director_benchmarking`, `director_alerts`, `director_capacity_kpis`, `director_update_branch_capacity` |
| Consola do dono (React) | `fila-certa-owner/src/lib/admin.ts` | `owner_create_institution`, `owner_update_institution`, `owner_delete_institution`, `owner_create_branch`, `owner_delete_branch`, `owner_create_counter`, `owner_delete_counter`, `owner_assign_staff`, `owner_remove_staff`, `owner_set_staff_profile`, `owner_add_owner`, `owner_remove_owner`, `owner_set_owner_profile`, `owner_create_access_profile`, `owner_delete_access_profile` |
| Webhook WhatsApp (Edge Function) | `fila-certa-staff/supabase/functions/whatsapp-webhook/flows.ts` | `pull_ticket`, `waiting_ahead_count`, `branch_wait_stats`, `cancel_ticket` |
| Notificações (Edge Functions) | `fila-certa-staff/supabase/functions/_shared/notifications/engine.ts`, `twilio-status-callback/index.ts` | `record_notification_attempt`, `update_notification_status` |

## 2. Tabela de endpoints (funções da Capacidade Inteligente)

| Função | Método | Auth | Quem chama | Estado |
|---|---|---|---|---|
| `queue_capacity_preview` | POST | anon ou authenticated | App do cliente | Activa |
| `pull_ticket` | POST | authenticated, não anónimo | App do cliente, Estação, WhatsApp | Activa |
| `watch_branch_capacity` | POST | authenticated, não anónimo | App do cliente | Activa |
| `director_capacity_kpis` | POST | authenticated, director da instituição | App da equipa | Activa |
| `director_update_branch_capacity` | POST | authenticated, director da instituição | App da equipa | Activa |

Lista completa das funções `public` expostas à `anon` e à `authenticated`:
secção 5.

## 3. Funções da Capacidade Inteligente

### 3.1 `queue_capacity_preview`

**Finalidade:** estado (verde/amarelo/vermelho) e estimativas de uma
filial se um cliente entrasse agora. Só leitura.

**Request**

```json
POST /rest/v1/rpc/queue_capacity_preview
{ "p_institution_id": "siac", "p_branch_id": "balcao-talatona", "p_service": null }
```

| Parâmetro | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `p_institution_id` | text | sim | |
| `p_branch_id` | text | sim | |
| `p_service` | text | não | Aceite, mas **não usado** no cálculo (v1). |

**Response (sucesso, HTTP 200, array com uma linha)** — observada em
2026-10-04, filial `siac/balcao-talatona`, gate desligada:

```json
[{
  "state": "green",
  "queue_position": 5,
  "eta_minutes": 17,
  "active_counters": 3,
  "avg_service_minutes": 10.0,
  "remaining_by_volume": null,
  "remaining_by_time": null,
  "projected_finish": "2026-10-04T14:19:41.997504+00:00",
  "gate_enabled": false
}]
```

| Campo | Tipo JSON | Significado |
|---|---|---|
| `state` | string | `green` \| `yellow` \| `red` |
| `queue_position` | number | Posição do novo cliente (senhas `waiting` da filial + 1, todos os serviços). |
| `eta_minutes` | number | `queue_position / active_counters * avg_service_minutes`, arredondado. |
| `active_counters` | number | Balcões com `status in ('available','serving')`. |
| `avg_service_minutes` | number | Média de `done_at - called_at` das senhas concluídas hoje; se não houver, `branches.avg_service_minutes`. Mínimo 1. |
| `remaining_by_volume` | number \| null | `daily_capacity - concluídas hoje`, mínimo 0. `null` sem limite diário. |
| `remaining_by_time` | number | Atendimentos possíveis até `closing_time - safety_margin_minutes`. `null` com a gate desligada. |
| `projected_finish` | string (timestamptz ISO 8601) | `now() + eta_minutes`. |
| `gate_enabled` | boolean | `branches.capacity_gate_enabled`. |

**Regras de negócio**

- Gate desligada (`capacity_gate_enabled = false`) ou sem `opening_time` /
  `closing_time`: devolve sempre `green` e `gate_enabled: false`.
- Gate ligada:
  - `red` se `operational_limit <= 0` **ou** `eta_minutes > minutos_até_corte_vermelho`.
  - `yellow` se não for `red` e `eta_minutes > minutos_até_corte_amarelo`.
  - `green` nos restantes casos.
  - `minutos_até_corte_vermelho = fecho - margem - agora`.
  - `minutos_até_corte_amarelo = fecho - 2*margem - agora`.
  - "Agora" é convertido para `Africa/Luanda` (a sessão do Postgres é UTC).
- Filial inexistente: erro (ver 3.1.1).

**Erros**

| Situação | HTTP | `message` |
|---|---|---|
| Filial não existe | 400 | `filial não encontrada` (observado) |

**Autenticação e permissões:** `anon` e `authenticated`. Intencional: a
app mostra a previsão antes de o cliente criar conta.

**Exposição de dados (ver secção 6):** qualquer pessoa com a publishable
key obtém contagens e capacidade restante de qualquer filial. Não expõe
identidades de clientes nem códigos de senha.

#### 3.1.1 Enumeração de filiais

Um `p_branch_id` inexistente devolve `filial não encontrada`, e um
existente devolve dados. Quem testar IDs consegue distinguir os dois
casos. Os IDs são slugs previsíveis (`siac`, `balcao-talatona`).

### 3.2 `pull_ticket`

**Finalidade:** criar uma senha `waiting` para o utilizador autenticado.
Única via de criação de senhas (RLS bloqueia INSERT directo em `tickets`).

**Request**

```json
POST /rest/v1/rpc/pull_ticket
{
  "p_institution_id": "siac",
  "p_branch_id": "balcao-talatona",
  "p_service": "INSS",
  "p_channel": "app",
  "p_acknowledged_risk": false
}
```

| Parâmetro | Tipo | Obrigatório | Default | Notas |
|---|---|---|---|---|
| `p_institution_id` | text | sim | | |
| `p_branch_id` | text | sim | | |
| `p_service` | text | sim | | Texto livre; não é validado contra `services`. |
| `p_channel` | text | não | `'app'` | Usado: `app`, `whatsapp`, Estação. |
| `p_acknowledged_risk` | boolean | não | `false` | Obrigatório `true` para entrar em `yellow`. |

**Response (sucesso, HTTP 200)** — objecto `tickets` (forma derivada da
tabela; não foi executada uma chamada autenticada nesta auditoria):

```json
{
  "id": "uuid",
  "institution_id": "siac",
  "branch_id": "balcao-talatona",
  "code": "B282",
  "service": "INSS",
  "status": "waiting",
  "channel": "app",
  "customer_id": "uuid",
  "created_at": "timestamptz"
}
```

**Regras de negócio, por ordem**

1. `auth.uid()` nulo ou sessão anónima → erro.
2. Lock transaccional por (utilizador, instituição, filial, serviço).
3. Utilizador sem conta de quiosque: se já tiver senha `waiting`/`serving`
   do mesmo serviço nesta filial → erro.
4. Chamada interna a `queue_capacity_preview` (mesma transacção):
   - gate ligada e `red` → erro `capacity_exhausted`, sempre.
   - gate ligada, `yellow` e `p_acknowledged_risk` falso → erro
     `capacity_risk_confirmation_required`.
5. Incremento atómico de `branch_counters` e geração do código `B###`.
6. INSERT em `tickets` com `status = 'waiting'`.
7. Auditoria (`write_audit_log`).

**Erros**

| Situação | HTTP | `message` | Observado |
|---|---|---|---|
| Sem sessão ou anónimo | 400 | `apenas clientes autenticados (não anónimos) podem tirar senha` | Sim |
| Já tem senha activa para o serviço | 400 | `já tem uma senha activa para este serviço` | Código (não testado) |
| Capacidade esgotada | 400 | `capacity_exhausted` | Código |
| Amarelo sem confirmação | 400 | `capacity_risk_confirmation_required` | Código |

**Autenticação:** `authenticated`, não anónimo (validado no corpo).
`anon` tem o privilégio de execução, mas a função recusa.

**Quem chama e como trata os erros**

- App do cliente: trata `já tem uma senha activa` e os dois códigos de
  capacidade (mostra o painel e pede de novo a confirmação).
- Estação (`queue.ts`): **não** passa `p_acknowledged_risk`. Em amarelo a
  Estação fica impedida de emitir senhas e recebe o código bruto.
- WhatsApp (`flows.ts`): **não** passa `p_acknowledged_risk`. Mostra
  `error.message` cru ao cidadão, por exemplo
  `⚠️ Não foi possível entrar na fila: capacity_exhausted`.

### 3.3 `watch_branch_capacity`

**Finalidade:** registar o pedido "avisar-me quando abrir" quando a filial
está em vermelho.

**Request**

```json
POST /rest/v1/rpc/watch_branch_capacity
{ "p_institution_id": "siac", "p_branch_id": "balcao-talatona", "p_service": null }
```

| Parâmetro | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `p_institution_id` | text | sim | Chave estrangeira composta com `branches`. |
| `p_branch_id` | text | sim | |
| `p_service` | text | não | |

**Response:** HTTP 200 sem corpo (`void`).

**Regras:** apaga a inscrição não notificada anterior do mesmo
(utilizador, filial, serviço) e insere uma nova. Idempotente por efeito.

**Erros**

| Situação | HTTP | `message` | Observado |
|---|---|---|---|
| Anónimo | 400 | `apenas clientes autenticados (não anónimos) podem pedir para ser avisados` | Sim |
| Filial inexistente | (não definido no corpo) | violação de chave estrangeira do Postgres (23503) | Não testado |

**Entrega:** nesta versão não há push. A inscrição fica guardada para
quando existir infraestrutura de notificações para clientes.

### 3.4 `director_capacity_kpis`

**Finalidade:** painel do director com o estado de todas as filiais da
instituição.

**Request**

```json
POST /rest/v1/rpc/director_capacity_kpis
{ "p_institution_id": "banco-exemplo" }
```

**Response (sucesso)**, uma linha por filial, ordenada por nome. Forma
derivada da assinatura SQL; **não foi feita chamada autenticada** nesta
auditoria, por isso não há valores observados:

```json
[{
  "branch_id": "<text>",
  "branch_name": "<text>",
  "state": "<green|yellow|red>",
  "queue_position": "<integer>",
  "eta_minutes": "<integer>",
  "active_counters": "<integer>",
  "avg_service_minutes": "<numeric>",
  "remaining_by_volume": "<integer|null>",
  "remaining_by_time": "<integer|null>",
  "gate_enabled": "<boolean>",
  "daily_capacity": "<integer|null>",
  "done_today": "<integer>",
  "opening_time": "<time|null>",
  "closing_time": "<time|null>",
  "safety_margin_minutes": "<integer>"
}]
```

**Erros**

| Situação | HTTP | `message` | Observado |
|---|---|---|---|
| Anónimo ou sem ser director desta instituição | 400 | `só a direcção geral desta instituição pode ver este painel` | Sim |

**Autenticação:** `authenticated`, com linha em `staff` com
`role = 'director'` e `institution_id = p_institution_id`.

### 3.5 `director_update_branch_capacity`

**Finalidade:** configurar horário, margem, capacidade diária, tempo
médio e ativação da gate de uma filial.

**Request**

```json
POST /rest/v1/rpc/director_update_branch_capacity
{
  "p_institution_id": "banco-exemplo",
  "p_branch_id": "agencia-maianga",
  "p_opening_time": "08:00",
  "p_closing_time": "17:00",
  "p_safety_margin_minutes": 15,
  "p_daily_capacity": 70,
  "p_avg_service_minutes": 10,
  "p_capacity_gate_enabled": true
}
```

| Parâmetro | Tipo | Validação no servidor |
|---|---|---|
| `p_opening_time` | time | Obrigatório se `p_capacity_gate_enabled = true` |
| `p_closing_time` | time | Obrigatório se `p_capacity_gate_enabled = true` |
| `p_safety_margin_minutes` | integer | `>= 0` |
| `p_daily_capacity` | integer \| null | `>= 0` ou `null` (sem limite) |
| `p_avg_service_minutes` | integer | `> 0` |
| `p_capacity_gate_enabled` | boolean | |

**Response:** HTTP 200 sem corpo (`void`). Grava `write_audit_log`
(`director_update_branch_capacity`).

**Erros**

| Situação | `message` | Observado |
|---|---|---|
| Não é director desta instituição | `só a direcção geral desta instituição pode configurar a capacidade` | Sim |
| Margem negativa | `margem de segurança inválida` | Código |
| Tempo médio <= 0 | `tempo médio de atendimento inválido` | Código |
| Capacidade diária negativa | `capacidade diária inválida` | Código |
| Gate ligada sem horário | `defina o horário de abertura e de encerramento antes de activar a capacidade inteligente` | Código |
| Filial não pertence à instituição | `filial não encontrada` | Código |

**Nota:** valores `time` chegam como `"HH:MM"` ou `"HH:MM:SS"`.

## 4. Outras funções usadas pela app

Forma completa (assinaturas SQL reais) das funções que as apps chamam.
Não se documentaram exemplos de resposta destas: não foram executadas
nesta auditoria.

| Função | Argumentos (tipo) | Retorno | Auth interna |
|---|---|---|---|
| `waiting_ahead_count` | `p_ticket_id uuid` | integer | Dono da senha (`customer_id = auth.uid()`) |
| `branch_queue_summary` | `p_institution_id text, p_branch_id text` | `(service text, waiting_count bigint)` | Nenhuma (agregado público) |
| `branch_wait_stats` | `p_institution_id text, p_branch_id text` | numeric | Nenhuma (agregado público) |
| `cancel_ticket` | `p_ticket_id uuid` | void | `customer_id = auth.uid()` |
| `set_on_the_way` | `p_ticket_id uuid` | void | Dono |
| `report_customer_arrived` | `p_ticket_id uuid` | void | Dono |
| `report_customer_delay` | `p_ticket_id uuid` | void | Dono |
| `next_appointment_code` | `p_institution_id text, p_branch_id text` | text | Usa `auth.uid()`; corpo não lido nesta auditoria |
| `schedule_appointment` | `p_institution_id, p_branch_id, p_code, p_service text; p_date date; p_time text` | `appointments` | Autenticado, não anónimo |
| `cancel_appointment` | `p_code text` | void | `customer_id = auth.uid()` |
| `whatsapp_notifications_status` | — | `(phone, phone_verified, notifications_enabled)` | `auth.uid()` |
| `set_whatsapp_notifications` | `p_enabled boolean` | void | `auth.uid()` |
| `record_phone_verified_event` | — | void | Telefone verificado de `auth.uid()` |
| `call_next` | `p_institution_id, p_branch_id, p_counter_id text` | `tickets` | `is_staff_of_branch` |
| `recall_current` / `complete_current` / `mark_no_show` | idem | void | `is_staff_of_branch` |
| `transfer_ticket` | `+ p_target_counter_id text` | void | `is_staff_of_branch` |
| `set_counter_paused` | `+ p_paused boolean` | void | `is_staff_of_branch` |
| `set_counter_services` | `+ p_services text[]` | void | `is_staff_of_branch` |
| `assign_counter_agent` | `+ p_agent_id uuid` | void | `is_manager_of_branch` |
| `list_branch_staff` | `p_institution_id, p_branch_id text` | `(id, name, role, counter_id)` | `is_manager_of_branch` |
| `director_kpis` / `director_trend` / `director_benchmarking` / `director_alerts` | `p_institution_id text, p_period text` | tabelas | `is_director_of` |
| `owner_*` (15 funções) | variam | void / tabelas | `is_owner()` |
| `record_notification_attempt` | `p_event_id, p_user_id, p_channel, p_provider, p_priority` | `(id, inserted)` | **Nenhuma** (ver risco R1) |
| `update_notification_status` | `p_id, p_status, p_provider, p_provider_message_id, p_error_code, p_error_message` | void | **Nenhuma** (ver risco R1) |
| `clear_counter` | `p_institution_id, p_branch_id, p_counter_id text` | void | **Nenhuma** (ver risco R1) |
| `write_audit_log` | `p_action, p_entity, p_entity_id, p_institution_id, p_branch_id, p_result, p_details` | void | **Nenhuma** (ver risco R1) |
| `staff_display_name` | `p_staff_id uuid` | text | Nenhuma (ver R4) |

## 5. Matriz de permissões

Estado actual, após a migração `20261004120000_restrict_rpc_execute`
(aplicada em 2026-10-04 16:36). Verificado no catálogo do Postgres
(`has_function_privilege`). Detalhe em `docs/security-rpc-execute-review.md`.

- `anon`: EXECUTE apenas em `is_owner`, `is_staff_of_branch`,
  `is_anonymous_session`, `queue_capacity_preview`, `branch_queue_summary`
  e `branch_wait_stats`. Nas restantes 61 funções: sem EXECUTE.
- `authenticated`: EXECUTE em 63 funções. Sem EXECUTE em
  `update_notification_status`, `record_notification_attempt`,
  `clear_counter` e `write_audit_log`.
- `service_role`: EXECUTE nas 67 funções.
- `PUBLIC`: sem EXECUTE em `clear_counter`, `write_audit_log`,
  `director_pct_change`, `director_period_bounds`, `is_director_of` e
  `is_manager_of_branch`. Mantém-se em `is_owner`, `is_staff_of_branch` e
  `is_anonymous_session`, que são usadas pelo RLS.

| Grupo | Funções | Protecção efectiva |
|---|---|---|
| Públicas por desenho | `queue_capacity_preview`, `branch_queue_summary`, `branch_wait_stats` | Intencional |
| Cliente autenticado | `pull_ticket`, `watch_branch_capacity`, `cancel_ticket`, `set_on_the_way`, `report_customer_*`, `schedule_appointment`, `cancel_appointment`, `waiting_ahead_count`, `whatsapp_*`, `record_phone_verified_event` | Corpo verifica `auth.uid()` |
| Staff da filial | `call_next`, `recall_current`, `complete_current`, `mark_no_show`, `transfer_ticket`, `set_counter_paused`, `set_counter_services`, `list_branch_staff`, `assign_counter_agent` | `is_staff_of_branch` / `is_manager_of_branch` |
| Director | `director_*`, `director_capacity_kpis`, `director_update_branch_capacity` | `is_director_of(p_institution_id)` |
| Dono da plataforma | `owner_*` | `is_owner()` |
| Funções internas (R1), sem EXECUTE para `anon` nem `authenticated` | `record_notification_attempt`, `update_notification_status`, `clear_counter`, `write_audit_log` | Só `service_role` e chamadas internas `SECURITY DEFINER` (corrigido em 20261004120000) |
| Sem validação de identidade | `staff_display_name` | Sem EXECUTE para `anon` desde 20261004120000; `authenticated` mantém (R4, a restringir a colegas da mesma instituição) |

## 6. Riscos encontrados

Ordenados por gravidade. Confirmação indicada entre parênteses.

**R1 — Funções de escrita sem validação de identidade, executáveis por `anon` (ALTA) — CORRIGIDO em 2026-10-04 (`20261004120000_restrict_rpc_execute`).**
`update_notification_status`, `record_notification_attempt`,
`clear_counter` e `write_audit_log` são `SECURITY DEFINER`, não verificam
`auth.uid()` nem papel, e `anon` tem EXECUTE. Qualquer pessoa com a
publishable key poderia, por exemplo: alterar o estado de qualquer
notificação, inserir notificações na fila, repor `status`/`current_ticket_id`
de qualquer balcão (`clear_counter`), ou escrever no registo de auditoria.
*Confirmado por leitura do código e do catálogo. **Não foi executada
nenhuma chamada** a estas funções em produção, para não alterar dados.*

**R2 — `anon` tem EXECUTE em todas as funções (ALTA, causa de R1) — CORRIGIDO em 2026-10-04.**
O `REVOKE ... FROM public` deixa `anon` com EXECUTE, muito provavelmente
por um grant explícito das predefinições do Supabase (a causa exacta não
foi confirmada). A protecção actual depende inteiramente de cada corpo
validar a identidade (ver R1).

**R3 — Configuração operacional de filiais legível por qualquer pessoa (MÉDIA).**
A política `branches_select_guest` deixa `anon` ler a tabela `branches`.
Confirmado por pedido HTTP real sem sessão: devolve `daily_capacity`,
`safety_margin_minutes`, `avg_service_minutes` e `capacity_gate_enabled`
da Agência Maianga. Horário de abertura e fecho é informação pública;
capacidade e margem são internas.

**R4 — `staff_display_name` resolve nomes de colaboradores por UUID para `anon` (BAIXA).**
Os UUIDs não são enumeráveis, mas a função não tem validação. Exposição
de nome próprio de funcionários.

**R5 — Grants de tabela excessivos (MÉDIA).** `anon` e `authenticated`
têm INSERT, UPDATE e DELETE em `capacity_watchers`, `services` e
`notification_deliveries`. Hoje o RLS bloqueia (não há política de INSERT
para estes papéis), mas é a única barreira.

**R6 — Corrida na capacidade (BAIXA/MÉDIA, aceite no plano).** `pull_ticket`
lê a capacidade e insere sem serializar clientes diferentes. Em carga
concorrente, a filial pode ultrapassar o limite em algumas senhas. O lock
por cliente não cobre isto.

**R7 — Enumeração de filiais (BAIXA).** `queue_capacity_preview` devolve
`filial não encontrada` para IDs inexistentes e dados para os existentes
(ver 3.1.1).

**R8 — Mensagens de erro técnicas expostas ao utilizador (MÉDIA, funcional).**
WhatsApp mostra `error.message` cru (`capacity_exhausted`). A Estação não
passa `p_acknowledged_risk` e não tem UI para amarelo.

**R9 — `watch_branch_capacity` sem limite de taxa (BAIXA).** Um cliente
autenticado pode criar inscrições repetidamente (cada chamada apaga e
recria a anterior, o que mantém o número de linhas por cliente, filial e
serviço limitado a uma não notificada).

## 7. Verificação de consistência frontend ↔ backend

Verificado com pedidos reais:

- `avg_service_minutes` chega como número JSON (`10.0`), compatível com
  `as num` (Dart) e `number` (TS). **OK.**
- `projected_finish` chega como ISO 8601 com fuso. Compatível com
  `DateTime.parse` (Dart). **OK.**
- `queue_position` (renomeado de `position`, palavra reservada do Postgres)
  está alinhado em `capacity_status.dart` e em `queue.ts`. **OK.**
- `opening_time` chega como `"08:00:00"`; a app da equipa corta para
  `HH:MM`. **OK.**
- Erros de negócio: o cliente Flutter procura substrings
  `capacity_exhausted` / `capacity_risk_confirmation_required` / `já tem uma senha activa`.
  Correspondem exactamente às mensagens do SQL. **OK.**

Divergências:

- WhatsApp e Estação não tratam os códigos de capacidade (R8).
- Assinatura de `pull_ticket` mudou de 4 para 5 argumentos. Os clientes
  antigos continuam a funcionar porque o novo argumento tem default
  `false`. Versões antigas do cliente que não enviam o argumento caem em
  "amarelo bloqueado", que é o comportamento seguro.

Regras críticas (verificado):

- Limite de uma senha activa por serviço: **no servidor** (`pull_ticket`).
- Bloqueio por capacidade: **no servidor** (`pull_ticket`). O aviso amarelo
  da app é só apresentação; sem confirmação no pedido a função recusa.
- Configuração só por director: **no servidor** (`is_director_of`).
- Gate ligada exige horário: **no servidor**.
- Nenhuma regra crítica depende só do frontend. **Exceção:** a exibição
  correcta de amarelo na Estação e no WhatsApp (R8), que é funcional.

## 8. Melhorias recomendadas (não implementadas)

Ordem sugerida, aguardam aprovação:

1. **R1/R2:** revogar EXECUTE de `anon` em todas as funções que não
   precisam dele. Manter só `queue_capacity_preview`, `branch_queue_summary`
   e `branch_wait_stats` como públicas. Para `update_notification_status`,
   `record_notification_attempt`, `clear_counter` e `write_audit_log`,
   revogar também de `authenticated` e deixar só `service_role`.
2. **R3:** tirar `daily_capacity`, `safety_margin_minutes`,
   `avg_service_minutes` e `capacity_gate_enabled` da leitura de `anon`.
   Opção: vista pública só com `opening_time`/`closing_time`, ou tabela
   separada de configuração com RLS só para o director.
3. **R5:** revogar INSERT/UPDATE/DELETE de `anon` e `authenticated` nas
   tabelas que não o usam directamente.
4. **R4:** `staff_display_name` só para `authenticated`, e só para
   colegas da mesma instituição.
5. **R8:** mapear os códigos de erro para mensagens humanas no WhatsApp;
   acrescentar a confirmação de risco ao fluxo da Estação.
6. **R6:** se o limite diário for crítico, serializar `pull_ticket` por
   (instituição, filial) com `pg_advisory_xact_lock` nesse par, em vez de
   por cliente.
7. **R9:** limite de inscrições por cliente e filial.

## 9. Limitações desta auditoria

- Não foram executadas chamadas autenticadas (cliente, staff, director).
  As respostas de sucesso de `pull_ticket` e `director_*` são derivadas
  da assinatura SQL e marcadas como tal.
- R1 foi confirmado pelo código e pelo catálogo, não por execução.
- As assinaturas das funções `owner_*` e das restantes RPC das apps foram
  lidas do catálogo; os nomes de argumentos foram verificados por
  amostra (`owner_assign_staff`), não linha a linha.
