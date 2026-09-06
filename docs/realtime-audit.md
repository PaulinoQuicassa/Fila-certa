# Auditoria de tempo real — Firebase → Supabase (Fase 8)

Auditoria retroactiva: o código já tinha sido migrado para Supabase na
Fase 10 (ver `docs/migration-plan.md`), incluindo os pontos de tempo
real. Este documento reconstrói, a partir do histórico de código desta
sessão, exactamente o que existia do lado Firebase antes da migração, e
confirma/corrige o que o substituiu. Não foi encontrado nenhum
mecanismo de `polling`/`Timer` a ler dados de negócio — só um `setInterval`
cosmético no relógio do painel de TV, listado abaixo por completude.

## `fila-certa-staff` (React/staff)

| Firebase atual (antes) | Local no código | Evento/dado recebido | Frequência | Substituição Supabase | Prioridade |
|---|---|---|---|---|---|
| `onSnapshot` em `tickets` (`where status=='waiting'`) | `queue.ts: subscribeWaitingQueue` → `AgentScreen` (fila em espera do balcão) | Lista de senhas em espera | Alta (cada senha tirada/chamada) | `postgres_changes` em `tickets` filtrado por `branch_id`, refetch completo | Alta |
| `onSnapshot` em `tickets/{id}` | `queue.ts: subscribeTicket` → `AgentScreen` (senha em atendimento) | Estado da senha actual | Média | `postgres_changes` em `tickets` filtrado por `id` | Alta |
| `onSnapshot` em `counters/{id}` | `queue.ts: subscribeCounter` → `AgentScreen` (estado do meu balcão) | Estado/agente do balcão | Baixa | `postgres_changes` em `counters` filtrado por `branch_id`, refetch via view `counters_with_agent` | Alta |
| `onSnapshot` em `counters` (colecção) | `queue.ts: subscribeCounters` → `AgentScreen` (balcões para transferir), `Dashboard` | Lista de balcões | Baixa | idem, colecção completa | Alta |
| `onSnapshot` em `liveBoard/current` | `queue.ts: subscribeLiveBoard` → `PublicDisplay` (painel TV), `Dashboard` | Última senha chamada + histórico | Alta (cada chamada) | `postgres_changes` em `ticket_calls` (log append-only, substitui o singleton mutável), refetch das últimas 5 linhas | Alta |
| `onSnapshot` em `tickets` (`createdAt>=hoje`) | `queue.ts: subscribeTicketsToday` → `Dashboard` (KPIs), `PublicDisplay` (tempo médio) | Todas as senhas de hoje | Média | `postgres_changes` em `tickets` filtrado por `branch_id`, refetch com `gte(created_at)` | Média |
| `onSnapshot` em `appointments` (`createdAt>=hoje`) | `queue.ts: subscribeAppointmentsToday` → `Dashboard` (KPI agendamentos) | Agendamentos de hoje | Baixa | `postgres_changes` em `appointments` filtrado por `branch_id` | Média |
| `onSnapshot` em `ratings` (`createdAt>=hoje`) | `queue.ts: subscribeRatingsToday` → `Dashboard` (resumo de qualidade) | Avaliações de hoje | Baixa | `postgres_changes` em `ratings` filtrado por `branch_id` | Baixa |
| `signInAnonymously` (não é listener) | `PublicDisplay.tsx` | Sessão anónima do painel de TV | Uma vez | `supabase.auth.signInAnonymously()` (feature nativa activada nesta fase — ver Fase 6/10) | Alta |
| `setInterval(30s)` (não é Firebase) | `PublicDisplay.tsx` | Relógio de parede exibido | A cada 30s | Sem alteração — é só `new Date()`, cosmético, não lê nenhum dado de negócio | N/A |

## `projectogestaodefilas` (Flutter/cliente)

| Firebase atual (antes) | Local no código | Evento/dado recebido | Frequência | Substituição Supabase | Prioridade |
|---|---|---|---|---|---|
| `.snapshots()` em `tickets/{id}` | `ticket_service.dart: subscribeTicket` → `QueueScreen`/`AlmostScreen`/`CalledScreen`, `GlobalQueueAlerts` | Estado da minha senha | Alta | `postgres_changes` em `tickets` filtrado por `id` | Alta |
| `.snapshots()` em `liveBoard/current` | `ticket_service.dart: subscribeLiveBoardCurrent` → `GlobalQueueAlerts` ("chamar novamente") | Última chamada do painel | Alta | `postgres_changes` em `ticket_calls` filtrado por `branch_id` | Alta |
| `.snapshots()` em `counters/{id}` | `ticket_service.dart: subscribeCounterStatus` → `GlobalQueueAlerts` (detectar pausa) | Estado do balcão que me atende | Baixa | `postgres_changes` em `counters` filtrado por `branch_id` | Alta |
| `.snapshots()` em `tickets` (`status=='waiting'`) | `ticket_service.dart: subscribeWaitingAhead` → `QueueScreen` (posição na fila) | Contagem de senhas à minha frente | Alta | `postgres_changes` em `tickets` filtrado por `branch_id` | Alta |
| `.snapshots()` em `tickets` (`status=='waiting'`) | `ticket_service.dart: subscribeQueueSize` → `LocationCard` (nº pessoas antes de entrar) | Tamanho da fila | Média | idem | Média |
| `.snapshots()` em `tickets` (`status=='waiting'`) | `ticket_service.dart: subscribeWaitingServiceNames` → `ChooseServiceScreen` (contagem por serviço) | Serviços em espera | Média | idem | Média |
| `.snapshots()` em `tickets` (`customerUid==...`) | `ticket_service.dart: subscribeMyTickets` → `MyAppointmentsScreen` | Todas as minhas senhas | Média | `postgres_changes` em `tickets` filtrado por `branch_id`, refetch com `eq(customer_id)` | Alta |
| `.snapshots()` em `users/{uid}/appointments` | `app_stores.dart: AppointmentsStore` → ecrã Agendamentos | Meus agendamentos | Baixa | `postgres_changes` em `appointments` filtrado por `customer_id` (tabela agora unificada, sem espelho) | Alta |
| `.snapshots()` em `users/{uid}/history` | `app_stores.dart: HistoryStore` → (nenhum ecrã lê hoje, superado por `subscribeMyTickets`) | Histórico local antigo | — | **Removido**: passou a memória local (ver `docs/testing.md` e nota no código) — nenhum consumidor real, não se inventou tabela nova só para isto | N/A (decisão já tomada na Fase 10) |
| `.snapshots()` em `users/{uid}/notifications` | `app_stores.dart: NotificationsStore` → sino do `HomeScreen`, `NotificationsScreen` | Notificações do cliente | Alta (cada aviso) | `postgres_changes` em `notifications` filtrado por `user_id` | Alta |
| `.snapshots()` em `users/{uid}/settings/preferences` | `app_stores.dart: NotificationSettings` + `AppLanguageController` → ecrã Notificações/Definições | Preferências | Baixa | `postgres_changes` em `user_settings` filtrado por `user_id` (mesma linha para as duas stores) | Baixa |

## Confirmações desta auditoria

- Não existe nenhum `StreamBuilder`/listener a ler `ratings` ou `appointments` do lado do cliente Flutter em tempo real hoje — só escreve (`submitRating`, `scheduleAppointment`) e lê a lista dos SEUS PRÓPRIOS agendamentos (`AppointmentsStore`). `ratings` só é lido em tempo real do lado da equipa (`Dashboard`).
- Não foi encontrado nenhum `Timer.periodic`/`setInterval` a fazer *polling* de dados de negócio em nenhum dos dois repos — o único timer é o relógio cosmético do painel de TV.
- `GlobalQueueAlerts` (Flutter) não é um mecanismo de tempo real novo — é o orquestrador que já existia, que combina três das subscrições acima (`subscribeTicket`, `subscribeLiveBoardCurrent`, `subscribeCounterStatus`) por senha activa, num `Map<String, _TicketWatch>` com `cancel()` explícito — ver `docs/realtime-architecture.md`, secção de *lifecycle*.
