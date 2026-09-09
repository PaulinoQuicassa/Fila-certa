# Modelo PostgreSQL proposto — Fila Certa (Supabase)

Derivado exclusivamente do modelo Firestore real documentado em
`firebase-audit.md`. Nenhuma tabela aqui é inventada a partir do nome
do projecto — cada uma corresponde a uma colecção/subcolecção já
existente, ou resolve uma duplicação real já identificada.

## Convenções

- **IDs naturais preservados** para `institutions`, `branches`,
  `counters` (`text` PK, ex.: `'banco-exemplo'`, `'agencia-maianga'`,
  `'guiche-1'`) — são já estáveis, legíveis, usados em três scripts de
  seed e nas Security Rules actuais. Trocar por UUID não traria
  nenhuma vantagem e obrigaria a reescrever os seeds sem ganho real.
- **UUID (`gen_random_uuid()`)** para tudo o resto (`tickets`,
  `appointments`, `ratings`, `notifications`, `ticket_calls`) — eram já
  IDs opacos gerados pelo Firestore, sem significado nem referência
  externa a preservar.
- **`staff.id` e `customer_id` em todas as tabelas de cliente = `auth.users.id`**
  (mesmo padrão 1:1 que já existe hoje entre documento `staff/{uid}` e
  o UID do Firebase Auth).
- `timestamptz` para todos os campos de data/hora (equivalente ao
  `Timestamp`/`serverTimestamp()` do Firestore).

## Tabelas

### `institutions`
```
id            text PRIMARY KEY        -- 'banco-exemplo', 'bpc', ...
name          text NOT NULL
created_at    timestamptz NOT NULL DEFAULT now()
```

### `branches`
```
id              text NOT NULL          -- 'agencia-maianga', ...
institution_id  text NOT NULL REFERENCES institutions(id) ON DELETE CASCADE
name            text NOT NULL
created_at      timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (institution_id, id)
```

### `counters`
```
id                  text NOT NULL       -- 'guiche-1', ...
branch_id           text NOT NULL
institution_id      text NOT NULL
label               text NOT NULL
status              counter_status NOT NULL DEFAULT 'available'
current_ticket_id   uuid REFERENCES tickets(id)
current_agent_id    uuid REFERENCES auth.users(id)   -- ver "Problema → Proposta" abaixo
PRIMARY KEY (institution_id, branch_id, id)
FOREIGN KEY (institution_id, branch_id) REFERENCES branches(institution_id, id)
```

> **Estrutura actual**: `counters.agentName` guarda o NOME do agente
> como texto solto, duplicado do que já está em `staff.name`.
> **Problema**: se o agente mudar de nome, ou se dois agentes tiverem o
> mesmo nome, o dado fica inconsistente/ambíguo; não há integridade
> referencial nenhuma.
> **Proposta**: `current_agent_id uuid REFERENCES auth.users(id)`; o
> nome mostra-se sempre via `JOIN staff`.
> **Justificação**: elimina duplicação, uma só fonte de verdade,
> ganho directo de integridade sem perder nenhuma funcionalidade —
> o ecrã do agente já sabe o próprio `auth.uid()` ao chamar a função
> `call_next` (ver secção de funções).

### `staff`
```
id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
name            text NOT NULL
role            staff_role NOT NULL              -- 'agent' | 'manager'
institution_id  text NOT NULL REFERENCES institutions(id)
branch_id       text NOT NULL
counter_id      text                              -- só para agentes
created_at      timestamptz NOT NULL DEFAULT now()
FOREIGN KEY (institution_id, branch_id) REFERENCES branches(institution_id, id)
FOREIGN KEY (institution_id, branch_id, counter_id) REFERENCES counters(institution_id, branch_id, id)
```

### `tickets`
```
id                          uuid PRIMARY KEY DEFAULT gen_random_uuid()
institution_id              text NOT NULL
branch_id                   text NOT NULL
code                        text NOT NULL          -- 'B001', 'A050', ...
service                     text NOT NULL          -- ver nota "services" abaixo
priority                    boolean NOT NULL DEFAULT false
status                      ticket_status NOT NULL DEFAULT 'waiting'
counter_id                  text
created_at                  timestamptz NOT NULL DEFAULT now()
called_at                   timestamptz
done_at                     timestamptz
transferred_to_counter_id   text
no_show_reason              no_show_reason         -- 'customer_cancelled' | 'staff_marked'
was_transferred             boolean NOT NULL DEFAULT false
customer_on_the_way         boolean NOT NULL DEFAULT false
customer_id                 uuid REFERENCES auth.users(id)   -- NULL só para senhas semeadas manualmente
FOREIGN KEY (institution_id, branch_id) REFERENCES branches(institution_id, id)
FOREIGN KEY (institution_id, branch_id, counter_id) REFERENCES counters(institution_id, branch_id, id)

-- índices (secção 23 do mandato — justificados por queries reais já existentes)
CREATE INDEX ON tickets (branch_id, status) WHERE status = 'waiting';   -- fila de espera, callNext, subscribeWaitingQueue
CREATE INDEX ON tickets (branch_id, created_at);                        -- "senhas de hoje" do dashboard
CREATE INDEX ON tickets (customer_id);                                  -- "Os meus atendimentos"
CREATE INDEX ON tickets (customer_id, status) WHERE status IN ('waiting','serving');  -- senhas activas do cliente
```

> `ticket_status` **não inclui `'called'`** — confirmado por grep que
> nunca é escrito em nenhum dos dois repos; propagar um valor morto
> para o enum só cria confusão futura. Enum proposto:
> `'waiting' | 'serving' | 'done' | 'no_show'`.

> **Nota sobre `service` (texto livre)**: hoje não existe nenhuma
> colecção Firestore de serviços — são dados estáticos só no cliente
> Flutter. Manter como `text` preserva o comportamento actual
> fielmente. **Melhoria opcional, não obrigatória**: criar uma tabela
> `services(institution_id, name, ...)` e trocar `tickets.service`/
> `appointments.service_name`/`ratings.service_name` por
> `service_id uuid REFERENCES services(id)`, ganhando integridade
> referencial e permitindo estatísticas por serviço sem depender de
> comparação de texto (já usada hoje em `subscribeWaitingServiceNames`
> do lado do cliente, de forma frágil). Fica como decisão em aberto —
> ver secção "Decisões a confirmar".

### `ticket_calls` (substitui `liveBoard/current`)

> **Estrutura actual**: um único documento mutável por balcão/agência
> (`liveBoard/current`) com um campo `current` e um array `history`
> manualmente cortado a 4 entradas a cada escrita.
> **Problema**: (1) é um padrão de poupança de leituras específico do
> Firestore, sem equivalente/necessidade em Postgres; (2) limita o
> histórico a 4 entradas por desenho, não por escolha; (3) escritas
> concorrentes num único documento são um ponto de contenção.
> **Proposta**: log append-only, uma linha por chamada/re-chamada.
> **Justificação**: "current" = última linha (`ORDER BY called_at DESC LIMIT 1`);
> "history" = uma window function ou `LIMIT N` à escolha do ecrã, sem
> limite arbitrário de 4; nenhuma escrita apaga informação.

```
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
institution_id  text NOT NULL
branch_id       text NOT NULL
ticket_id       uuid NOT NULL REFERENCES tickets(id)
code            text NOT NULL
counter_label   text NOT NULL
called_at       timestamptz NOT NULL DEFAULT now()
FOREIGN KEY (institution_id, branch_id) REFERENCES branches(institution_id, id)

CREATE INDEX ON ticket_calls (institution_id, branch_id, called_at DESC);  -- "última senha chamada" / painel TV
```

### `appointments` (substitui a duplicação privado + espelho)

> **Estrutura actual**: dois documentos para o mesmo agendamento —
> `users/{uid}/appointments/{code}` (privado) e
> `institutions/.../appointments/{code}` (espelho, só para a
> localização piloto, escrito à parte pelo cliente).
> **Problema**: duplicação de escrita (dois `.set()` por agendamento),
> risco de os dois lados divergirem (já aconteceu com o código gerado
> localmente antes de ser corrigido para um contador atómico), e só
> existe porque o Firestore não sabe dar visibilidade condicional
> (dono OU equipa) ao mesmo documento.
> **Proposta**: uma tabela só, com RLS dupla (ver `security.md` a
> criar na Fase 5) — o cliente vê as suas próprias linhas
> (`customer_id = auth.uid()`), a equipa vê as da sua instituição
> (`institution_id` bate com `staff.institution_id` do utilizador
> autenticado).
> **Justificação**: elimina a duplicação por completo, sem perder
> nenhuma visibilidade que hoje existe.

```
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
code            text NOT NULL UNIQUE       -- mesmo código visível hoje (AG001, ...)
institution_id  text NOT NULL
branch_id       text NOT NULL
customer_id     uuid NOT NULL REFERENCES auth.users(id)
service         text NOT NULL
date            date NOT NULL
time            text NOT NULL              -- preservado como texto ("10:00"); ver nota
status          appointment_status NOT NULL DEFAULT 'scheduled'
created_at      timestamptz NOT NULL DEFAULT now()
FOREIGN KEY (institution_id, branch_id) REFERENCES branches(institution_id, id)

CREATE INDEX ON appointments (customer_id);
CREATE INDEX ON appointments (institution_id, branch_id, created_at);  -- KPI "agendamentos hoje"
```

### `ratings`
```
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
ticket_id       uuid NOT NULL UNIQUE REFERENCES tickets(id)   -- 1:1, já era 1 por senha (id do doc = ticketId)
institution_id  text NOT NULL
branch_id       text NOT NULL
customer_id     uuid NOT NULL REFERENCES auth.users(id)
service         text NOT NULL
overall         smallint NOT NULL CHECK (overall BETWEEN 1 AND 5)
recommend       boolean NOT NULL
comment         text NOT NULL DEFAULT ''
aspect_atendimento    smallint NOT NULL CHECK (aspect_atendimento BETWEEN 1 AND 5)
aspect_tempo_espera   smallint NOT NULL CHECK (aspect_tempo_espera BETWEEN 1 AND 5)
aspect_organizacao    smallint NOT NULL CHECK (aspect_organizacao BETWEEN 1 AND 5)
aspect_instalacoes    smallint NOT NULL CHECK (aspect_instalacoes BETWEEN 1 AND 5)
created_at      timestamptz NOT NULL DEFAULT now()
```

> **Estrutura actual**: `aspects` é um map/objecto Firestore com 4
> chaves fixas.
> **Problema**: o dashboard já calcula médias por aspecto no cliente
> (`Dashboard.tsx`), lendo todas as avaliações e agregando em memória
> — não escala e não pode usar `AVG()`/índice do lado do servidor.
> **Proposta**: 4 colunas tipadas em vez de um mapa.
> **Justificação**: são sempre exactamente os mesmos 4 aspectos (não é
> um esquema dinâmico), colunas tipadas permitem
> `AVG(aspect_atendimento)` directo em SQL e `CHECK` de intervalo —
> hoje sem nenhuma validação de intervalo no Firestore.

### `notifications`
```
id          uuid PRIMARY KEY DEFAULT gen_random_uuid()
user_id     uuid NOT NULL REFERENCES auth.users(id)
title       text NOT NULL
subtitle    text NOT NULL
read        boolean NOT NULL DEFAULT false
created_at  timestamptz NOT NULL DEFAULT now()

CREATE INDEX ON notifications (user_id, read);   -- contagem de não lidas (sino do HomeScreen)
```

### `user_settings`
```
user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
queue_alerts             boolean NOT NULL DEFAULT true
appointment_reminders    boolean NOT NULL DEFAULT true
promotions               boolean NOT NULL DEFAULT false
whatsapp                 boolean NOT NULL DEFAULT true
language                 text NOT NULL DEFAULT 'pt'
```

### `branch_counters` (substitui `meta/ticketSeq`)
```
institution_id  text NOT NULL
branch_id       text NOT NULL
seq             bigint NOT NULL DEFAULT 0
PRIMARY KEY (institution_id, branch_id)
```
Usada exclusivamente pela função `pull_ticket`/`next_appointment_code`
(ver abaixo) via `SELECT ... FOR UPDATE` — nunca escrita directamente
pelo cliente.

## Enums

```sql
CREATE TYPE staff_role       AS ENUM ('agent', 'manager');
CREATE TYPE counter_status   AS ENUM ('available', 'serving', 'paused');
CREATE TYPE ticket_status    AS ENUM ('waiting', 'serving', 'done', 'no_show');
CREATE TYPE no_show_reason   AS ENUM ('customer_cancelled', 'staff_marked');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'cancelled');
```

## Diagrama de relações

```
institutions
   │
   └── branches
          │
          ├── counters ──── current_ticket_id ──► tickets
          │       ▲
          │       │ counter_id
          │
          ├── tickets ◄──── customer_id ──── auth.users
          │       ▲
          │       │ ticket_id (1:1)
          │       └── ratings
          │
          ├── ticket_calls ──── ticket_id ──► tickets
          │
          ├── appointments ──── customer_id ──► auth.users
          │
          └── branch_counters   (contador interno, sem FK de saída)

auth.users
   │
   ├── staff (1:1, staff.id = auth.users.id)
   ├── notifications (1:N)
   └── user_settings (1:1)
```

## Funções RPC (substituem a lógica hoje no cliente)

Esta é a mudança arquitectural mais importante da migração — resolve
directamente o ponto 20/21 do mandato ("não colocar lógica crítica no
frontend", "operações críticas devem ser atómicas"). Todas correm como
funções `SECURITY DEFINER` no Postgres, chamadas via `supabase.rpc(...)`,
nunca manipulando as tabelas directamente a partir do Flutter/React:

| Função proposta | Substitui (hoje, no cliente) | Atomicidade |
|---|---|---|
| `pull_ticket(institution_id, branch_id, service)` | `ticket_service.dart: pullTicket` (transacção Firestore) | `SELECT seq FOR UPDATE` + `INSERT` na mesma transacção SQL |
| `next_appointment_code(institution_id, branch_id)` | `ticket_service.dart: nextAppointmentCode` | idem, mesma tabela `branch_counters` |
| `call_next(institution_id, branch_id, counter_id, agent_id)` | `queue.ts: callNext` | `UPDATE tickets ... WHERE status='waiting' ORDER BY priority DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED` — resolve directamente o cenário de dois agentes a chamar em simultâneo descrito no ponto 21 do mandato, que hoje depende só da transacção optimista do Firestore |
| `recall_current(...)` | `queue.ts: recallCurrent` | insere linha em `ticket_calls` |
| `complete_current(...)` | `queue.ts: completeCurrent` | `UPDATE` |
| `mark_no_show(...)` | `queue.ts: markNoShow` | `UPDATE` |
| `transfer_ticket(...)` | `queue.ts: transferTicket` | `UPDATE` |
| `set_counter_paused(...)` | `queue.ts: setCounterPaused` | `UPDATE` |
| `cancel_ticket(ticket_id)` | `ticket_service.dart: cancelTicket` | `UPDATE ... WHERE customer_id = auth.uid()` |
| `set_on_the_way(ticket_id)` | `ticket_service.dart: setOnTheWay` | `UPDATE ... WHERE customer_id = auth.uid()` |

`SKIP LOCKED` em `call_next` é uma melhoria real sobre o comportamento
actual: hoje, se dois agentes de balcões diferentes tentarem chamar ao
mesmo tempo, as duas transacções Firestore competem pela mesma leitura
da fila; em Postgres, `SKIP LOCKED` deixa cada agente pegar
imediatamente na próxima senha livre sem esperar pela lock do outro.

## Decisões a confirmar (não decidido nesta auditoria)

1. **`services` como tabela própria** ou manter texto livre? (ver nota
   na tabela `tickets`). Recomendação: introduzir, mas só depois da
   migração base estar validada — é aditivo, não bloqueia nada.
2. **`users/{uid}/history` (Visit)** — descontinuar a favor de ler
   `tickets WHERE customer_id = auth.uid()` directamente (já é o que
   "Os meus atendimentos" faz), ou manter como está? Recomendação:
   descontinuar, mas confirmar que nenhum ecrã depende só do histórico
   antigo antes de remover.
3. **RLS exacto por tabela** — fica detalhado em `security.md` (Fase 5),
   não aqui, para não misturar modelo de dados com política de acesso.
