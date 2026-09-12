// Fornecedor de WhatsApp via Twilio WhatsApp Business Platform (Fase
// 10). Continua a existir a par do fornecedor Meta directo já usado
// pelo canal conversacional (whatsapp-webhook/flows.ts) -- ver
// docs/notifications-architecture.md para porque é que os dois
// convivem em vez de um substituir o outro, e para a lista de
// segredos/templates que faltam configurar antes disto poder mandar
// uma mensagem real.
import type { DeliveryStatusResult, ProviderSendResult, WhatsAppProvider } from "./types.ts";
import { mapTwilioStatus } from "./mapTwilioStatus.ts";

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

/** Regista o SID de conteúdo (Content API) aprovado na Twilio para
 * cada modelo lógico usado pelo motor de notificações -- os nomes/IDs
 * reais têm de vir da Twilio Console depois de o template ser
 * submetido e aprovado pela Meta através da Twilio; nunca inventados
 * aqui (Fase 1: "não inventar credenciais, números, IDs ou
 * configurações"). Uma variável de ambiente em falta faz o envio
 * desse modelo falhar de forma explícita, nunca silenciosa. */
function contentSidFor(templateKey: string): string {
  const envName = `TWILIO_WHATSAPP_TEMPLATE_${templateKey.toUpperCase()}`;
  return requiredEnv(envName);
}

async function sendContentTemplate(to: string, templateKey: string, bodyParams: string[]): Promise<ProviderSendResult> {
  const sid = requiredEnv("TWILIO_ACCOUNT_SID");
  const from = requiredEnv("TWILIO_WHATSAPP_FROM"); // formato "whatsapp:+14155238886"
  const contentSid = contentSidFor(templateKey);

  const variables: Record<string, string> = {};
  bodyParams.forEach((value, index) => { variables[String(index + 1)] = value; });

  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: from,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
  // Sem Messaging Service aqui (usa `From` directo) -- sem isto não há
  // nenhum outro sítio configurável na Twilio para receber o estado
  // real de entrega (Fase 10: "guardar o estado real").
  const statusCallback = Deno.env.get("TWILIO_STATUS_CALLBACK_URL");
  if (statusCallback) params.set("StatusCallback", statusCallback);

  const res = await fetch(`${API_BASE}/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const payload = await res.json();

  if (!res.ok) {
    // Mesma regra do provider de SMS: um erro da API fica registado
    // como falha real, nunca mascarado como envio bem sucedido.
    return {
      providerMessageId: payload.sid ?? "",
      status: "failed",
      errorCode: payload.code ? String(payload.code) : String(res.status),
      errorMessage: payload.message ?? `Twilio respondeu ${res.status}`,
    };
  }

  return { providerMessageId: payload.sid, status: "sent" };
}

export const twilioWhatsAppProvider: WhatsAppProvider = {
  name: "twilio",

  sendTemplate(to: string, templateKey: string, bodyParams: string[]): Promise<ProviderSendResult> {
    return sendContentTemplate(to, templateKey, bodyParams);
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
