// Deduplicação (a Meta reentrega webhooks) + observabilidade mínima --
// ver Fase 15/19 da conversa. Não guarda o corpo da mensagem, só o
// necessário para auditar e para decidir "já processei isto?".
import { serviceClient } from "./citizenSession.ts";

/** Regista a mensagem inbound; devolve `false` se já tinha sido
 * processada antes (reentrega da Meta) -- o chamador deve parar aí,
 * sem repetir nenhuma acção. */
export async function claimInboundMessage(metaMessageId: string, phone: string, messageType: string): Promise<boolean> {
  const db = serviceClient();
  const { error } = await db
    .from("whatsapp_message_log")
    .insert({ meta_message_id: metaMessageId, phone, direction: "inbound", message_type: messageType });
  if (error) {
    // 23505 = unique_violation -- já visto antes, não é um erro real.
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

export async function logEvent(phone: string, event: string, ticketId?: string) {
  const db = serviceClient();
  // Eventos de saída/negócio não vêm com um meta_message_id -- geramos
  // um identificador próprio para caber na mesma chave primária.
  const syntheticId = `event:${event}:${phone}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const { error } = await db
    .from("whatsapp_message_log")
    .insert({ meta_message_id: syntheticId, phone, direction: "outbound", event, ticket_id: ticketId ?? null });
  if (error) throw error;
}
