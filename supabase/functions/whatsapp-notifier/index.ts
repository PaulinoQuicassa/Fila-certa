// Chamado SÓ pelo Database Webhook do Supabase em `tickets`
// (INSERT/UPDATE) -- nunca pelo público. Substitui polling: reage a
// mudanças reais (chamada, conclusão, cancelamento, no-show) que já
// acontecem dentro das RPCs existentes. Não implementa nenhuma regra
// de fila nova -- só recalcula, com a mesma ordenação do call_next
// (prioridade desc, criação asc), quem ficou a 3 posições da vez.
import { serviceClient } from "../_shared/citizenSession.ts";
import { logEvent } from "../_shared/messageLog.ts";
import { sendNotification } from "../_shared/notifications/engine.ts";

const NEAR_TURN_THRESHOLD = 2; // 2 senhas à frente = 3ª posição

interface TicketRow {
  id: string;
  institution_id: string;
  branch_id: string;
  code: string;
  status: string;
  priority: boolean;
  created_at: string;
  customer_id: string | null;
  counter_id: string | null;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: TicketRow | null;
  old_record: TicketRow | null;
}

async function contactPhoneFor(db: ReturnType<typeof serviceClient>, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await db.from("whatsapp_contacts").select("phone").eq("user_id", customerId).maybeSingle();
  return data?.phone ?? null;
}

async function notifyIfCalled(db: ReturnType<typeof serviceClient>, record: TicketRow, oldRecord: TicketRow | null) {
  if (record.status !== "serving" || oldRecord?.status === "serving") return;
  const phone = await contactPhoneFor(db, record.customer_id);
  if (!phone || !record.customer_id) return;

  // Prioridade "high" (Fase 12: "é a sua vez") -- nunca deve ficar
  // atrás de avisos de prioridade mais baixa numa fila de
  // reprocessamento futura.
  const result = await sendNotification({
    eventId: `queue_called:${record.id}`,
    userId: record.customer_id,
    to: phone,
    channel: "whatsapp",
    priority: "high",
    templateKey: "QUEUE_CALLED",
    bodyParams: [record.code, record.counter_id ?? "—"],
  });
  if (result.sent) await logEvent(phone, "queue_called_notified", record.id);
}

async function notifyNearTurn(db: ReturnType<typeof serviceClient>, institutionId: string, branchId: string) {
  // Mesma ordenação do call_next -- ver supabase/migrations,
  // is_staff_of_branch/call_next. Ignora transferências específicas a
  // um balcão (nuance operacional rara, não crítica para um aviso de
  // proximidade).
  const { data: waiting, error } = await db
    .from("tickets")
    .select("id, code, customer_id")
    .eq("institution_id", institutionId)
    .eq("branch_id", branchId)
    .eq("status", "waiting")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;

  const target = (waiting ?? [])[NEAR_TURN_THRESHOLD];
  if (!target) return;

  const phone = await contactPhoneFor(db, target.customer_id);
  if (!phone || !target.customer_id) return;

  // Prioridade "medium" (Fase 12: "está quase") -- nunca deve bloquear
  // um envio "critical" (OTP) nem "high" concorrente.
  const result = await sendNotification({
    eventId: `queue_near_turn:${target.id}`,
    userId: target.customer_id,
    to: phone,
    channel: "whatsapp",
    priority: "medium",
    templateKey: "QUEUE_NEAR_TURN",
    bodyParams: [target.code],
  });
  if (result.sent) await logEvent(phone, "queue_near_turn_notified", target.id);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const payload = (await req.json()) as WebhookPayload;
  if (payload.table !== "tickets" || !payload.record) {
    return new Response("Ignored", { status: 200 });
  }

  const db = serviceClient();

  try {
    await notifyIfCalled(db, payload.record, payload.old_record);

    // Uma senda saiu da fila (chamada/concluída/cancelada/no-show) --
    // as posições das restantes em espera podem ter mudado.
    const leftWaiting = payload.old_record?.status === "waiting" && payload.record.status !== "waiting";
    const newWaitingArrival = payload.type === "INSERT" && payload.record.status === "waiting";
    if (leftWaiting || newWaitingArrival) {
      await notifyNearTurn(db, payload.record.institution_id, payload.record.branch_id);
    }
  } catch (err) {
    console.error("Erro no whatsapp-notifier:", err);
  }

  return new Response("OK", { status: 200 });
});
