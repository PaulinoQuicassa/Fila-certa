// Estado da conversa persistido (Edge Functions são efémeras -- não há
// memória entre invocações). Só service_role lhe toca.
import { serviceClient } from "./citizenSession.ts";

export type ConversationStateName =
  | "WELCOME"
  | "SELECT_INSTITUTION"
  | "SELECT_BRANCH"
  | "SELECT_SERVICE"
  | "CONFIRM_QUEUE"
  | "QUEUE_CREATED"
  | "AWAIT_CANCEL_CONFIRM";

export interface ConversationContext {
  institutionId?: string;
  institutionName?: string;
  branchId?: string;
  service?: string;
  ticketId?: string;
}

export interface ConversationState {
  state: ConversationStateName;
  context: ConversationContext;
}

export async function loadState(phone: string): Promise<ConversationState> {
  const db = serviceClient();
  const { data, error } = await db
    .from("whatsapp_conversation_state")
    .select("state, context")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { state: "WELCOME", context: {} };
  return { state: data.state as ConversationStateName, context: (data.context ?? {}) as ConversationContext };
}

export async function saveState(phone: string, state: ConversationStateName, context: ConversationContext) {
  const db = serviceClient();
  const { error } = await db
    .from("whatsapp_conversation_state")
    .upsert({ phone, state, context, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function resetState(phone: string) {
  await saveState(phone, "WELCOME", {});
}
