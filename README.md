# Fila Certa — Staff (Agente · Painel Público · Dashboard)

App web (React + TypeScript + Vite) para a equipa das instituições que
usam a Fila Certa: agente de balcão, ecrã público de chamada (TV) e
dashboard do gestor. É um **repositório separado** da app cliente Flutter
(`projectogestaodefilas`, GitHub `PaulinoQuicassa/DevSYNOVAR`) — código
diferente, **mesmo projecto Firebase** (`filacerta-d74f0`).

## Porque um repositório separado

- Público diferente (equipa institucional vs. cliente final), ciclo de
  distribuição diferente (web para tablets/TVs, sem lojas de app).
- Firestore é o backend partilhado — os dois códigos falam com a mesma
  base de dados, cada um com as suas colecções (`users/**` a app cliente,
  `staff/**`+`institutions/**` esta app).

## Stack

React 19 + TypeScript + Vite · `react-router-dom` · `firebase` (Auth +
Firestore, client SDK) · `firebase-admin` (só para o script de seed local).

## Modelo de dados (Firestore)

```
staff/{uid}                                    → { name, role: 'agent'|'manager', institutionId, branchId, counterId? }
institutions/{institutionId}                   → { name }
institutions/{institutionId}/branches/{branchId}
  /counters/{counterId}                        → { label, status: 'available'|'serving'|'paused', currentTicketId, agentName }
  /tickets/{ticketId}                          → { code, service, priority, status, counterId, createdAt, calledAt, doneAt }
  /liveBoard/current                           → { current: {code, counterLabel}, history: [...], updatedAt }
```

`institutionId`/`branchId` estão fixos no piloto (`banco-exemplo` /
`agencia-maianga`, ver `.env.example`) — passam a vir de `staff/{uid}`
(agente/gestor) ou de variável de ambiente por dispositivo (painel
público de cada agência) quando houver mais do que uma instituição.

## Correr localmente (contra o emulador — nunca contra produção)

```bash
npm install
npm run emulators        # terminal 1 — Firestore + Auth locais (porta 8080/9099, UI em 4001)
npm run seed              # terminal 2 — cria instituição/guichês/senhas de exemplo + 2 contas de staff
npm run dev:emulator      # terminal 3 — Vite, já ligado ao emulador
```

Contas de teste criadas pelo `seed`:
- `agente@filacerta.test` / `teste123` → `/agente` (Guichê 3)
- `gestor@filacerta.test` / `teste123` → `/dashboard`
- `/painel` → ecrã público, sem login (sessão anónima automática)

## Ligar à produção (`filacerta-d74f0`) — passos manuais, não automáticos

Isto **ainda não foi feito** — exige decisões e acesso que só o
utilizador tem:

1. **Publicar as Firestore Rules actualizadas.** `firestore.rules` deste
   repositório e de `projectogestaodefilas/firestore.rules` foram
   actualizados em paralelo (colecções `staff/**` e `institutions/**`
   adicionadas, `users/**` inalterado) — confirmar que os dois ficheiros
   ainda coincidem e só depois `firebase deploy --only firestore:rules`
   a partir de um dos dois repositórios.
2. **Activar autenticação anónima** no Firebase Console → Authentication
   → Sign-in method → Anonymous (o painel público de TV usa-a; a app
   cliente e o script de seed não mexem nisto, tem de ser activado
   manualmente).
3. **Criar as contas reais de staff** (agente/gestor por instituição) —
   o script `seed.mjs` só escreve no emulador; criar utilizadores reais
   é feito manualmente no Console ou com um script equivalente apontado
   à produção (fora do âmbito deste README, por ser uma acção com
   efeitos reais).
4. Copiar `.env.example` para `.env.local` com `VITE_USE_EMULATOR=false`
   e os IDs reais de instituição/agência.

## Estrutura

```
src/
├── firebase.ts        # init do SDK — mesma config web do projecto Firebase da app cliente
├── types.ts
├── auth/AuthContext.tsx
├── lib/queue.ts        # toda a lógica de leitura/escrita no Firestore (subscribe*/callNext/etc.)
├── pages/
│   ├── Login.tsx
│   ├── AgentScreen.tsx  # /agente
│   ├── PublicDisplay.tsx # /painel
│   └── Dashboard.tsx    # /dashboard
└── styles/tokens.css    # tokens de marca (fc-*) — mesmos valores do mockup/design system SeguroCerto
scripts/seed.mjs          # dados de exemplo, só contra o emulador
```

## Estado actual

Protótipo funcional contra o emulador local: login por papel (agente/
gestor), fluxo completo de chamada de senha (chamar/concluir/não
compareceu/transferir/pausar) sincronizado em tempo real entre `/agente`,
`/painel` e `/dashboard`. Nunca testado contra o Firebase de produção —
ver secção "Ligar à produção" acima antes de o fazer.
