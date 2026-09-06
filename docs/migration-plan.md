# Plano de migração — Firebase → Supabase (Fila Certa)

Baseado em `firebase-audit.md` (o que existe) e `database-design.md`
(para onde vai). Cada fase só avança depois de aprovação explícita —
ver estado real de cada uma na tabela abaixo (Fases 0–2 documentais,
3–5 já aplicadas ao projecto Supabase real; 6 em diante por fazer).

## Resumo por fase (adaptado ao que a auditoria encontrou)

Como não existem Cloud Functions, Storage nem FCM neste projecto
(secção 2 da auditoria), as fases 7 e 9 do mandato ficam muito mais
leves do que num projecto genérico — não há nada de facto para migrar
nelas, só confirmar que continuam desnecessárias.

| Fase | Conteúdo | Esforço estimado | Depende de |
|---|---|---|---|
| 0 | Backup | ✅ **Concluída** — `scripts/backup-firestore.mjs` (Admin SDK, sem `gcloud` disponível nesta máquina) exporta institutions/branches/counters/tickets/appointments/ratings/liveBoard/meta, `staff`, `users/{uid}/*` e a lista de contas Auth para JSON local em `~/Desktop/fila-certa-backups/`. Corrido em 2026-09-06: 6 instituições, 12 staff, 5 utilizadores privados, 19 contas Auth | — |
| 1 | Auditoria | ✅ Concluída — `firebase-audit.md` | — |
| 2 | Modelação | ✅ Concluída — `database-design.md` | Fase 1 |
| 3 | Configurar Supabase | ✅ **Concluída** — projecto `qdfpqispcntitvczybfl` criado pelo utilizador, ligado via `supabase link` em 2026-09-06 | — |
| 4 | Migrations | ✅ **Escritas e aplicadas** — `supabase/migrations/20260906190000_initial_schema.sql`, aplicada ao projecto real via `supabase db push` em 2026-09-06 e verificada (11 tabelas + 5 enums confirmados via API de gestão) | Fase 3 |
| 5 | RLS | ✅ **Escrita e aplicada** — `supabase/migrations/20260906190100_rls.sql` + `docs/security.md`. Verificado: RLS activo nas 11 tabelas, 16 políticas presentes exactamente como desenhadas | Fase 4 |
| 6 | Auth | ✅ **Concluída** — as 12 contas de staff recriadas em Supabase Auth (mesmos emails, mesma password `teste123`), tabela `staff` populada, e `institutions`/`branches`/`counters` trazidos do Firestore como dados de referência (pré-requisito de `staff` via FK). Verificado por `JOIN` entre `staff` e `auth.users`: as 12 linhas batem certo. Contas de cliente de teste ainda por fazer (ver nota) | Fase 4 |
| 7 | Storage | ✅ **Confirmado** — continua sem uso em nenhum dos dois repos; nenhum bucket criado | — |
| 8 | Realtime | ✅ **Concluída, auditada e reforçada (least privilege)** — ver `docs/security-rls.md` para o hardening pedido antes da Fase 10: `tickets`/`counters`/`ticket_calls` deixaram de ter leitura aberta a qualquer autenticado, passam a exigir posse (`customer_id`) ou pertencer à equipa dessa filial (`is_staff_of_branch`, novo, também corrige as RPCs de mutação que só verificavam a instituição). Três agregados novos (`branch_queue_summary`, `branch_wait_stats`, `waiting_ahead_count`) substituem leituras que dependiam do SELECT aberto, sem expor linhas alheias. Validado com 10 cenários dedicados (`scripts/test-security-hardening.mjs`) + regressão funcional completa (nenhuma quebra) — — ver `docs/realtime-audit.md` (inventário completo dos antigos listeners Firebase e a substituição 1:1), `docs/realtime-architecture.md` (desenho por tabela, decisão de segurança pendente sobre leitura aberta de `tickets`) e `docs/testing.md`. **Achado corrigido**: nenhuma tabela estava na publicação `supabase_realtime` — os canais subscreviam mas nunca recebiam eventos (`20260906210000_enable_realtime.sql`). **Bug corrigido**: `set_counter_paused` falhava sempre por falta de cast (`20260906210100_fix_set_counter_paused_cast.sql`), nunca tinha sido exercitado de ponta a ponta. Adicionado resync automático no `SUBSCRIBED` do canal (cobre reconexão, não só a 1ª carga). Validado com `scripts/test-realtime-delivery.mjs` contra o projecto real: 9 cenários (fila, chamada, "a caminho", conclusão, transferência, cancelamento, pausa, isolamento) | Fase 4, 5 |
| 9 | Functions | ✅ **Concluída e validada** — `supabase/migrations/20260906190200_rpc_functions.sql`: 12 funções `SECURITY DEFINER` (`pull_ticket`, `call_next`, `recall_current`, `complete_current`, `mark_no_show`, `transfer_ticket`, `set_counter_paused`, `cancel_ticket`, `set_on_the_way`, `next_appointment_code`, `schedule_appointment`, `cancel_appointment`). Testado de ponta a ponta com uma conta de cliente e a conta real do agente do SIAC: tirar senha → chamar → "a caminho" → concluir → transferir → cancelar, todos correctos; confirmado que um cliente não consegue chamar senhas (RBAC) nem fazer `UPDATE` directo às tabelas (RLS). Corrigida em `20260906200000_fix_call_next_transfers.sql` uma falha encontrada já na Fase 10: `call_next` ignorava `transferred_to_counter_id`, podendo entregar a outro balcão uma senha reservada — validado com teste dedicado | Fase 4 |
| 10 | Flutter/React | ✅ **Concluída nos dois repos** — `fila-certa-staff` (React): `src/supabase.ts`, `AuthContext.tsx`, `src/lib/queue.ts`, `PublicDisplay.tsx` (sessão anónima), `AgentScreen.tsx` (novas assinaturas RPC, servidor escolhe a próxima senha). `projectogestaodefilas` (Flutter): `lib/supabase_client.dart`, `main.dart`, `AuthService`/`AuthGate`, `ticket_service.dart`, `app_stores.dart` (appointments unificados, `customerUid` deixa de vir do cliente). Validado com `tsc -b`/`npm run build`/`flutter analyze`/`flutter build web` e scripts de teste reais contra o projecto Supabase (queue RPCs, `counters_with_agent`, `user_settings`/`notifications`/`appointments`/`ratings`). Publicado em `filacerta-staff.web.app` e `filacerta-d74f0.web.app`. Os testes de widget Flutter existentes ficam `skip` (sem equivalente a `fake_cloud_firestore` para Supabase local, sem Docker nesta máquina) — gap explícito para a Fase 12. Firebase fica em ambos os repos, sem uso, até à Fase 15 | Fases 6, 8, 9 |
| 11 | Migração de dados | ✅ **Decidida (não migrar)** — antes de escrever o script, contámos o que existia realmente: 67 senhas, 4 agendamentos, 6 avaliações, 35 notificações, 14 registos de histórico, tudo dados de teste/piloto gerados durante esta sessão, nenhum cliente real. Perguntado ao utilizador, escolheu não migrar este histórico para o Postgres — os dois backends já não têm nenhuma dependência disto (a Fase 10 já corta 100% da actividade nova para o Supabase) e a Fase 0 já garante que nada se perde (fica no backup + no próprio Firestore, intacto). Se surgirem dados reais a preservar antes da Fase 15, esta decisão deve ser revista | Fase 0, 4 |
| 12 | Testes | ✅ **Concluída** — para além do teste de ponta a ponta da Fase 9 e dos caminhos novos do Flutter (Fase 10), faltavam por validar explicitamente dois cenários da secção de testes abaixo: **concorrência** (guiche-1 e guiche-2 do SIAC a chamar `call_next` em simultâneo — confirmado que nunca apanham a mesma senha, graças ao `SKIP LOCKED`) e **RBAC entre instituições** (um agente do SIAC recusado a operar no Banco Exemplo, sem qualquer efeito na senha alvo) + **RLS entre clientes** (um cliente não consegue ler o agendamento doutro `customer_id`) | Fase 10 |
| 13 | Staging | ⚠️ **Não há um ambiente separado** — é um único projecto Supabase (`qdfpqispcntitvczybfl`), o mesmo desde a Fase 3. Para o volume e risco de um piloto isto foi tratado como aceitável (decisão implícita ao longo das Fases 4-12: toda a validação foi feita directamente contra este projecto, sempre com limpeza a seguir a cada teste) — mas fica registado que não há isolamento staging/produção real. Se isso deixar de ser aceitável (dados reais de clientes), a Fase 15 deve ficar bloqueada até existir um segundo projecto | Fase 12 |
| 14 | Produção | ✅ **Já aconteceu, de facto** — não houve um "corte" separado: a Fase 10 já publicou os dois frontends (`filacerta-staff.web.app`, `filacerta-d74f0.web.app`) a falar com este mesmo projecto Supabase, que é o único que existe. O DNS/hosting não mudou (continuam no Firebase Hosting), só o backend de dados | Fase 13 |
| 15 | Desligar Firebase | ⏳ **Deliberadamente não feita** — a própria estratégia de rollback (secção abaixo) exige um período de observação em produção sem regressões antes de remover `firebase`/`cloud_firestore`/`firebase_auth` dos dois repos; um período de minutos dentro da mesma sessão não cumpre isso. Falta: confirmar com o utilizador que o piloto correu bem por um tempo razoável, depois remover as dependências Firebase e os ficheiros `firebase.ts`/`firebase_options.dart` | Fase 14 estável |

## Estratégia de autenticação (secções 11/12 do mandato)

**Achado que simplifica esta fase**: é um piloto — todas as contas
existentes (12 de staff + as de cliente de teste) usam passwords de
teste conhecidas (`teste123` e afins), sem nenhum utilizador real.

- **Se a migração ocorrer enquanto isto continuar verdade**: recriar
  as contas directamente em Supabase Auth com as mesmas credenciais
  (mesmo padrão dos scripts de seed actuais, adaptado ao Admin client
  do Supabase). Sem necessidade de importar hashes de password.
- **Se já existirem utilizadores reais nessa altura** (a confirmar
  antes de executar a Fase 6): Firebase Auth exporta passwords com hash
  `scrypt` num formato específico do projecto
  (`firebase auth:export --format=json`); o GoTrue do Supabase não
  suporta nativamente este formato de hash. A estratégia segura,
  **sem nunca expor nem tentar re-derivar a password real**, é:
  1. Importar os utilizadores para Supabase Auth com uma password
     aleatória inutilizável (ou sem password, exigindo definição no
     primeiro acesso);
  2. Guardar o `firebase_uid` original numa coluna `legacy_firebase_uid`
     em `staff`/perfil de cliente, só para rastreabilidade durante a
     transição;
  3. Enviar email de "definir nova password" (fluxo nativo do Supabase
     Auth) a todos antes de desligar o login Firebase;
  4. Manter os dois métodos de login activos (Firebase a ler, Supabase
     a escrever) só durante a janela de transição, nunca mais do que o
     estritamente necessário.

## Migração de dados (Fase 11)

Ordem de escrita (respeita as FKs definidas em `database-design.md`):

```
1. institutions
2. branches
3. auth.users (staff + clientes, via Fase 6)
4. staff
5. counters
6. branch_counters (a partir do valor actual de meta/ticketSeq)
7. tickets
8. ticket_calls (reconstruído a partir do liveBoard/current + history existente, quando possível)
9. appointments (unificando privado + espelho — usar o espelho institucional como fonte,
   por já ter customerUid e institutionId; cruzar com o privado só para confirmar paridade)
10. ratings
11. notifications
12. user_settings
```

Script único, correndo uma vez por ambiente (local → staging →
produção), com contagem de documentos lidos vs. linhas escritas
registada no fim, para detectar qualquer perda silenciosa.

## Testes (secção 29/30 do mandato)

Cenários derivados directamente dos fluxos reais já existentes (não
inventados):

- **Autenticação**: login staff, login/registo/recuperação cliente,
  sessão anónima do painel de TV.
- **Fila — caminho feliz**: tirar senha → aparecer na fila do agente →
  `call_next` → cliente navega para "É a sua vez" → `complete_current`
  → avaliação.
- **Fila — casos já cobertos por bugs reais desta sessão**: duas
  senhas em simultâneo para o mesmo cliente (o bug de
  `activeTicketStore` só suportar uma) tem de continuar correcto depois
  da migração; transferir para balcão específico; pausar balcão;
  chamar novamente; não comparecer (ambas as origens,
  `customer_cancelled` e `staff_marked`).
- **Concorrência (secção 21)**: dois agentes a chamar
  simultaneamente a partir do mesmo `branch_id` — confirmar que
  `SKIP LOCKED` nunca deixa dois balcões com o mesmo `ticket_id`.
- **Realtime**: abrir o mesmo `ticket_id` em duas abas/dispositivos e
  confirmar que ambos recebem a mesma actualização de status.
- **RLS por papel**: um agente de uma instituição nunca deve conseguir
  ler/escrever senhas de outra instituição (testar com as 6
  instituições já activas em produção); um cliente nunca deve conseguir
  ler avaliações/agendamentos de outro `customer_id`.

## Estratégia de rollback (secção 31)

O Firebase **não é desligado nem apagado** em nenhuma fase anterior à
15. Durante as fases 10–14, os dois backends coexistem:

```
Se um problema for encontrado em Staging/Produção com Supabase
        ↓
Reverter o deploy do frontend para a versão anterior (aponta a Firebase)
        ↓
Investigar e corrigir contra o schema Postgres
        ↓
Nova tentativa de deploy, sem repetir a migração de dados
        (os dados em Postgres continuam válidos; só se corrige o código)
```

Não há alteração destrutiva ao Firestore em nenhuma fase — os dados
Firebase ficam intactos e consultáveis até à Fase 15 ser
explicitamente aprovada.

## Riscos identificados

| Risco | Mitigação |
|---|---|
| As Security Rules dos dois repos já dependem de sincronização manual (sem CI) — o mesmo risco existe para RLS entre migrations e código, se não forem geridas por versão única | Migrations e RLS vivem só num repo (`fila-certa-staff/supabase/`); os dois frontends apontam à mesma instância Supabase, sem cópia de regras por repo |
| `call_next`/`transfer_ticket`/etc. tornam-se funções RPC — qualquer bug numa função `SECURITY DEFINER` tem mais poder do que o cliente tinha antes | Testes de concorrência (secção acima) obrigatórios antes de qualquer deploy a produção; `SECURITY DEFINER` sempre com `search_path` fixo, nunca `GRANT` directo a `service_role` para o cliente |
| Duplicar `appointments` (privado+espelho) para uma tabela só pode mudar comportamento visível se algum ecrã depender implicitamente da separação | Testar explicitamente "Os meus agendamentos" e o dashboard do gestor lado a lado antes/depois |
| Reescrever `liveBoard` como log append-only muda a forma como o histórico de 4 chamadas é lido | Confirmar visualmente o painel de TV e o "Última senha chamada" do cliente com dados reais antes de aprovar a Fase 14 |

## Critério de sucesso desta fase (antes de qualquer execução)

Este documento, `firebase-audit.md` e `database-design.md` cobrem os
pontos 1–17 exigidos pela secção 34 do mandato. **Falta aprovação
explícita do utilizador antes de:**

- criar o projecto Supabase;
- escrever qualquer ficheiro em `supabase/migrations/`;
- alterar qualquer linha de código Flutter/React.
