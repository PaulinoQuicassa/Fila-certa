// Motor de notificações (Fase 11): Evento de Negócio -> Evento de
// Notificação -> Fila (tabela `notifications`) -> Fornecedor -> Estado
// de Entrega. Ponto único por onde qualquer Edge Function manda uma
// notificação real -- nenhuma chama um fornecedor directamente. A
// idempotência (1 evento = 1 mensagem, mesmo com retries/reentregas)
// é garantida na base de dados (`record_notification_attempt`, coluna
// `event_id` unique), não só aqui em memória.
import { serviceClient } from "../citizenSession.ts";
import { captureException } from "../sentry.ts";
import { sendSms, sendWhatsAppTemplate } from "./providerRouter.ts";
import type { NotificationChannel, NotificationPriority } from "./types.ts";

interface SendNotificationInput {
  /** Identificador lógico e estável do evento de negócio -- ex.:
   * `queue_called:<ticket_id>`. Chamar isto duas vezes com o mesmo
   * eventId nunca produz duas mensagens. */
  eventId: string;
  userId: string;
  to: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  /** Obrigatório para channel "whatsapp". */
  templateKey?: string;
  bodyParams?: string[];
  /** Obrigatório para channel "sms". */
  body?: string;
}

export interface SendNotificationResult {
  /** true só quando esta chamada realmente despoletou um envio (com
   * sucesso) ao fornecedor -- nunca true para um evento duplicado nem
   * para uma falha do fornecedor. */
  sent: boolean;
  /** true quando este eventId já tinha uma linha -- nenhuma tentativa
   * nova de envio foi feita. */
  deduplicated: boolean;
  providerMessageId?: string;
  providerName?: string;
  error?: string;
}

export async function sendNotification(input: SendNotificationInput): Promise<SendNotificationResult> {
  if (input.channel === "whatsapp" && !input.templateKey) {
    throw new Error("templateKey é obrigatório para channel=whatsapp");
  }
  if (input.channel === "sms" && !input.body) {
    throw new Error("body é obrigatório para channel=sms");
  }

  const db = serviceClient();
  const intendedProvider = input.channel === "sms"
    ? (Deno.env.get("SMS_PROVIDER") ?? "twilio")
    : (Deno.env.get("WHATSAPP_PROVIDER") ?? "meta");

  const { data, error } = await db.rpc("record_notification_attempt", {
    p_event_id: input.eventId,
    p_user_id: input.userId,
    p_channel: input.channel,
    p_provider: intendedProvider,
    p_priority: input.priority,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.inserted) {
    // Já existe uma linha para este evento -- outra chamada (retry,
    // reentrega de webhook, corrida entre dois triggers) já tratou
    // disto. Nunca reenviar.
    return { sent: false, deduplicated: true };
  }

  const notificationId = row.id as string;

  try {
    const routed = input.channel === "sms"
      ? await sendSms(input.to, input.body!)
      : await sendWhatsAppTemplate(input.to, input.templateKey!, input.bodyParams ?? []);

    await db.rpc("update_notification_status", {
      p_id: notificationId,
      p_status: routed.status,
      p_provider_message_id: routed.providerMessageId || null,
      p_error_code: routed.errorCode ?? null,
      p_error_message: routed.errorMessage ?? null,
      p_provider: routed.providerName,
    });

    if (routed.status === "failed") {
      // Fase 16 (alerta: "aumento de notificações failed") -- cada
      // falha de fornecedor fica visível no Sentry com o canal e a
      // prioridade, para uma falha "critical" nunca passar
      // despercebida no meio de avisos "low".
      await captureException(new Error(routed.errorMessage ?? "envio falhou sem mensagem de erro"), {
        functionName: "notification-engine",
        tags: { channel: input.channel, priority: input.priority, provider: routed.providerName ?? "desconhecido" },
        extra: { eventId: input.eventId, errorCode: routed.errorCode },
      });
      return { sent: false, deduplicated: false, providerName: routed.providerName, error: routed.errorMessage };
    }
    return { sent: true, deduplicated: false, providerMessageId: routed.providerMessageId, providerName: routed.providerName };
  } catch (err) {
    // Erro de rede/config antes de sequer haver uma resposta do
    // fornecedor -- fica registado como falha real, nunca como
    // sucesso silencioso (a linha já existe desde o passo anterior).
    const message = err instanceof Error ? err.message : String(err);
    await db.rpc("update_notification_status", { p_id: notificationId, p_status: "failed", p_error_message: message });
    await captureException(err, {
      functionName: "notification-engine",
      tags: { channel: input.channel, priority: input.priority },
      extra: { eventId: input.eventId },
    });
    return { sent: false, deduplicated: false, error: message };
  }
}
