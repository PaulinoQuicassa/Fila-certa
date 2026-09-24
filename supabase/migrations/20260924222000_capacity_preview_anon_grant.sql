-- Bug real encontrado em teste: `queue_capacity_preview` só tinha grant
-- para `authenticated`. `ServiceConfirmScreen` chama-a logo no
-- initState() -- ANTES de pedir conta (a conta só é pedida ao confirmar
-- "Entrar na fila", de propósito, ver comentário na classe). Enquanto o
-- cliente navega sem sessão (ou com sessão anónima de convidado), a
-- chamada falhava silenciosamente (RLS/grant nega, o catch engole) e o
-- ecrã caía para os números ESTÁTICOS do catálogo mock
-- (`ServiceItem.peopleInQueue`/`etaMinutes`) -- rotulados como "ao vivo"
-- mas na verdade fixos. É exactamente o "11 pessoas / 22 min" que
-- apareceu em teste (SIAC, "Passaporte e Residência") -- coincide byte a
-- byte com o valor fixo do catálogo em mock_data.dart.
--
-- Mesmo padrão já usado por branch_queue_summary/branch_wait_stats
-- (ambas grant a `authenticated, anon`) -- esta função também não lê
-- nada específico do utilizador, é seguro alargar.

grant execute on function public.queue_capacity_preview(text, text, text) to anon;
