// Entrypoint do webhook -- SÓ transporte: verifica a assinatura,
// deduplica, extrai a mensagem e despacha para flows.ts. Nenhuma regra
// de fila vive aqui (ver docs/whatsapp-channel.md).
import { claimInboundMessage } from "../_shared/messageLog.ts";
import { verifyMetaSignature } from "../_shared/meta.ts";
import { captureException } from "../_shared/sentry.ts";
import { handleIncomingMessage } from "./flows.ts";
import { parseIncoming } from "./parseIncoming.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Handshake da Meta (configuração do webhook no Meta Business Manager).
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === Deno.env.get("META_VERIFY_TOKEN")) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await req.text();

  const validSignature = await verifyMetaSignature(rawBody, req.headers.get("X-Hub-Signature-256"));
  if (!validSignature) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = parseIncoming(payload);
  if (!message) {
    // Notificações de estado de entrega (sent/delivered/read) também
    // chegam a este endpoint -- não têm "messages", só "statuses". Não
    // são um erro, simplesmente não há nada a fazer com elas no MVP.
    return new Response("OK", { status: 200 });
  }

  const isNewMessage = await claimInboundMessage(message.messageId, `+${message.from}`, message.text ? "text" : "interactive");
  if (!isNewMessage) {
    // Reentrega da Meta -- já processado, responde OK sem repetir nada.
    return new Response("OK", { status: 200 });
  }

  try {
    await handleIncomingMessage(message);
  } catch (err) {
    console.error("Erro a processar mensagem do WhatsApp:", err);
    // Responde 200 mesmo assim -- devolver erro faz a Meta reentregar
    // repetidamente a mesma mensagem, o que não resolve um erro do
    // nosso lado. O erro fica no log da função e no Sentry para
    // investigação (Fase 16: "monitorizar webhooks").
    await captureException(err, { functionName: "whatsapp-webhook", tags: { messageType: message.text ? "text" : "interactive" } });
  }

  return new Response("OK", { status: 200 });
});
