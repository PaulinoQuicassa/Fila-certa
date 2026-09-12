import type { NotificationStatus } from "./types.ts";

// Twilio devolve estados próprios (queued/sending/sent/delivered/
// undelivered/failed/read) -- mapeados para o vocabulário interno do
// motor de notificações (ver types.ts) para nenhum outro módulo
// precisar de conhecer o vocabulário de um fornecedor específico.
// Partilhado entre os providers (resposta síncrona ao enviar) e o
// callback de estado (`twilio-status-callback`, resposta assíncrona).
export function mapTwilioStatus(twilioStatus: string): NotificationStatus {
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
