# Revisão — restrição de EXECUTE nas RPC (Fase 1)

Estado: **APLICADO em produção** em 2026-10-04 16:36 (Africa/Luanda). Ver secção 10.
Sem rollback. Sem alteração de dados.

Ficheiros:
- Aplicação: `supabase/migrations/20261004120000_restrict_rpc_execute.sql`
- Rollback: `supabase/rollbacks/20261004120000_restrict_rpc_execute_rollback.sql`
  (fora de `migrations/` de propósito: o CLI aplicaria o rollback como migração)

## 1. Quem chama cada função R1

| Função | Chamadores (verificados no código e no catálogo) | Papel que precisa | Alteração |
|---|---|---|---|
| `update_notification_status` | `_shared/notifications/engine.ts`, `twilio-status-callback/index.ts` (cliente `serviceClient()` = `service_role`) | `service_role` | Remove `anon` e `authenticated` |
| `record_notification_attempt` | `_shared/notifications/engine.ts` (`service_role`) | `service_role` | Remove `anon` e `authenticated` |
| `clear_counter` | Só dentro de funções `SECURITY DEFINER` com dono `postgres` (chamadas de dentro do corpo das RPC de balcão; ver `20260906190200_rpc_functions.sql` e `20260907100100_audit_rpcs.sql`) | Nenhum papel externo | Remove `anon` e `authenticated` |
| `write_audit_log` | Só dentro de funções `SECURITY DEFINER` com dono `postgres` | Nenhum papel externo | Remove `anon` e `authenticated` |

Nenhum código de cliente (Flutter, React da equipa, consola do dono) chama
estas quatro funções directamente. Verificado com pesquisa em `src/` e `lib/`.

`clear_counter` e `write_audit_log` deixam de poder ser chamadas directamente
por `authenticated`. Antes, qualquer utilizador autenticado (incluindo sessões
anónimas de convidado) podia repor um balcão de qualquer filial.

## 2. Funções que mantêm `anon`, e porquê

| Função | Motivo |
|---|---|
| `is_owner()` | Usada por políticas RLS (`access_profiles`, `audit_logs`, `institution_billing`) |
| `is_staff_of_branch(text,text)` | Usada por políticas RLS (`tickets`, `counters`, `appointments`, `ratings`, `audit_logs`, `branch_counters`) em cláusulas `OR` que o Postgres avalia também para `anon` |
| `is_anonymous_session()` | Usada por `ticket_calls_select` |
| `queue_capacity_preview(text,text,text)` | Previsão de capacidade no ecrã antes do login (`ticket_service.dart`) |
| `branch_queue_summary(text,text)` | Lista de serviços/contagens antes do login |
| `branch_wait_stats(text,text)` | Tempo de espera antes do login (`ticket_service.dart`, painel TV) |

## 3. Impacto potencial

- **Políticas RLS:** as políticas que usam helpers continuam a funcionar
  para `anon` porque os três helpers mantêm EXECUTE.
- **App Flutter antes do login:** não muda. Só chama as três funções
  mantidas. Verificado: não usa `signInAnonymously`, por isso antes do login
  corre como `anon`.
- **App da equipa e painel TV:** `supabase.ts` faz `signInAnonymously`, por
  isso correm como `authenticated` e não são afectados.
- **WhatsApp:** `citizenClient(accessToken)` corre sempre como `authenticated`.
  `serviceClient()` (service_role) mantém acesso a tudo.
- **Notificações:** `service_role` mantém EXECUTE nas duas funções.
- **Erro para `anon` nas restantes funções:** muda de `P0001` com mensagem
  (`apenas clientes autenticados...`) para `42501` `permission denied` (HTTP
  403). Nenhum cliente depende da mensagem para `anon`, porque o login é
  pedido antes destas chamadas.
- **Funções futuras:** a predefinição do Supabase volta a dar EXECUTE a
  `anon` em funções novas. Recomendado como passo seguinte separado
  (`ALTER DEFAULT PRIVILEGES`), não incluído aqui.

## 4. Estado esperado das permissões

Antes (verificado em 2026-10-04): `anon` = EXECUTE em 67 funções;
`authenticated` = EXECUTE em 67; `service_role` = EXECUTE em 67.

Depois: `anon` = EXECUTE em 6 funções; `authenticated` = EXECUTE em 63;
`service_role` = EXECUTE em 67.

Verificação antes e depois:

```sql
select p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
order by anon_exec desc, p.proname;
```

Esperado depois: `anon_exec = true` só para `is_owner`, `is_staff_of_branch`,
`is_anonymous_session`, `queue_capacity_preview`, `branch_queue_summary`,
`branch_wait_stats`.

## 5. Funções afectadas

**Revogadas de `anon` (61):** as quatro R1 mais 57 restantes — ver a migração,
secção 2. Assinaturas exactas no próprio SQL.

**Revogadas de `authenticated` (4):** `update_notification_status`,
`record_notification_attempt`, `clear_counter`, `write_audit_log`.

**Concedidas a `service_role` (4):** as mesmas quatro (já tinha; grant explícito
para não depender da predefinição).

## 6. Testes antes de aplicar em produção

Não há branch de teste disponível (pedido recusado). A revisão e os testes
ficam por isso a cargo de quem aprovar:

1. Correr a verificação da secção 4 **antes** para confirmar o estado de partida.
2. Anónimo (sem sessão): `queue_capacity_preview`, `branch_queue_summary`,
   `branch_wait_stats` devem responder; `pull_ticket` deve responder 403.
3. Visitante (sessão anónima): ver fila e tirar senha.
4. Staff: chamar/completar/transferir; painel do director.
5. Dono: `owner_list_*`.
6. Notificações: uma execução da Edge Function com `service_role`.
7. Verificação da secção 4 **depois**.
8. Em caso de problema: aplicar o rollback.

## 10. Registo da aplicação

- **Data/hora:** 2026-10-04 16:36 (Africa/Luanda).
- **Migração aplicada:** `20261004120000_restrict_rpc_execute` (`apply_migration`, sucesso).
- **SHA-256 aprovados:** migração `1f0cbba8f4f1b34e59152e55ea7df3cbcaa35327b03c9e7c1f0ed1c8a4446aa9`,
  rollback `5de637383a053de4b5a852f040154f796ec682080b3930d4636c9f9f21613141`. Confirmados antes da aplicação.
- **Base de dados alterada:** apenas privilégios EXECUTE. Sem alterações a dados, RLS, tabelas ou funções.
- **Rollback executado:** não.

### Verificação de privilégios (catálogo, pós-aplicação)

| Critério | Resultado |
|---|---|
| Acessíveis a `anon` (6): `is_owner`, `is_staff_of_branch`, `is_anonymous_session`, `queue_capacity_preview`, `branch_queue_summary`, `branch_wait_stats` | PASS: as seis com `anon_exec = true` |
| Restringidas para `anon` (61) | PASS: as restantes 61 com `anon_exec = false` |
| R1 sem `authenticated` (`update_notification_status`, `record_notification_attempt`, `clear_counter`, `write_audit_log`) | PASS: `auth_exec = false` nas quatro |
| R1 com `service_role` | PASS: `service_exec = true` nas quatro |
| Seis funções sem `PUBLIC` (`clear_counter`, `write_audit_log`, `director_pct_change`, `director_period_bounds`, `is_director_of`, `is_manager_of_branch`) | PASS: `public_exec = false` nas seis |
| `service_role` em todas as 67 | PASS |
| `authenticated` em 63 (67 menos as R1) | PASS |

### Testes executados

| Teste | Resultado |
|---|---|
| `anon` → `queue_capacity_preview` (SIAC) | PASS: HTTP 200, dados reais |
| `anon` → `branch_queue_summary` (SIAC) | PASS: HTTP 200, lista de serviços |
| `anon` → `branch_wait_stats` (SIAC) | PASS: HTTP 200 (`null`, sem amostra hoje nesta filial) |
| `anon` → `pull_ticket` | PASS: HTTP 401, `42501 permission denied for function pull_ticket` |
| `anon` → `director_capacity_kpis` | PASS: HTTP 401, `42501 permission denied` |
| `anon` → `clear_counter` (ids inexistentes) | PASS: HTTP 401, `42501 permission denied` |
| `anon` → `update_notification_status` (uuid inexistente) | PASS: HTTP 401, `42501 permission denied` |
| `anon` → leitura de `tickets` e `counters` (RLS) | PASS: HTTP 200, `[]` (RLS continua a filtrar) |
| `authenticated` (agente SIAC) → `clear_counter`, `update_notification_status`, `record_notification_attempt`, `write_audit_log` | PASS: HTTP 403, `42501 permission denied` nas quatro |
| `authenticated` → `queue_capacity_preview` | PASS: HTTP 200 |
| `authenticated` → `director_capacity_kpis` (agente) | PASS: chega à lógica da função, `P0001 só a direcção...` (EXECUTE concedido, gate intacta) |
| `authenticated` → `list_branch_staff` (agente) | PASS: chega à lógica, `P0001 só um gestor...` |
| `authenticated` → `cancel_ticket` (id inexistente) | PASS: chega à lógica, `P0001 senha não encontrada...` |
| Funções `SECURITY DEFINER` internas: `call_next` + `complete_current` como agente SIAC (chamam `clear_counter` e `write_audit_log`) | PASS: executam. Teste em transacção com reversão forçada |
| Integridade após o teste interno | PASS: 4 senhas em espera, B279 `waiting`, `guiche-1` `available`, zero registos de auditoria do teste |

### Não executados nesta aplicação (fora do que era seguro testar em produção)

Estes fluxos escrevem dados ou dependem de serviços externos. Não foram executados
para cumprir o critério de "sem alteração de dados":

- **Emissão de senha de ponta a ponta** (`pull_ticket` com sessão de cliente): não executado. Regras amarelo/vermelho de `pull_ticket` não foram alteradas, e `pull_ticket` continua a ser `authenticated`.
- **Aplicação Flutter no dispositivo:** não executada. As três chamadas pré-login que a app faz foram testadas por HTTP.
- **Webhook WhatsApp:** não executado. Usa `citizenClient` (`authenticated`), e o `pull_ticket` é o mesmo do teste acima. Depende de Meta/Twilio.
- **Notificações (Edge Functions):** não executadas. Usam `service_role`, que mantém acesso.
- **Operações de dono (`owner_*`):** não executadas. Nenhuma conta de teste de dono foi usada.

### Impacto confirmado

- Visitantes sem sessão: mantêm a previsão de capacidade, o resumo da fila e a espera.
- Um utilizador autenticado já não consegue repor balcões, alterar notificações nem escrever no registo de auditoria directamente.
- Funções internas continuam a funcionar.
