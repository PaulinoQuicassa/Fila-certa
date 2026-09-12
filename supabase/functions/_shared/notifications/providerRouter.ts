// Escolhe o fornecedor activo por canal e aplica um fallback opcional
// (Fase 13) -- nenhuma Edge Function chama um fornecedor concreto
// directamente, todas passam por aqui. Acrescentar um fornecedor novo
// no futuro (outra operadora de SMS, outro canal) só precisa de um
// `case` novo nestas duas funções, nunca de mudar o motor de
// notificações (engine.ts) nem quem o chama.
import type { ProviderSendResult, SmsProvider, WhatsAppProvider } from "./types.ts";
import { twilioSmsProvider } from "./twilioSmsProvider.ts";
import { metaWhatsAppProvider } from "./metaWhatsAppProvider.ts";
import { twilioWhatsAppProvider } from "./twilioWhatsAppProvider.ts";

function smsProviderByName(name: string): SmsProvider {
  switch (name) {
    case "twilio":
      return twilioSmsProvider;
    default:
      throw new Error(`fornecedor de SMS desconhecido: "${name}"`);
  }
}

function whatsAppProviderByName(name: string): WhatsAppProvider {
  switch (name) {
    case "meta":
      return metaWhatsAppProvider;
    case "twilio":
      return twilioWhatsAppProvider;
    default:
      throw new Error(`fornecedor de WhatsApp desconhecido: "${name}"`);
  }
}

/** Fornecedor principal de WhatsApp: Meta por omissão -- é o que já
 * está configurado e aprovado em produção (canal conversacional
 * existente). Definir WHATSAPP_PROVIDER=twilio activa a Twilio como
 * principal assim que as credenciais/templates da Fase 10 estiverem
 * configurados. */
function primaryWhatsAppProviderName(): string {
  return Deno.env.get("WHATSAPP_PROVIDER") ?? "meta";
}

/** Fornecedor de reserva (Fase 13) -- só entra em acção se o principal
 * falhar E este estiver definido. Sem valor por omissão: sem uma
 * segunda credencial configurada, não há fornecedor de reserva real
 * para tentar (nunca simula um). */
function fallbackWhatsAppProviderName(): string | undefined {
  return Deno.env.get("WHATSAPP_PROVIDER_FALLBACK") || undefined;
}

function fallbackSmsProviderName(): string | undefined {
  return Deno.env.get("SMS_PROVIDER_FALLBACK") || undefined;
}

/** Twilio por omissão -- único fornecedor de SMS implementado até
 * agora. A variável existe desde já para uma segunda operadora poder
 * ser activada no futuro sem mudar nenhum chamador (Fase 9: "preparar
 * arquitectura para adicionar outro fornecedor depois"). */
function primarySmsProviderName(): string {
  return Deno.env.get("SMS_PROVIDER") ?? "twilio";
}

export interface RoutedSendResult extends ProviderSendResult {
  providerName: string;
  /** true se o fornecedor principal falhou e isto é o resultado do
   * fornecedor de reserva (ou a falha do principal, se não houver
   * reserva configurada). */
  usedFallback: boolean;
}

export async function sendSms(to: string, body: string): Promise<RoutedSendResult> {
  const primary = smsProviderByName(primarySmsProviderName());
  const primaryResult = await primary.sendMessage(to, body);
  if (primaryResult.status !== "failed") return { ...primaryResult, providerName: primary.name, usedFallback: false };

  const fallbackName = fallbackSmsProviderName();
  if (!fallbackName || fallbackName === primary.name) return { ...primaryResult, providerName: primary.name, usedFallback: false };

  const fallback = smsProviderByName(fallbackName);
  const fallbackResult = await fallback.sendMessage(to, body);
  return { ...fallbackResult, providerName: fallback.name, usedFallback: true };
}

export async function sendWhatsAppTemplate(to: string, templateKey: string, bodyParams: string[]): Promise<RoutedSendResult> {
  const primary = whatsAppProviderByName(primaryWhatsAppProviderName());
  const primaryResult = await primary.sendTemplate(to, templateKey, bodyParams);
  if (primaryResult.status !== "failed") return { ...primaryResult, providerName: primary.name, usedFallback: false };

  const fallbackName = fallbackWhatsAppProviderName();
  if (!fallbackName || fallbackName === primary.name) return { ...primaryResult, providerName: primary.name, usedFallback: false };

  const fallback = whatsAppProviderByName(fallbackName);
  const fallbackResult = await fallback.sendTemplate(to, templateKey, bodyParams);
  return { ...fallbackResult, providerName: fallback.name, usedFallback: true };
}
