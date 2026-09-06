# Auditoria Firebase — Fila Certa (`filacerta-d74f0`)

Data: 2026-09-06. Cobre os dois repositórios que partilham o mesmo
projecto Firebase:

- `fila-certa-staff` (React + TypeScript + Vite) — app de equipa:
  login, ecrã de agente, dashboard do gestor, painel público de TV.
- `projectogestaodefilas` (Flutter, só a Web foi publicada) — app do
  cliente: escolher localização/serviço, tirar senha, acompanhar a
  fila, avaliar, agendar, notificações.

Tudo abaixo foi confirmado por leitura directa do código-fonte (grep +
leitura de ficheiros), não assumido.

## 1. Frontend

| | `fila-certa-staff` | `projectogestaodefilas` |
|---|---|---|
| Framework | React 19 + Vite + TypeScript | Flutter (Dart) |
| Router | `react-router-dom` v7 | `Navigator` nativo do Flutter (sem package de rotas) |
| Gestão de estado | `useState`/`useEffect` locais + um `AuthContext` (React Context) | `ValueNotifier`/`ChangeNotifier` (stores globais em `app_stores.dart`) + `StreamSubscription` directas a Firestore por ecrã |
| Plataformas publicadas | Web (`filacerta-staff.web.app`) | Web (`filacerta-d74f0.web.app`) — Android/iOS/macOS/Windows configurados mas **nunca testados nem publicados** |

Não há camada de repositório/serviço formal — os dois repos têm um
ficheiro central de acesso a dados (`src/lib/queue.ts` no staff,
`lib/ticket_service.dart` no cliente) que encapsula todas as
leituras/escritas Firestore, mas os ecrãs continuam a chamá-lo
directamente (sem interface abstrata, sem injecção de dependência).

## 2. Serviços Firebase em uso

| Serviço | Usado? | Evidência |
|---|---|---|
| **Authentication** | ✅ Sim | Email/password nos dois repos; sessão anónima só no painel de TV do staff |
| **Firestore** | ✅ Sim | Único serviço de dados do projecto inteiro |
| **Cloud Functions** | ❌ Não | Nenhuma pasta `functions/`, nenhum `httpsCallable`/`onCall`/`onRequest` em qualquer dos repos |
| **Storage** | ❌ Não | `firebase_storage`/`@firebase/storage` nunca importado; não há upload de imagens/ficheiros em lado nenhum |
| **Cloud Messaging (push)** | ❌ Não | `firebase_messaging` não está no `pubspec.yaml`; "notificações" são só um inbox Firestore lido em tempo real, sem push real |
| **Analytics / Crashlytics** | ❌ Não | Não usados |

**Implicação central para a migração**: toda a lógica de negócio crítica
(gerar código de senha sem colisão, chamar próximo, transferir, marcar
ausência, pausar balcão) corre hoje **no cliente**, dentro de
transacções do SDK do Firestore (`runTransaction`), protegida só pelas
Security Rules. Não existe nenhum backend/Cloud Function a validar isto
de forma centralizada. Isto viola directamente o princípio do ponto 20
do mandato ("não colocar lógica crítica no frontend") — é a maior
oportunidade de melhoria arquitectural desta migração (ver
`database-design.md`, secção "Funções RPC").

## 3. Firestore — modelo de dados actual

### Coleções partilhadas (mesmo projecto, lidas/escritas pelos dois repos)

```
staff/{uid}
  name, role ('agent'|'manager'), institutionId, branchId, counterId?

institutions/{institutionId}
  name

institutions/{institutionId}/branches/{branchId}
  name

institutions/{iid}/branches/{bid}/counters/{counterId}
  label, status ('available'|'serving'|'paused'), currentTicketId, agentName

institutions/{iid}/branches/{bid}/tickets/{ticketId}
  code, service, priority, status ('waiting'|'called'|'serving'|'done'|'no_show'),
  counterId, createdAt, calledAt, doneAt, transferredToCounterId,
  noShowReason ('customer_cancelled'|'staff_marked'), wasTransferred,
  customerOnTheWay, customerUid

institutions/{iid}/branches/{bid}/liveBoard/current
  current {code, counterLabel}, history [até 4 entradas], updatedAt

institutions/{iid}/branches/{bid}/appointments/{code}
  customerUid, serviceName, date, time, createdAt, status ('scheduled'|'cancelled')
  -- espelho institucional de users/{uid}/appointments, mesmo "code" como id

institutions/{iid}/branches/{bid}/ratings/{ticketId}
  customerUid, serviceName, overall, recommend, comment,
  aspects {atendimento, tempoEspera, organizacao, instalacoes}, createdAt

institutions/{iid}/branches/{bid}/meta/ticketSeq
  seq (int) -- contador partilhado: gera código das senhas E dos agendamentos
```

### Coleções privadas (só no cliente, nunca lidas pelo staff)

```
users/{uid}/appointments/{code}
  locationMonogram, serviceName, date, time

users/{uid}/history/{autoId}
  bank, monogram, service, date, ticket, status ('completed'|'missed'), rating, createdAt

users/{uid}/notifications/{autoId}
  title, subtitle, read, createdAt

users/{uid}/settings/preferences
  queueAlerts, appointmentReminders, promotions, whatsapp, language
```

### Observações sobre o modelo actual

1. **Duplicação agendamentos privado ↔ espelho institucional.** Existe
   porque o Firestore não tem uma forma elegante de dar visibilidade
   condicional (dono OU equipa da instituição) ao mesmo documento sem
   duas cópias. Em Postgres com RLS isto resolve-se numa tabela só —
   ver `database-design.md`.
2. **`users/{uid}/history` pode estar redundante** com a nova vista
   "Os meus atendimentos" (que já lê `tickets` directamente,
   introduzida numa iteração recente). É uma decisão a validar, não
   uma correcção óbvia — ver secção de decisões.
3. **`TicketStatus` inclui `'called'`**, que nunca é escrito em código
   nenhum dos dois repos (confirmado por grep) — só existe por
   compatibilidade histórica. Não propagar para o novo enum sem
   necessidade real.
4. **Não existe uma coleção `services`.** Nomes de serviço são texto
   livre, definidos apenas como dados estáticos no cliente Flutter
   (`ServiceItem`), sem validação/referência no Firestore. Isto é uma
   lacuna de integridade referencial pré-existente, não introduzida por
   esta auditoria.
5. **`liveBoard/current`** é um documento mutável com um array
   `history` limitado a 4 entradas — um padrão típico de Firestore
   (para poupar leituras) mas que não faz sentido em Postgres, onde um
   log append-only com uma query é estritamente melhor (ver design).

## 4. Segurança (Firestore Security Rules)

`fila-certa-staff/firestore.rules` e `projectogestaodefilas/firestore.rules`
são **idênticos** em regras (só o comentário de cabeçalho difere) —
confirmado por diff byte-a-byte a partir da declaração do `service`.
Não há qualquer automação/CI a garantir que se mantenham sincronizados;
é um processo manual, disciplinado mas frágil.

Resumo das regras:

| Caminho | Leitura | Escrita |
|---|---|---|
| `users/{uid}/**` | só o dono | só o dono |
| `staff/{uid}` | só o dono | nunca (só Admin SDK/seed) |
| `institutions/{iid}/**` (geral) | qualquer autenticado | só staff dessa instituição |
| `.../tickets/{id}` | (herda a regra geral) | cliente pode `create` a própria senha; `update` só para desistir ou avisar "a caminho" |
| `.../appointments/{id}` | (herda) | cliente pode `create`/cancelar o próprio |
| `.../ratings/{id}` | (herda) | cliente pode `create` uma vez, nunca `update` |
| `.../meta/ticketSeq` | (herda) | incrementar exactamente +1 |

Papéis reais encontrados no código: **`agent`**, **`manager`** (staff),
e implicitamente **cliente autenticado** (qualquer utilizador com conta
normal) e **sessão anónima** (só o painel de TV). **Não existe** papel
de administrador/super-admin em lado nenhum — não deve ser inventado
sem pedido explícito.

## 5. Autenticação

| Método | Onde |
|---|---|
| Email/password (login) | Staff (`AuthContext.tsx`) e Cliente (`auth_service.dart`) |
| Email/password (registo) | Só Cliente (`signup_screen.dart`) — staff nunca se regista sozinho, é criado via Admin SDK |
| Recuperação de password | Só Cliente |
| Sessão anónima | Só o painel de TV do staff (`PublicDisplay.tsx`) |
| Google / Apple / telefone | **Não usados** (zero ocorrências) |

Contas de staff são criadas exclusivamente pelos scripts de seed
(`scripts/*.mjs`, Admin SDK), nunca por auto-registo.

## 6. Storage, Functions, Messaging

Confirmado no ponto 2: nenhum dos três é usado. Não há nada a migrar
nestas três frentes — só a configuração vestigial no `firebase_options.dart`
gerado pelo FlutterFire CLI (que declara um `storageBucket` nunca
utilizado).

## 7. Configuração de deploy

- `fila-certa-staff`: hosting próprio (`filacerta-staff.web.app`,
  target `staff`), regras Firestore, emuladores locais (auth+firestore).
- `projectogestaodefilas`: hosting próprio (`filacerta-d74f0.web.app`,
  site por omissão do projecto), sem emuladores configurados no
  `firebase.json` (o `pubspec.yaml` tem `firebase_auth_mocks`/
  `fake_cloud_firestore` para testes, não emuladores reais).
- Ambos apontam ao mesmo `.firebaserc` → `filacerta-d74f0`.

## 8. Scripts de seed (dados de referência)

Três scripts em `fila-certa-staff/scripts/`, todos idempotentes:

- `seed.mjs` — emulador local.
- `seed-prod.mjs` — produção, institui "Banco Exemplo".
- `seed-prod-extra-institutions.mjs` — produção, activa mais 5
  instituições piloto (BPC, BFA, BAI, BCI, SIAC), cada uma com 3
  balcões + 1 agente + 1 gestor.

**Achado de segurança a registar (não corrigir sem instrução — fora do
âmbito desta auditoria):** todas as contas de staff usam a mesma
password `teste123`, em texto simples, no código-fonte versionado —
aceitável para um piloto de testes, mas nunca deve ser replicado para
uma password real de produção.

## 9. O que precisa de ser migrado

| Dado | Volume actual (piloto) | Sensibilidade |
|---|---|---|
| Contas Firebase Auth (staff) | 12 (2 Banco Exemplo + 10 das 5 instituições novas) | Passwords de teste, não reais |
| Contas Firebase Auth (clientes) | Poucas, todas de teste, criadas durante o desenvolvimento | Nenhuma real |
| Documentos Firestore | Baixo volume (piloto) — instituições, balcões, contadores, senhas de teste, avaliações de teste | Nenhum dado real de cliente |

**Conclusão prática**: por ser ainda um piloto sem utilizadores reais,
a migração de dados/utilizadores pode ser feita de forma direta
(recriar as contas de teste em Supabase Auth com as mesmas credenciais
conhecidas), sem precisar da estratégia complexa de migração de hashes
de password que seria obrigatória com utilizadores reais — essa
estratégia está documentada no plano para o caso de já existirem
utilizadores reais no momento da execução.
