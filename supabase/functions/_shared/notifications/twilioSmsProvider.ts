// Fornecedor de SMS real via Twilio (Fase 8/9 do pedido de
// hardening). Credenciais só chegam aqui por variáveis de ambiente da
// Edge Function (`supabase secrets set`) -- nunca no frontend, no
// Git, no bundle da app ou em localStorage. Ver
// docs/notifications-architecture.md para a lista exacta de segredos
// que faltam configurar em produção.
import type { DeliveryStatusResult, NotificationStatus, ProviderSendResult, SmsProvider } from "./types.ts";

const API_BASE = "https://api.twilio.com/2010-04-01";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente em falta: ${name}`);
  return value;
}

function authHeader(): string {
  const sid = requiredEnv("TWILIO_ACCOUNT_SID");
  const token = requiredEnv("TWILIO_AUTH_TOKEN");
  return "Basic " + btoa(`${sid}:${token}`);
}

// Twilio devolve estados próprios (queued/sending/sent/delivered/
// undelivered/failed/read) -- mapeados para o vocabulário interno do
// motor de notificações (ver types.ts) para nenhum outro módulo
// precisar de conhecer o vocabulário de um fornecedor específico.
function mapTwilioStatus(twilioStatus: string): NotificationStatus {
  switch (twilioStatus) {
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
    case "undelivered":
      return "failed";
    case "sent":
    case "sending":
    case "queued":
    case "accepted":
      return "sent";
    default:
      return "sent";
  }
}

async function sendViaTwilio(to: string, body: string): Promise<ProviderSendResult> {
  const sid = requiredEnv("TWILIO_ACCOUNT_SID");
  const from = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  const fallbackFrom = Deno.env.get("TWILIO_SMS_FROM");
  if (!from && !fallbackFrom) {
    throw new Error("variável de ambiente em falta: TWILIO_MESSAGING_SERVICE_SID ou TWILIO_SMS_FROM");
  }

  const params = new URLSearchParams({ To: to, Body: body });
  if (from) params.set("MessagingServiceSid", from);
  else params.set("From", fallbackFrom!);

  const res = await fetch(`${API_BASE}/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const payload = await res.json();

  if (!res.ok) {
    // Nunca considerar enviado só porque o pedido chegou -- um 4xx/5xx
    // da Twilio (número inválido, saldo esgotado, credencial errada)
    // fica registado com o erro real, não como sucesso silencioso.
    return {
      providerMessageId: payload.sid ?? "",
      status: "failed",
      errorCode: payload.code ? String(payload.code) : String(res.status),
      errorMessage: payload.message ?? `Twilio respondeu ${res.status}`,
    };
  }

  return { providerMessageId: payload.sid, status: "sent" };
}

export const twilioSmsProvider: SmsProvider = {
  name: "twilio",

  sendMessage(to: string, body: string): Promise<ProviderSendResult> {
    return sendViaTwilio(to, body);
  },

  sendOtp(to: string, code: string): Promise<ProviderSendResult> {
    // Só para um envio manual de código fora do fluxo principal (ver
    // nota em types.ts) -- o login real usa o provider Twilio nativo
    // da Auth do Supabase, não este método.
    return sendViaTwilio(to, `O seu código Fila Certa: ${code}`);
  },

  async getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatusResult> {
    const sid = requiredEnv("TWILIO_ACCOUNT_SID");
    const res = await fetch(`${API_BASE}/Accounts/${sid}/Messages/${providerMessageId}.json`, {
      headers: { Authorization: authHeader() },
    });
    const payload = await res.json();
    if (!res.ok) {
      return { status: "failed", errorCode: String(res.status), errorMessage: payload.message ?? "falha ao consultar estado" };
    }
    return {
      status: mapTwilioStatus(payload.status),
      errorCode: payload.error_code ? String(payload.error_code) : undefined,
      errorMessage: payload.error_message ?? undefined,
    };
  },
};
