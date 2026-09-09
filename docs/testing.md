# Estratégia de testes — migração Firebase → Supabase

## Gap conhecido: widget tests Flutter (`test/widget_test.dart`)

**O que estava `skip`**: as 4 suites de `flutter_test` que exercitavam o
fluxo completo da app (entrar na fila, agendar, catálogo do SIAC, todos
os ecrãs alcançáveis).

**Porquê dependiam de `fake_cloud_firestore`**: antes da Fase 10, cada
teste chamava `_signInFakeUser()`, que apontava os dois globais
mutáveis do projecto (`authService` e `firestoreInstance`) para
`MockFirebaseAuth`/`FakeFirebaseFirestore` — uma conta "autenticada" e
uma base de dados inteiramente em memória, sem nenhuma rede. Isto dava
testes rápidos, determinísticos, sem custo, e sem tocar em dados reais.

**Porquê deixou de ser adequado**: depois da Fase 10, `AuthService`
envolve `SupabaseClient.auth` e `ticket_service.dart`/`app_stores.dart`
chamam `supabaseClient.rpc(...)`/`.from(...).select(...)` diretamente.
Não existe hoje um pacote equivalente e maduro a `fake_cloud_firestore`
para simular um `SupabaseClient` inteiro (Auth + Postgres + Realtime)
em memória — a alternativa real seria correr um Supabase local via CLI
(`supabase start`), que precisa de Docker, indisponível nesta máquina
(confirmado: tentei localizar o Docker Desktop nesta sessão e não
existe instalado). Criar uma simulação parcial só para "passar os
testes" sem validar nada real teria sido pior do que ser honesto sobre
o gap — por isso ficaram `skip`, com o motivo documentado no próprio
ficheiro, em vez de apagados ou reescritos para uma forma que finge
cobertura.

**Estratégia de substituição (decidida agora, na Fase 8)**:

1. **Separar UI de acesso a dados** — os widgets já não chamam
   `supabaseClient` directamente (só passam por `ticket_service.dart`/
   `app_stores.dart`, que actuam como *repository/data source*, ver
   `docs/realtime-architecture.md`). Isto significa que, quando um
   widget test precisar de simular dados, o ponto de substituição
   correcto é essa camada — não o `SupabaseClient` inteiro.
2. **Testes de widget "puros"** (a fazer, ainda não feito): funções
   como `_findLocationByIds`, `MyTicket.statusLabel`, o mapeamento
   `ticketFromRow`/`_myTicketFromRow`, e os widgets que só recebem dados
   já resolvidos por parâmetro (a maioria dos ecrãs de fluxo:
   `AppointmentConfirmedScreen`, `RatingScreen` antes de submeter,
   `NotificationsScreen` dado uma lista) podem e devem voltar a ter
   testes unitários/widget normais, sem tocar em rede nenhuma — não
   dependem do Supabase para renderizar.
3. **Testes de integração real** (feito nesta fase, ver secção
   seguinte): os fluxos que dependem de dados ao vivo (tirar senha,
   chamar, transferir, notificações, Realtime) são validados por
   scripts Node contra o projecto Supabase real (`qdfpqispcntitvczybfl`),
   sempre com limpeza no fim, nunca contra produção com dados reais de
   clientes (que hoje não existem — é um piloto).
4. **Pendente, fora do âmbito desta fase**: reescrever
   `test/widget_test.dart` como testes de widget "puros" (ponto 2) +
   um conjunto de testes de integração Dart (`integration_test`) que
   corram contra o mesmo projecto Supabase real, à semelhança dos
   scripts Node — exige decidir se cada corrida cria/limpa os seus
   próprios dados (mesma disciplina dos scripts actuais) ou se passa a
   haver um projecto Supabase dedicado a testes automáticos (seria a
   Fase 13, "Staging", que também ainda não tem ambiente próprio — ver
   `docs/migration-plan.md`).

## Testes executados nesta fase (Fase 8)

Todos contra o projecto Supabase real, com contas de teste criadas e
apagadas em cada corrida (nunca contra dados reais).

### A. RPCs (relação com o Realtime)

As RPCs críticas já tinham sido testadas na Fase 9
(`scripts` da altura, ver `docs/migration-plan.md`) e na Fase 12
(concorrência, RBAC entre instituições). Essa validação cobre que o
**estado final na base de dados** fica correcto; não cobria que esse
estado chegasse aos clientes **via Realtime**. Esta fase fecha esse
elo — ver secção D.

### B. Testes unitários

Não foram criados nesta fase — não havia nenhuma transformação de dados
nova que justificasse um teste isolado (os mapeamentos `*FromRow` já
existiam da Fase 10 e não mudaram). Fica como trabalho da secção
"pendente" acima.

### C. Testes de integração (RLS/RBAC, fora do Realtime)

`scripts/test-phase12.mjs` (já existente, reconfirmado): concorrência
entre balcões, RBAC entre instituições, RLS entre clientes em
`appointments`.

### D. Testes de Realtime (novo, `scripts/test-realtime-delivery.mjs`)

Ligação real por `@supabase/supabase-js`, um cliente por papel
(cliente, agente, gestor), cada um autenticado a sério, a subscrever
canais `postgres_changes` genuínos (não simulados) e a confirmar
recepção do evento certo com timeout:

| Cenário | Resultado |
|---|---|
| Cliente tira senha → atendente recebe `INSERT` em `tickets` | ✅ |
| Atendente chama (`call_next`) → cliente recebe `UPDATE status=serving` | ✅ |
| Cliente avisa "estou a caminho" → atendente vê `customer_on_the_way=true` | ✅ |
| Atendimento concluído → balcão fica `available` (painel/gestor) | ✅ |
| Transferência → cliente vê a senha voltar a `waiting`, reservada ao novo balcão | ✅ |
| Cancelamento pelo cliente → gestor vê `no_show`/`customer_cancelled` | ✅ |
| Pausar balcão → cliente em atendimento recebe `status=paused` | ✅ (só depois da correcção, ver "Problemas encontrados") |
| `tickets`: leitura aberta por desenho — cliente B recebe eventos de senha do cliente A | ✅ confirmado (comportamento intencional, ver `docs/realtime-architecture.md`, "Decisão pendente") |
| `appointments`: isolamento por `customer_id` — cliente B NÃO recebe evento do cliente A | ✅ |

**Não testado nesta fase** (gap explícito):

- Reconexão real após perda de ligação (exigiria simular quebra de rede
  a meio da execução do script; o fix de resync-on-`SUBSCRIBED` foi
  aplicado e é logicamente correcto — dispara sempre que o canal
  (re)confirma subscrição — mas não foi observado sob uma queda de rede
  real).
- Dois atendentes em dispositivos fisicamente diferentes (o teste usa
  dois clientes `supabase-js` no mesmo processo Node, que é
  equivalente do ponto de vista do servidor, mas não é literalmente
  "dois dispositivos").
- Testes automatizados do lado Flutter/React em si (widgets a re-renderizar
  quando o `Stream`/estado muda) — validado manualmente por leitura de
  código (`StreamBuilder`/`ValueListenableBuilder` já reagem a qualquer
  mudança do `Stream`/`ValueNotifier`, sem lógica condicional que
  pudesse escapar disto), não por um teste automatizado dedicado.

## Hardening de segurança (least privilege, pré-Fase 10)

Depois do achado da Fase 8 (leitura aberta de `tickets`/`counters`/
`ticket_calls`), foi pedido um hardening dedicado antes de avançar para
a Fase 10. Ver `docs/security-rls.md` para a auditoria e matriz de
acesso completas. Testes novos:

### `scripts/test-security-hardening.mjs` — os 10 cenários pedidos

Sempre a testar REST **e** Realtime onde fizer sentido (nunca só um dos
dois), incluindo uma filial temporária criada só para o teste (os dados
de seed só tinham 1 filial por instituição, insuficiente para testar
isolamento entre filiais):

| # | Cenário | Resultado |
|---|---|---|
| 1 | Cliente A → próprio ticket | ✅ |
| 2 | Cliente A → ticket do Cliente B (REST + Realtime) | ✅ bloqueado nos dois planos |
| 3 | Cliente A → ticket de outra instituição | ✅ bloqueado |
| 4 | Cliente A → ticket de outra filial (mesma instituição) | ✅ bloqueado |
| 5 | Atendente → tickets da própria filial | ✅ permitido |
| 6 | Atendente → tickets/RPC de outra filial | ✅ bloqueado nos dois planos (REST e `call_next`) |
| 7 | Gestor → dados do seu âmbito | ✅ permitido |
| 8 | Gestor → dados fora do seu âmbito | ✅ bloqueado |
| 9 | Realtime → evento autorizado (própria senha) | ✅ |
| 10 | Realtime → evento não autorizado (senha alheia) | ✅ bloqueado |

### Regressão funcional completa (secção 9 do pedido)

Re-executados depois do hardening, todos ✅: `scripts/test-realtime-delivery.mjs`
(9 cenários, incluindo o 8a actualizado para confirmar o novo
isolamento em vez do comportamento antigo), `scripts/test-phase12.mjs`
(concorrência entre balcões + RBAC), `test-phase9.mjs`
(ciclo completo tirar→chamar→a caminho→concluir→transferir→cancelar),
`test-flutter-data-paths.mjs` (notifications/user_settings/appointments/
ratings), e o novo `scripts/test-public-aggregates.mjs` (os três
agregados que substituem leituras agora bloqueadas).

**Nenhuma regressão encontrada** — todos os cenários que já
funcionavam antes do hardening continuam a funcionar depois.

## Testes pendentes (fora do âmbito da Fase 8)

- Reescrita de `test/widget_test.dart` (ver secção do gap acima).
- Teste de carga/volume de Realtime (nº de canais simultâneos sob uso
  real do piloto) — sem dado real de produção para o dimensionar ainda.
- Purga/retenção de `ticket_calls` (cresce indefinidamente).
