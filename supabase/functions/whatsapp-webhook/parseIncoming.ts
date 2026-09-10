import type { IncomingMessage } from "./flows.ts";

/** Extrai a mensagem inbound do payload bruto da Meta. Devolve `null`
 * para payloads sem mensagem (ex.: notificações de estado de entrega
 * sent/delivered/read) -- não é um erro, só não há nada a processar. */
export function parseIncoming(payload: unknown): IncomingMessage | null {
  try {
    // deno-lint-ignore no-explicit-any
    const value = (payload as any)?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return null;

    const profileName = value?.contacts?.[0]?.profile?.name as string | undefined;
    const replyId = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? undefined;
    const text = message.text?.body as string | undefined;

    return { from: message.from, messageId: message.id, profileName, replyId, text };
  } catch {
    return null;
  }
}
