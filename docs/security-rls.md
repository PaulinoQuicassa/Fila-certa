# Hardening de segurança — least privilege (pré-Fase 10)

Pedido explicitamente antes de avançar para a Fase 10, depois de o
teste real de Realtime da Fase 8 confirmar que `tickets`/`counters`/
`ticket_calls` (leitura aberta a qualquer autenticado, decisão da Fase 5
— `security.md`, Decisão 1) permitiam observar ao vivo dados de outros
clientes/instituições/filiais. Princípio aplicado: **cada utilizador só
recebe os dados necessários para o seu próprio contexto operacional.**

## 1. Auditoria do modelo actual

**Tabelas revistas**: `tickets`, `counters`, `ticket_calls`,
`institutions`, `branches`, `staff`, `branch_counters`.

**Relações**: `staff.id = auth.users.id`; `staff` tem sempre
`institution_id` + `branch_id` (e `counter_id` só para agentes).
`tickets`/`counters`/`ticket_calls` têm sempre `institution_id` +
`branch_id`. `tickets.customer_id` referencia `auth.users(id)`
(nullable — só preenchido quando a senha é tirada por um cliente
autenticado, nunca por staff).

**Papéis existentes no modelo actual** (`staff_role` enum): `agent`
(sempre ligado a um `counter_id`) e `manager` (sem `counter_id`). **Não
existe um papel "administrador" distinto no código ou no schema** —
não foi inventado nenhum para este documento. O único conceito próximo
é a `service_role` key do Supabase, uma credencial de infraestrutura
usada só nos scripts de seed/migração (nunca exposta a nenhuma app),
não um papel de utilizador.

**Confirmado por leitura do código** (`AgentScreen.tsx`,
`Dashboard.tsx`): cada instância publicada da app da equipa está ligada
a **uma única filial** (`VITE_INSTITUTION_ID`/`VITE_BRANCH_ID`), tanto
para agentes como para gestores — não existe hoje nenhum ecrã ou fluxo
que peça a um gestor dados de mais do que uma filial. Por isso o âmbito
correcto, derivado do uso real, é **por filial** para os dois papéis,
não por instituição inteira.

**Achado relacionado, mesma causa raiz**: as funções RPC de mutação
(`call_next`, `recall_current`, `complete_current`, `mark_no_show`,
`transfer_ticket`, `set_counter_paused`) só verificavam
`is_staff_of(institution_id)` — nunca a filial. Um agente da Filial A
conseguiria, em teoria, chamar/concluir/transferir senhas da Filial B
da mesma instituição. Corrigido na mesma migration (troca por
`is_staff_of_branch`), por ser exactamente a mesma classe de problema
(âmbito operacional), não uma decisão nova.

## 2. Matriz de acesso

"Cliente" = utilizador autenticado sem ligação a `staff` (app Flutter).
"Anónimo" = sessão anónima do painel de TV (`PublicDisplay.tsx`), sem
nenhuma instituição própria. Não existe papel "Admin" (ver secção 1).

| Tabela | Cliente | Atendente (própria filial) | Gestor (própria filial) | Anónimo (painel TV) | Contexto |
|---|---|---|---|---|---|
| **tickets** | SELECT só das suas próprias (`customer_id = auth.uid()`) | SELECT de todas as da sua filial | SELECT de todas as da sua filial | Nenhum acesso directo | INSERT/UPDATE/DELETE: nunca directo — só via RPC (`pull_ticket`, `call_next`, etc.) |
| **counters** | SELECT só do balcão que o está a atender neste momento (via `current_ticket_id`) | SELECT de todos os balcões da sua filial | SELECT de todos os balcões da sua filial | Nenhum acesso directo | Mutação só via RPC |
| **ticket_calls** | SELECT só se tiver uma senha activa (`waiting`/`serving`) nessa filial | SELECT de todas as da sua filial | SELECT de todas as da sua filial | SELECT de todas (é o propósito do ecrã público) | Append-only, só via RPC |
| **branch_queue_summary** (agregado, não é tabela) | SELECT (contagem por serviço, sem `customer_id`) | SELECT | SELECT | Não usado hoje (sem consumidor anónimo) | Função `SECURITY DEFINER`, `authenticated` |
| **branch_wait_stats** (agregado) | SELECT | SELECT | SELECT | SELECT (é o consumidor original) | Função `SECURITY DEFINER`, `authenticated` + `anon` |
| **waiting_ahead_count** (agregado, por senha) | SELECT só da própria senha (ownership confirmada na função) | N/A (não é usado por staff) | N/A | N/A | Função `SECURITY DEFINER`, `authenticated` |
| institutions / branches | SELECT aberto (sem PII, fora de âmbito desta ronda) | SELECT aberto | SELECT aberto | SELECT aberto | Não alterado — ver secção 5 |
| staff | SELECT só do próprio registo | idem | idem | Nenhum | Não alterado |
| branch_counters | Nenhum acesso | SELECT (`is_staff_of`, ainda por instituição — ver secção 5) | idem | Nenhum | Não alterado |
| appointments | SELECT das próprias | SELECT das da sua instituição (`is_staff_of`, ainda por instituição) | idem | Nenhum | Não alterado — ver secção 5 |
| ratings | SELECT aberto a qualquer autenticado | idem | idem | Nenhum | Não alterado — ver secção 5 |

## 3. Clientes

**O que passou a estar bloqueado** (confirmado por teste real, ver
`scripts/test-security-hardening.mjs`): senhas de outros clientes,
senhas de outra instituição, senhas de outra filial da mesma
instituição — tanto por SELECT directo como por Realtime.

**O que continua a funcionar** (confirmado pelos mesmos testes +
`scripts/test-realtime-delivery.mjs`, regressão completa):
- a sua própria senha, estado, chamada, "estou a caminho", conclusão,
  cancelamento, transferência — tudo via `customer_id = auth.uid()`,
  sem mudança de comportamento;
- o balcão que a está a atender, incluindo detectar pausa — via a nova
  cláusula em `counters_select` (liga-se por `current_ticket_id`);
- o quadro de chamadas da sua própria filial (`ticket_calls`) enquanto
  tiver uma senha activa lá.

**Distinção aplicada — informação pública da fila vs. dados do
cliente**: "quantas pessoas estão à espera" e "quantas por serviço"
(antes lidas directamente de `tickets`, contando linhas no cliente) são
informação operacional pública da fila, sem nenhum dado atribuível a um
cliente — passaram a vir de `branch_queue_summary` (agregado
`service, count`, nunca `customer_id`/código de senha alheio). O tempo
médio de espera (painel de TV) idem, via `branch_wait_stats`. A posição
na fila de um cliente específico (`waiting_ahead_count`) já **é** dado
ligado a essa pessoa (a pergunta "quantos à minha frente" só faz
sentido para quem tem uma senha), por isso a função confirma a posse da
senha antes de responder.

## 4. Atendentes e Gestores

Âmbito: `staff.institution_id` + `staff.branch_id`, verificado pelo
novo helper `is_staff_of_branch(institution_id, branch_id)` — nunca só
a instituição. Aplicado de forma consistente a:
- `tickets_select`, `counters_select` (leitura, novo)
- `call_next`, `recall_current`, `complete_current`, `mark_no_show`,
  `transfer_ticket`, `set_counter_paused` (mutação, achado relacionado
  corrigido na mesma migration)

As RPCs continuam a ser a única autoridade para mutação — o SELECT
tornou-se mais restrito, mas nenhuma lógica de negócio foi movida para
o Realtime nem para políticas de RLS de escrita (que continuam
inexistentes nestas tabelas).

Validado com `scripts/test-security-hardening.mjs`: um agente/gestor da
Filial A não lê nem consegue chamar/operar em senhas da Filial B da
mesma instituição.

## 5. Gaps fechados numa ronda posterior (2026-09-07) e o que continua fora de âmbito

**Actualização**: os três itens abaixo marcados como "fora de âmbito"
foram fechados a pedido explícito do utilizador — ver
`docs/commercial-readiness.md`, "Ronda 2", e
`20260907110000_close_known_rls_gaps.sql`. `ratings_select` e
`appointments_select` passaram a `customer_id = auth.uid() or
is_staff_of_branch(institution_id, branch_id)`;
`branch_counters_select` passou a `is_staff_of_branch(...)`. Validado
com `scripts/test-rls-gaps-closed.mjs` (isolamento cross-branch dentro
da mesma instituição, não só cross-institution).

Continua fora de âmbito, sem pedido para o alterar:

- **`institutions`/`branches`** continuam com SELECT aberto — sem PII,
  sem uso ao vivo por nenhum ecrã (a app Flutter usa dados estáticos em
  `MockData`), risco residual mínimo.

## 6. Limitação estrutural encontrada (nenhuma solução inventada)

**Problema**: o modelo de `staff` (Fase 6) assume 1 filial por conta —
não existe uma tabela de associação "gestor gere N filiais". Se no
futuro um gestor precisar de âmbito multi-filial legítimo (ex.: um
gestor regional), a política actual (`is_staff_of_branch`) bloquear-lhe-ia
correctamente o acesso, mas incorrectamente do ponto de vista de
negócio.

**Causa**: decisão da Fase 6, herdada directamente do modelo
`staff/{uid}` do Firestore (também 1 filial por conta) — não é uma
limitação introduzida agora, só ficou mais visível ao apertar o RLS.

**Opções**: (a) manter assim até haver um pedido real de gestor
multi-filial; (b) já desenhar uma tabela `staff_branches` (many-to-many)
agora, generalizando `is_staff_of_branch` para uma sub-consulta em vez
de comparar uma coluna. Não implementado — seria inventar uma
funcionalidade sem pedido nem uso actual.

**Recomendação**: (a). **Impacto de não decidir agora**: nenhum — o
comportamento actual (1 gestor, 1 filial) é exactamente o que o código
já usa em produção.

## 7. Auditoria de produto comercial (2026-09-07) — GRANTs e audit_logs

Pedido explícito do utilizador ao encerrar a migração Firebase→Supabase:
auditar o projecto como produto comercial real, não só "funciona".
Dois achados de segurança corrigidos nesta ronda:

**GRANTs desnecessários**: `anon`/`authenticated` tinham GRANT total
(INSERT/UPDATE/DELETE/TRUNCATE) em todas as tabelas — comportamento por
omissão do Supabase, seguro hoje só porque o RLS bloqueia tudo sem
policy. Corrigido em `20260907100200_revoke_unnecessary_grants.sql`:
revogados os privilégios que nenhum papel da aplicação usa
legitimamente (INSERT/UPDATE/DELETE directo em `tickets`/`counters`/
`ticket_calls`/`branch_counters`/`institutions`/`branches`/`staff`/
`appointments`/`audit_logs`, TRUNCATE em tudo, UPDATE/DELETE em
`ratings`, DELETE em `notifications`/`user_settings`). Efeito: mesmo
que o RLS de uma tabela seja desactivado por engano no futuro, essas
operações continuam bloqueadas ao nível do GRANT — duas camadas em vez
de uma. Validado por teste real (`scripts/test-audit-logs.mjs`,
cenário 5): `UPDATE` directo a `counters` continua a devolver 0 linhas.

**`audit_logs`** (tabela nova, `20260907100000_audit_logs.sql` +
`20260907100100_audit_rpcs.sql`): regista `actor_id`, `action`,
`entity`/`entity_id`, `institution_id`/`branch_id`, `result`, `details`
(jsonb) para as 11 RPCs de mutação existentes (`pull_ticket`,
`call_next`, `recall_current`, `complete_current`, `mark_no_show`,
`transfer_ticket`, `set_counter_paused`, `cancel_ticket`,
`set_on_the_way`, `schedule_appointment`, `cancel_appointment`). Só a
equipa da própria filial lê o seu registo (`is_staff_of_branch`, mesma
regra de `tickets`/`counters`); ninguém escreve directamente — só a
função interna `write_audit_log(...)`, chamada de dentro de cada RPC
depois da mutação ter tido sucesso.

**Limitação conhecida, aceite**: só sucessos ficam auditados. Uma
tentativa negada (`raise exception`) reverte a transacção inteira,
incluindo o próprio registo de auditoria — capturar tentativas negadas
exigiria uma transacção autónoma (extensão `dblink`/`pg_background`),
considerado overengineering para o valor que traria agora. Tentativas
negadas continuam visíveis nos logs do próprio Supabase (Postgres
logs), só não ficam num histórico consultável pela equipa da instituição.
