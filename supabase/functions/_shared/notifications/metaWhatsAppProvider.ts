// Adapta o cliente Meta já existente (_shared/meta.ts) à interface
// comum WhatsAppProvider -- para o motor de notificações poder tratar
// Meta e Twilio (twilioWhatsAppProvider.ts) da mesma forma. Não
// duplica nenhuma lógica de transporte: só chama sendTemplate já
// existente e traduz o resultado.
import { sendTemplate, TEMPLATES, type TemplateKey } from "../meta.ts";
import type { DeliveryStatusResult, ProviderSendResult, WhatsAppProvider } from "./types.ts";

function isTemplateKey(key: string): key is TemplateKey {
  return key in TEMPLATES;
}

export const metaWhatsAppProvider: WhatsAppProvider = {
  name: "meta",

  async sendTemplate(to: string, templateKey: string, bodyParams: string[]): Promise<ProviderSendResult> {
    if (!isTemplateKey(templateKey)) {
      return { providerMessageId: "", status: "failed", errorCode: "unknown_template", errorMessage: `modelo "${templateKey}" não registado em meta.ts TEMPLATES` };
    }
    try {
      const result = await sendTemplate(to, templateKey, bodyParams);
      const messageId = result?.messages?.[0]?.id ?? "";
      return { providerMessageId: messageId, status: "sent" };
    } catch (err) {
      return { providerMessageId: "", status: "failed", errorMessage: err instanceof Error ? err.message : String(err) };
    }
  },

  // A Meta Cloud API só expõe estado de entrega por webhook
  // assíncrono (statuses), não por consulta directa como a Twilio --
  // não há um GET equivalente a fazer aqui. O motor de notificações
  // trata isto como "sem actualização disponível" (mantém o último
  // estado conhecido), nunca inventa um estado.
  async getDeliveryStatus(): Promise<DeliveryStatusResult> {
    return { status: "sent" };
  },
};
