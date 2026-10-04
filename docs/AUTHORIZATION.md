# Autenticação e autorização

Autenticação = quem é o utilizador. Autorização = o que pode fazer. São verificadas
sempre no backend. O frontend apenas esconde opções.

## Autenticação (Supabase Auth)

| Perfil | Como entra | Identidade | Notas |
|---|---|---|---|
| Cliente (Flutter) | Email/telefone (OTP) | `auth.users` | Conta criada ao confirmar a senha, não antes |
| Visitante | Sem sessão (`anon`) ou sessão anónima | `auth.uid()` nulo, ou `is_anonymous` | Só lê capacidade, resumo da fila e espera |
| Funcionário (agente, gestor, director) | Email e palavra-passe | `auth.users` + linha em `staff` | Sem linha em `staff`, o login é recusado |
| Dono da plataforma | Email e palavra-passe + MFA | `auth.users` + linha em `owners` | `is_owner()` exige MFA verificado quando configurado |
| Painel TV | Sessão anónima (`signInAnonymously`) | `auth.users` anónimo | Só lê o painel público |
| Estação (auto-atendimento) | Conta de quiosque (email e palavra-passe de estação) | `auth.users` + `kiosk_accounts` | Emite senhas sem conta de cliente |
| Webhook WhatsApp | Sessão por telefone (conta sintética) | `auth.users` | Validado pela assinatura da Meta |

## Autorização

Dados de autorização:

- `staff(id, institution_id, branch_id, role, counter_id)` — papel e âmbito de um funcionário.
- `owners(id)` — dono da plataforma.
- `tickets.customer_id`, `appointments.customer_id`, `ratings.customer_id` — ownership do cliente.
- `kiosk_accounts` — contas de quiosque (Estação).

Papéis de funcionário: `agent`, `manager`, `director`.

| Acção | Quem pode | Verificação |
|---|---|---|
| Ver/gerir uma filial operacionalmente | Funcionário da filial | `is_staff_of_branch(instituição, filial)` |
| Gerir balcões e atribuições | Gestor da filial | `is_manager_of_branch(instituição, filial)` |
| Ver painel e configurar capacidade | Director da instituição | `is_director_of(instituição)` |
| Gerir instituições, filiais, perfis | Dono | `is_owner()` |
| Ver a própria senha | Cliente dono da senha | `customer_id = auth.uid()` |
| Emitir senha | Cliente autenticado não anónimo | `pull_ticket` |

## Isolamento multi-tenant

- Um funcionário da instituição A não consegue ler dados da B: todas as RPC e políticas filtram por `institution_id`.
- Um funcionário do balcão 1 não tem acesso operacional ao balcão 2: `is_staff_of_branch` exige a mesma filial.
- Um director só vê a instituição a que pertence.

## Onde está a autorização

1. **RLS** nas tabelas (`tickets`, `counters`, `staff`, etc.).
2. **RPC** `SECURITY DEFINER` com validação no corpo. Ver `API.md`.
3. **Execução de funções** (`EXECUTE`): restringida desde 2026-10-04 (`20261004120000_restrict_rpc_execute`). Ver `security-rpc-execute-review.md`.
4. **Frontend**: só esconde opções. Nunca é a única barreira.

## Regras que não podem depender do frontend

- Limite de uma senha activa por serviço — em `pull_ticket`.
- Bloqueio de capacidade (vermelho, e amarelo sem confirmação) — em `pull_ticket`.
- Configuração de capacidade só pelo director — em `director_update_branch_capacity`.
- Funções de escrita internas (`clear_counter`, `write_audit_log`, `record_notification_attempt`, `update_notification_status`) só executáveis por processos internos.

## Limitações conhecidas

- `staff_display_name(uuid)` continua acessível a qualquer utilizador autenticado (pendente: restringir a colegas da mesma instituição).
- `branches` é legível por visitantes, incluindo a configuração operacional (capacidade e margem). Pendente de decisão de produto.
- Um cliente autenticado pode criar inscrições em `capacity_watchers` sem limite de taxa.
