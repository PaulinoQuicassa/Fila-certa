# Segurança — RLS (Fase 5)

Aplica-se a `supabase/migrations/20260906190100_rls.sql`. Cada secção
documenta a decisão no formato pedido pelo mandato de migração:
Problema → Opções → Recomendação → Justificação → Impacto.

## Decisão 1 — Leitura aberta em `institutions`/`branches`/`counters`/`tickets`/`ticket_calls`

**Problema**: a Firestore rule actual é
`allow read: if request.auth != null` sobre `institutions/**` — ou
seja, qualquer utilizador autenticado (agente, gestor, cliente, e a
sessão anónima do painel de TV) já pode ler tudo isto hoje. Traduzir
isto para RLS parece, à primeira vista, o `USING (true)` que o mandato
explicitamente pede para evitar (secção 10).

**Opções**:
1. `USING (true)` restrito ao papel `authenticated` (equivalente exacto
   ao comportamento actual).
2. Restringir a leitura por instituição (só staff dessa instituição, ou
   só o cliente com uma senha activa lá) — mudaria o comportamento
   visível: o painel de TV deixaria de conseguir mostrar a fila sem
   autenticação de staff, e o cliente deixaria de conseguir ver "quantas
   pessoas há na fila" antes de tirar a própria senha.

**Recomendação**: opção 1 — `USING (true)` com `TO authenticated`.

**Justificação**: isto não é preguiça de desenvolvimento, é a réplica
fiel de uma decisão já tomada e documentada no próprio comentário da
Firestore rule ("não há dados pessoais do cliente aqui, só código da
senha/serviço/balcão"). Os únicos campos nestas tabelas são
operacionais (código, estado, balcão, hora) — nenhum email, nome
completo ou contacto. Restringir agora seria uma mudança de
funcionalidade não pedida (quebra o painel de TV e as contagens de fila
em tempo real antes de entrar), o que o mandato também proíbe (secção
32, regras 3 e 6).

**Impacto**: nenhuma mudança de comportamento face ao Firebase. Se no
futuro se quiser esconder dados de uma instituição de outra (ex.:
multi-tenant mais estrito), é uma migration adicional, isolada, fácil
de justificar nessa altura.

## Decisão 2 — Sem INSERT/UPDATE directo em `tickets`, `counters`, `ticket_calls`, `branch_counters`

**Problema**: hoje, `pullTicket`/`callNext`/`transferTicket`/etc. são
transacções do SDK Firestore corridas **no cliente**, protegidas só
pelas Security Rules — exactamente o que o mandato identifica como
risco nas secções 20 e 21 (lógica crítica e atomicidade da fila
dependentes do frontend).

**Opções**:
1. Replicar o mesmo padrão em RLS: políticas de UPDATE com condições
   equivalentes às da Firestore rule (dono, `status='waiting'`, etc.),
   deixando o cliente continuar a fazer os `UPDATE`s directamente.
2. Fechar todo o INSERT/UPDATE/DELETE nestas tabelas via RLS, e mover
   toda a lógica para funções Postgres `SECURITY DEFINER` (Fase 9),
   chamadas via `supabase.rpc(...)`.

**Recomendação**: opção 2.

**Justificação**: é a mudança arquitectural central desta migração
(ver `database-design.md`, secção "Funções RPC"). Uma função
`SECURITY DEFINER` pode fazer `SELECT ... FOR UPDATE`/`SKIP LOCKED`
dentro de uma única transacção SQL do lado do servidor — mais forte do
que qualquer condição de RLS conseguiria exprimir sozinha (RLS não
resolve concorrência entre dois agentes a chamar ao mesmo tempo; um
`SELECT ... FOR UPDATE SKIP LOCKED` dentro de uma função, resolve).

**Impacto**: sem as funções da Fase 9, estas tabelas ficam
**só de leitura** para o cliente — correcto e esperado nesta fase; a
app só volta a conseguir tirar/chamar senhas depois da Fase 9 estar
implementada e o Flutter/React apontarem para as novas funções RPC
(Fase 10). Não há ainda nenhuma alteração ao código Flutter/React nesta
fase — a app continua 100% funcional contra o Firebase até essa altura.

## Decisão 3 — `appointments` como tabela única com RLS dupla

**Problema**: hoje existem dois documentos Firestore para o mesmo
agendamento (privado + espelho institucional), só porque o Firestore
não sabe dar visibilidade condicional (dono OU equipa) ao mesmo
documento.

**Opções**:
1. Manter duas tabelas em Postgres, replicando a duplicação.
2. Uma tabela só, com uma policy de SELECT que cobre as duas
   audiências (`customer_id = auth.uid() or is_staff_of(institution_id)`).

**Recomendação**: opção 2.

**Justificação**: elimina a causa raiz da duplicação (a limitação era
do Firestore, não existe em Postgres) sem perder nenhuma visibilidade
que já existe hoje — um cliente continua a ver só os seus, um membro
da equipa continua a ver os da sua instituição.

**Impacto**: a migração de dados (Fase 11) tem de reconciliar as duas
fontes Firestore (privada + espelho) numa só linha por agendamento —
já previsto em `migration-plan.md`.

## Decisão 4 — `ratings`: leitura aberta, criação directa (sem RPC)

**Problema**: ao contrário das senhas, uma avaliação não tem
concorrência para proteger (é escrita uma única vez, por um só
cliente, sem contador partilhado).

**Recomendação**: manter `INSERT` directo via RLS (com `WITH CHECK` a
confirmar que a senha referenciada pertence ao próprio cliente), sem
policy de `UPDATE`/`DELETE` — réplica exacta de a Firestore rule nunca
ter tido `allow update` para `ratings/{ticketId}`.

**Justificação**: introduzir uma função RPC só para isto seria
complexidade sem benefício real (não há nada a proteger que o RLS não
proteja já sozinho).

**Impacto**: nenhum — comportamento idêntico ao actual.

## Decisão 5 — `notifications`/`user_settings`: DML directo, sem RPC

**Mesma lógica da Decisão 4**: são dados pessoais simples, sem
concorrência nem regra de negócio a proteger — o próprio Firestore já
os tratava com escrita directa do cliente (sem transacção). RLS
replica isso: o dono lê/escreve só as suas próprias linhas.
