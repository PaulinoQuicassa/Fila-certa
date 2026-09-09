# Auditoria final do frontend — Fase 10

Auditoria pedida antes de (re)confirmar a Fase 10. Como a migração do
frontend já tinha sido executada nesta sessão (ver
`docs/migration-plan.md`, Fase 10, e os commits `d286f5c`/`52ab1fb`),
esta auditoria é uma **verificação rigorosa do que já existe**, não uma
descoberta de trabalho por fazer — confirmada por `grep` directo ao
código nesta ronda (não por memória), exactamente como pedido ("não
assumas que algo está migrado só porque existe código Supabase").

## Pacotes Firebase declarados vs. realmente usados

| Pacote | Repo | Declarado em | Importado por algum ficheiro de runtime? | Estado |
|---|---|---|---|---|
| `firebase` (JS SDK) | `fila-certa-staff` | `package.json` | Só `src/firebase.ts`, que **nenhum outro ficheiro importa** (confirmado por grep) | Órfão, não removido (rollback) |
| `firebase-admin` | `fila-certa-staff` | `package.json` (devDependency) | `scripts/*.mjs` (seed, backup, contagem) | Uso legítimo — ferramentas de operação, não frontend |
| `firebase_core` | `projectogestaodefilas` | `pubspec.yaml` | Só `lib/firebase_options.dart`, que **nenhum outro ficheiro importa** | Órfão, não removido (rollback) |
| `firebase_auth` | `projectogestaodefilas` | `pubspec.yaml` | Nenhum ficheiro (zero imports) | Órfão, não removido (rollback) |
| `cloud_firestore` | `projectogestaodefilas` | `pubspec.yaml` | Nenhum ficheiro (zero imports) | Órfão, não removido (rollback) |
| Storage (Firebase) | ambos | — | Nunca existiu (confirmado na Fase 1, `firebase-audit.md`, e reconfirmado agora) | N/A |
| Firebase Messaging (FCM) | ambos | — | Nunca existiu | N/A |
| Firebase Analytics | ambos | — | Nunca existiu | N/A |
| Firebase Crashlytics | ambos | — | Nunca existiu | N/A |
| Firebase Functions | ambos | — | Nunca existiu (confirmado na Fase 1) | N/A |

**Conclusão**: não há nenhuma dependência *funcional* de Firebase em
nenhum dos dois repos — só ficheiros/pacotes órfãos, deliberadamente
não removidos (estratégia de rollback da Fase 10/15, ver
`docs/migration-plan.md`).

## Módulos — mapeamento completo

| Firebase (antes) | Ficheiro | Função | Substituto Supabase | Estado | Prioridade |
|---|---|---|---|---|---|
| `firebase/auth` (`onAuthStateChanged`, `signInWithEmailAndPassword`) | `fila-certa-staff/src/auth/AuthContext.tsx` | Login/sessão da equipa | `supabase.auth.onAuthStateChange`/`signInWithPassword` | ✅ Migrado | Alta |
| `firebase_auth` (`FirebaseAuth.instance`) | `projectogestaodefilas/lib/auth/auth_service.dart` | Login/sessão do cliente | `SupabaseClient.auth` | ✅ Migrado | Alta |
| `firebase_auth` (`authStateChanges`) | `projectogestaodefilas/lib/screens/auth_gate.dart` | Gate de navegação | `onAuthStateChange` | ✅ Migrado | Alta |
| `signInAnonymously` (Firebase) | `PublicDisplay.tsx` | Sessão do painel de TV | `ensureAnonymousSession()` (novo, ver correcção abaixo) | ✅ Migrado | Alta |
| `onSnapshot` (8 pontos) | `fila-certa-staff/src/lib/queue.ts` | Fila, balcões, painel, KPIs | `postgres_changes` + refetch (ver `docs/realtime-audit.md`) | ✅ Migrado | Alta |
| `.snapshots()` (12 pontos) | `projectogestaodefilas/lib/ticket_service.dart`, `app_stores.dart` | Idem, lado cliente | Idem | ✅ Migrado | Alta |
| `runTransaction` (Firestore) | `queue.ts` (6 funções) | Chamar/concluir/transferir/etc. | RPCs `SECURITY DEFINER` (Fase 9) | ✅ Migrado | Alta |
| `runTransaction` (Firestore) | `ticket_service.dart` (`pullTicket`, `nextAppointmentCode`) | Tirar senha, gerar código | RPCs `pull_ticket`/`next_appointment_code` | ✅ Migrado | Alta |
| `users/{uid}/appointments` (privado) + espelho institucional | `app_stores.dart: AppointmentsStore` | Agendamentos | Tabela única `appointments` + RPCs `schedule_appointment`/`cancel_appointment` | ✅ Migrado (unificado, sem duplicação) | Média |
| `users/{uid}/notifications` | `app_stores.dart: NotificationsStore` | Sino de notificações | Tabela `notifications` | ✅ Migrado | Média |
| `users/{uid}/settings/preferences` | `app_stores.dart: NotificationSettings`, `AppLanguageController` | Preferências | Tabela `user_settings` | ✅ Migrado | Baixa |
| `users/{uid}/history` | `app_stores.dart: HistoryStore` | Histórico local antigo | **Não migrado para tabela nova** — passou a estado só em memória (ver `docs/testing.md`); sem nenhum ecrã a lê-lo hoje, superado por `subscribeMyTickets` | ✅ Decisão tomada (não inventar tabela sem consumidor) | Baixa |
| `ratings` (create directo) | `ticket_service.dart: submitRating` | Avaliação do cliente | Insert directo em `ratings` (RLS, sem RPC — decisão da Fase 5) | ✅ Migrado | Média |

## Correcção feita nesta auditoria

`PublicDisplay.tsx` chamava `supabase.auth` directamente (bootstrap da
sessão anónima), fora da camada de dados (`src/lib/queue.ts`/
`src/supabase.ts`) — única violação encontrada do princípio "UI não
chama o cliente Supabase directamente" nos dois repos (Flutter já
estava 100% conforme, confirmado por grep). Corrigido: nova função
`ensureAnonymousSession()` em `src/supabase.ts`, chamada pela página em
vez do cliente directo.

## Auth: Firebase UID vs. Supabase UID

Confirmado (Fase 6, `docs/migration-plan.md`): não há nenhuma
suposição de UID igual entre os dois sistemas.
- **Staff**: contas recriadas em Supabase Auth com **novos UUIDs**,
  ligadas por email (não por UID) — `staff.id` referencia sempre
  `auth.users.id` do Supabase, nunca um UID do Firebase.
- **Clientes**: contas de teste criadas directamente no Supabase Auth
  (é um piloto, sem clientes reais a preservar — ver a estratégia de
  auth documentada em `docs/migration-plan.md`). `tickets.customer_id`,
  `appointments.customer_id`, `ratings.customer_id`,
  `notifications.user_id`, `user_settings.user_id` referenciam sempre
  `auth.users(id)` do Supabase.
- Nenhum código (grep confirmado) compara ou converte entre os dois
  formatos de UID.

## Storage / Messaging / Analytics / Crashlytics (secções 9-11 do pedido)

Reconfirmado nesta auditoria (não assumido da Fase 1): **nenhum dos
quatro foi alguma vez usado** em nenhum dos dois repos. Não há
buckets, não há tokens de push, não há eventos de analytics, não há
inicialização de Crashlytics em nenhum ficheiro. Documentar e não criar
complexidade — não migrado porque não existe nada para migrar.

## Configuração e segredos (secção 12)

Confirmado por grep em todo o código-fonte de ambas as apps: só a
**publishable/anon key** (`sb_publishable_...`) aparece no frontend
(React: `.env.local`/`.env.example`; Flutter: `lib/supabase_client.dart`,
com o mesmo valor hardcoded — não é secreta, ver comentário no
ficheiro). A `service_role` key (`sb_secret_...`) **nunca** aparece em
nenhum ficheiro `src/`/`lib/` — só em variáveis de ambiente passadas a
scripts Node de operação (`scripts/*.mjs`), executados manualmente
nesta máquina, nunca commitados nem embutidos em nenhum build.

## Feature flags / rollback (secção 16)

**Decisão: não introduzidas.** Os dois backends não correm em paralelo
hoje (o frontend fala só com Supabase); um flag `USE_SUPABASE_AUTH`
exigiria manter as DUAS implementações vivas e sincronizadas
indefinidamente, o que é mais risco (duas fontes de verdade) do que
protecção. O rollback real e já disponível é mais simples: o Firebase
Hosting guarda todas as versões anteriores (React) e o histórico git
tem o commit exacto anterior à migração (Flutter) — reverter é
reimplantar essa versão, sem precisar de nenhum código condicional novo.
Ver secção H do relatório final para o procedimento exacto.
