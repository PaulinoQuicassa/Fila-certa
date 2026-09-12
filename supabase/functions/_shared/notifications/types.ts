// Contratos do motor de notificações -- nenhuma implementação aqui,
// só as formas que qualquer canal/fornecedor tem de respeitar. Ver
// docs/notifications-architecture.md para o desenho completo (Fases
// 8-14 do pedido de hardening).

export type NotificationChannel = "sms" | "whatsapp";

export type NotificationPriority = "critical" | "high" | "medium" | "low";

export type NotificationStatus = "queued" | "sent" | "delivered" | "failed" | "read";

export interface ProviderSendResult {
  providerMessageId: string;
  /** Estado logo a seguir ao pedido -- NUNCA "delivered" aqui: um 202
   * da API do fornecedor só confirma que o pedido foi aceite, não que
   * a mensagem chegou. "delivered"/"read" só chegam depois, por
   * callback de estado (getDeliveryStatus ou webhook do fornecedor). */
  status: "sent" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

export interface DeliveryStatusResult {
  status: NotificationStatus;
  errorCode?: string;
  errorMessage?: string;
}

/** Fornecedor de SMS -- usado pelo motor de notificações para canais
 * `sms`. `sendOtp` existe pela mesma interface que `sendMessage`
 * (ambos mandam SMS), mas a OTP de login REAL da app não passa por
 * aqui: usa o fornecedor Twilio configurado directamente na Auth do
 * Supabase (Dashboard -> Authentication -> Providers -> Phone), que já
 * trata expiração/reenvio/limite de tentativas com o mesmo rigor de
 * segurança de qualquer outro provider de Auth -- duplicar essa lógica
 * aqui violaria a Fase 1 do pedido ("evitar duplicar soluções
 * existentes"). Esta interface serve o motor de notificações
 * (avisos de fila), e fica pronta para um envio manual de código caso
 * algum dia seja mesmo preciso fora da Auth. */
export interface SmsProvider {
  readonly name: string;
  sendMessage(to: string, body: string): Promise<ProviderSendResult>;
  sendOtp(to: string, code: string): Promise<ProviderSendResult>;
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatusResult>;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendTemplate(to: string, templateKey: string, bodyParams: string[]): Promise<ProviderSendResult>;
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatusResult>;
}
