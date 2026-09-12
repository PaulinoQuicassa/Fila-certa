// Recebe os callbacks de estado de entrega da Twilio (SMS e WhatsApp)
// -- Fase 10/14: "guardar o estado real", nunca considerar uma
// mensagem entregue só porque a API aceitou o pedido inicial. Fase 20:
// assinatura verificada antes de qualquer processamento, idempotente
// (nunca volta atrás de um estado terminal), sem lógica de negócio
// própria (só actualiza `notification_deliveries`, já criado por
// `_shared/notifications/engine.ts`).
import { serviceClient } from "../_shared/citizenSession.ts";
import { captureException } from "../_shared/sentry.ts";
import { mapTwilioStatus } from "../_shared/notifications/mapTwilioStatus.ts";
import { verifyTwilioSignature } from "../_shared/twilioSignature.ts";

// Estados que já não devem ser sobrepostos por um callback atrasado --
// a Twilio não garante ordem de entrega dos callbacks (um "sent"
// atrasado pode chegar depois de "delivered"); nunca voltar atrás.
const TERMINAL_STATUSES = new Set(["delivered", "read", "failed"]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente em falta: ${name}`);
  return value;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const rawBody = await req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  // A URL usada na assinatura tem de ser exactamente a configurada na
  // consola da Twilio para este callback -- nunca derivada de
  // `req.url` (ver comentário em _shared/twilioSignature.ts).
  const callbackUrl = requiredEnv("TWILIO_STATUS_CALLBACK_URL");
  const validSignature = await verifyTwilioSignature(callbackUrl, params, req.headers.get("X-Twilio-Signature"));
  if (!validSignature) {
    return new Response("Invalid signature", { status: 401 });
  }

  const messageSid = params.MessageSid;
  const messageStatus = params.MessageStatus;
  if (!messageSid || !messageStatus) {
    return new Response("OK", { status: 200 });
  }

  const db = serviceClient();

  try {
    const { data: row, error: lookupError } = await db
      .from("notification_deliveries")
      .select("id, status")
      .eq("provider_message_id", messageSid)
      .maybeSingle();
    if (lookupError) throw lookupError;

    if (!row) {
      // Mensagem não rastreada por este motor (ex.: uma OTP enviada
      // directamente pela Auth do Supabase, fora de
      // notification_deliveries) -- nada a fazer, não é um erro.
      return new Response("OK", { status: 200 });
    }

    if (TERMINAL_STATUSES.has(row.status)) {
      // Já está num estado final -- um callback repetido ou fora de
      // ordem não pode voltar atrás (idempotência, Fase 20).
      return new Response("OK", { status: 200 });
    }

    const { error: updateError } = await db.rpc("update_notification_status", {
      p_id: row.id,
      p_status: mapTwilioStatus(messageStatus),
      p_error_code: params.ErrorCode ?? null,
      p_error_message: params.ErrorMessage ?? null,
    });
    if (updateError) throw updateError;
  } catch (err) {
    console.error("Erro no twilio-status-callback:", err);
    await captureException(err, { functionName: "twilio-status-callback", tags: { messageStatus } });
  }

  return new Response("OK", { status: 200 });
});
