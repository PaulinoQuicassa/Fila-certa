# Arquitetura de tempo real — Supabase Realtime (Fase 8)

## Princípio fundamental

O Realtime **nunca** decide nada — só avisa "algo mudou nesta tabela,
para este filtro". Toda a lógica de negócio (qual a próxima senha,
quem pode chamar, transferir, concluir, cancelar) vive exclusivamente
nas funções RPC `SECURITY DEFINER` da Fase 9
(`supabase/migrations/20260906190200_rpc_functions.sql`). O padrão
usado em `queue.ts` (React) e `ticket_service.dart`/`app_stores.dart`
(Flutter) é sempre o mesmo:

```
Mutação  → RPC (única autoridade, valida permissões, escreve no Postgres)
Leitura  → subscreve postgres_changes (só diz QUANDO reler)
           → refetch por query completa e filtrada (única fonte da verdade)
           → refetch também no (re)SUBSCRIBED do canal (cobre 1ª carga E reconexão)
```

Nenhum `callback` de `postgres_changes` escreve dados nem chama outra
RPC — só dispara um `refetch()`. Confirmado por leitura de
`src/lib/queue.ts` e `lib/ticket_service.dart`/`lib/app_stores.dart`.

## Replicação activada (`supabase_realtime`)

**Achado corrigido nesta fase**: nenhuma tabela estava registada na
publicação `supabase_realtime` — o código cliente subscrevia canais
correctamente, mas o Postgres nunca emitia nenhum evento (confirmado
com um teste real que dava timeout em todos os cenários antes da
correcção; ver `docs/testing.md` e
`scripts/test-realtime-delivery.mjs`). Corrigido em
`supabase/migrations/20260906210000_enable_realtime.sql`.

Tabelas activadas, e porquê (nada mais foi activado):

| Tabela | Porque precisa de Realtime | Quem publica | Quem subscreve | Eventos | Isolamento |
|---|---|---|---|---|---|
| `tickets` | Estado da fila muda a cada senha tirada/chamada/concluída — é o dado mais "vivo" da app | RPCs (`pull_ticket`, `call_next`, `complete_current`, `mark_no_show`, `transfer_ticket`, `cancel_ticket`, `set_on_the_way`) | Cliente (a própria senha, fila à sua frente), equipa (fila do balcão, senha em atendimento) | INSERT, UPDATE | **Aberto** a qualquer `authenticated` (réplica intencional do Firestore original, `security.md` Decisão 1) — ver secção "Decisão pendente" abaixo |
| `counters` | Estado do balcão (disponível/em atendimento/pausa, agente actual) | RPCs (`call_next`, `complete_current`, `mark_no_show`, `transfer_ticket`, `set_counter_paused`) | Equipa (painel do balcão, lista de balcões), cliente a ser atendido (detectar pausa) | UPDATE | Aberto a `authenticated`, mesma decisão | 
| `ticket_calls` | Substitui o `liveBoard/current` do Firestore — painel de TV e "chamar novamente" | RPCs (`call_next`, `recall_current`) | Painel de TV (anónimo), cliente em atendimento | INSERT | Aberto a `authenticated` (inclui sessão anónima do painel) |
| `appointments` | Agendamentos mudam de estado (agendado/cancelado) | RPCs (`schedule_appointment`, `cancel_appointment`) | O próprio cliente (seus agendamentos), equipa da instituição | INSERT, UPDATE | **Isolado**: `customer_id = auth.uid() OR is_staff_of(institution_id)` — confirmado por teste real (cliente B não recebe agendamento do cliente A) |
| `ratings` | Resumo de qualidade do dashboard precisa de reflectir avaliações novas | Insert directo do cliente (RLS, sem RPC — ver `security.md` Decisão 4) | Equipa (dashboard) | INSERT | Select aberto a `authenticated` (mesma decisão dos KPIs, dado agregado/anonimizável no dashboard) |
| `notifications` | Sino de notificações do cliente | `GlobalQueueAlerts` (insert directo) | O próprio dono (`user_id`) | INSERT, UPDATE | **Isolado**: `user_id = auth.uid()` |
| `user_settings` | Preferências sincronizadas entre dispositivos da mesma conta | O próprio cliente (update directo) | O próprio dono (`user_id`) | UPDATE | **Isolado**: `user_id = auth.uid()` |

**Fora da lista, de propósito** (sem Realtime activado): `institutions`,
`branches`, `staff`, `branch_counters` — nenhum ecrã subscreve estas
tabelas em tempo real hoje (mudam raramente: só quando se cria/edita
uma instituição/agência/conta de staff, nunca durante o uso normal da
fila). Activar Realtime nelas seria trabalho sem consumidor, contra o
pedido explícito de não activar indiscriminadamente.

## Decisão resolvida — leitura aberta de `tickets`/`counters`/`ticket_calls`

**Actualização**: a decisão pendente descrita abaixo foi resolvida —
o utilizador aprovou a opção recomendada (least privilege) e o
hardening foi implementado, testado e documentado em
`docs/security-rls.md` (matriz de acesso completa) e
`supabase/migrations/20260906220000_least_privilege_hardening.sql`.
Resumo: `tickets` passou a exigir `customer_id = auth.uid() OR
is_staff_of_branch(institution_id, branch_id)`; `counters` exige
`is_staff_of_branch(...)` ou ser o cliente atendido nesse balcão neste
momento; `ticket_calls` exige `is_staff_of_branch(...)`, sessão anónima,
ou ter uma senha activa nessa filial. O texto original da análise
fica abaixo, para contexto de como se chegou à decisão.

<details>
<summary>Análise original (antes da decisão)</summary>

**Problema**: `tickets`, `counters` e `ticket_calls` têm política de
`SELECT` aberta a qualquer utilizador `authenticated` (não só
clientes com senha activa ou staff da instituição). Isto foi uma
decisão da Fase 5 (`security.md`, Decisão 1), justificada como réplica
fiel do comportamento que já existia no Firestore (as regras de
segurança originais também não restringiam a leitura de `tickets`
a ninguém específico). O teste real desta fase
(`scripts/test-realtime-delivery.mjs`, cenário 8a) confirmou que essa
abertura **também se aplica ao Realtime**: qualquer cliente autenticado
pode subscrever e observar em tempo real qualquer senha de qualquer
instituição, incluindo dados de outros clientes (código da senha,
serviço pedido, estado, timestamps) — não apenas ler uma vez, mas
**observar ao vivo**, o que aumenta a superfície de exposição face ao
Firestore original (lá exigia abrir um listener explícito por senha
conhecida; aqui um cliente malicioso pode subscrever a tabela inteira
por `branch_id` sem precisar de adivinhar nenhum ID).

**Opções**:
1. **Manter como está** — aceitar a paridade com o Firestore, dado
   tratar-se de um piloto sem dados sensíveis (nomes de clientes não
   aparecem em `tickets`, só `service`/`code`/timestamps/`customer_id`
   como UUID opaco). Custo: zero. Risco: um utilizador autenticado
   (staff ou cliente de qualquer instituição) pode montar um "painel"
   não autorizado da fila de qualquer outra instituição.
2. **Restringir `tickets`/`counters` a `is_staff_of(institution_id) OR
   customer_id = auth.uid()`** — cliente só vê as suas próprias senhas;
   staff só vê senhas da sua instituição. Custo: uma migration de RLS
   (`20260906190100_rls.sql` precisaria de ser substituída/complementada)
   + validar que nenhum ecrã depende da leitura aberta (o painel de TV
   usa sessão anónima e lê `ticket_calls`/`tickets` de uma instituição
   específica — teria de continuar a funcionar, o que é compatível com
   esta opção desde que a sessão anónima seja tratada como "cliente
   dessa instituição" nessa política, ou fique numa política à parte
   para sessões anónimas). Risco de regressão: médio — exige teste
   cuidadoso do painel de TV e do dashboard antes de aplicar.
3. **Meio-termo**: manter `SELECT` aberto para `counters`/`ticket_calls`
   (dado agregado, sem identificar clientes) mas restringir `tickets`
   (tem `customer_id`) à opção 2.

**Recomendação**: opção 3 — é o único ponto onde dados atribuíveis a um
cliente específico (`customer_id`) ficam expostos além do necessário; o
resto (`counters`/`ticket_calls`) já não tem esse problema porque não
guarda `customer_id`. Mas isto é uma mudança de segurança em produção,
não uma correcção de bug — **não a apliquei sem aprovação**, por ser
exactamente o tipo de decisão que pediste para eu parar e apresentar.

**Impacto de não decidir agora**: nenhum — o comportamento é idêntico
ao que já existia (aprovado) desde a Fase 5, só passou a ser mais fácil
de explorar ao vivo. Não bloqueia a Fase 10 nem nenhuma funcionalidade
actual.

</details>

## Agregados públicos-operacionais (introduzidos pelo hardening)

Fechar o SELECT de `tickets` quebraria três leituras que, na verdade,
só precisavam de um agregado, nunca das linhas em si — corrigido com
três funções `SECURITY DEFINER` novas (nunca tabelas novas):

- **`branch_queue_summary(institution_id, branch_id)`** → `(service,
  waiting_count)` — substitui `subscribeQueueSize`/
  `subscribeWaitingServiceNames` (Flutter), que antes liam `tickets`
  linha a linha só para contar.
- **`branch_wait_stats(institution_id, branch_id)`** → média de espera
  em minutos hoje — substitui o cálculo que o `PublicDisplay.tsx` fazia
  no cliente a partir de `subscribeTicketsToday` (a sessão anónima já
  não consegue ler essas linhas).
- **`waiting_ahead_count(ticket_id)`** → posição na fila — substitui
  `subscribeWaitingAhead`; confirma a posse da senha antes de contar.

**Trade-off aceite conscientemente**: estas três deixaram de reagir a
`postgres_changes` (um cliente sem senha activa nessa filial já não
recebe eventos de mudança de linhas alheias, por desenho) — passaram a
ser reavaliadas a um intervalo fixo em vez de "empurradas":
`branch_wait_stats` a cada 30s (React), `branch_queue_summary` a cada
15s e `waiting_ahead_count` a cada 10s (Flutter). É uma perda de
"instantaneidade" para três indicadores que já eram aproximados por
natureza (contagens/médias/posição-antes-de-entrar), em troca de
fechar uma exposição real de dados. Validado com
`scripts/test-public-aggregates.mjs`.

## Lifecycle: subscribe/unsubscribe/reconexão

- **React** (`queue.ts`): cada `subscribeX` devolve uma função de
  `unsubscribe` chamada no `return` do `useEffect` do componente que a
  usa (`AgentScreen.tsx`, `PublicDisplay.tsx`, `Dashboard.tsx`) — um
  canal por chamada, nunca partilhado, nunca esquecido.
- **Flutter** (`ticket_service.dart`): `_watchTable` cria um
  `StreamController.broadcast` cujo `onCancel` remove o canal Supabase
  — só é chamado quando a última subscrição ao `Stream` cancela
  (`StreamSubscription.cancel()`, feito em `dispose()`/`_TicketWatch.cancel()`
  nos ecrãs e em `GlobalQueueAlerts`).
- **`GlobalQueueAlerts`** (Flutter): mantém um `_TicketWatch` por senha
  activa (`Map<String, _TicketWatch>`), nunca por item de lista — o
  número de subscrições é limitado ao número de senhas activas do
  cliente (tipicamente 0-2), não à dimensão da fila. Cada `_TicketWatch`
  agrupa até 3 subscrições (ticket, painel ao vivo, estado do balcão) e
  tem um `cancel()` único que as fecha todas. Confirmado por leitura
  directa do código (`initState`/`dispose`/`_onRefsChanged`).
- **Reconexão** (corrigido nesta fase): antes, o `refetch()` só corria
  uma vez no arranque e a cada evento `postgres_changes`. Se o socket
  caísse (perda de rede, app em background) e voltasse, o Postgres
  Changes **não reenvia** eventos perdidos durante a queda — o ecrã
  ficaria preso no último estado visto até à próxima mudança real
  acontecer. Corrigido em `queue.ts` (`watchTable`, `subscribeTicket`) e
  em `ticket_service.dart`/`app_stores.dart` (todas as `subscribe(...)`):
  o `refetch()`/`emit()` passa a correr também sempre que o canal fica
  `SUBSCRIBED`, o que acontece tanto na primeira vez como depois de uma
  reconexão automática — garantindo resincronização a partir da base de
  dados, nunca assumindo que os eventos perdidos "chegam depois".
- **Erros de canal** (`CHANNEL_ERROR`/`TIMED_OUT`): o cliente
  `realtime-js`/`realtime-dart` já tenta reconectar automaticamente por
  omissão; não foi adicionada lógica de retry manual (seria duplicar
  comportamento da biblioteca). Não testado explicitamente nesta fase
  (exigiria simular quebra de rede a meio de um teste automatizado, fora
  do alcance razoável sem sandbox de rede controlada) — fica registado
  como gap conhecido em `docs/testing.md`.

## Performance

- Cada ecrã abre 1 canal por subscrição activa (nunca 1 por linha da
  fila). Num piloto com 6 instituições e volume baixo, o número total
  de canais simultâneos é pequeno (dezenas, não milhares).
- O `refetch()` completo (em vez de aplicar o *diff* do payload
  recebido) foi uma escolha deliberada de simplicidade/correcção sobre
  performance — para o volume actual (a maior tabela, `tickets`, tinha
  67 linhas de teste no total) o custo é desprezável. Se o volume
  crescer muito, o primeiro ponto a rever é `subscribeTicketsToday`/
  `subscribeWaitingQueue` (re-lêem a tabela inteira do branch a cada
  evento) — não foi optimizado agora por não haver ainda dado real de
  volume de produção que o justifique.
- `ticket_calls` é append-only e cresce indefinidamente; não tem
  nenhuma purga definida (fora do âmbito desta fase, mas fica anotado).
