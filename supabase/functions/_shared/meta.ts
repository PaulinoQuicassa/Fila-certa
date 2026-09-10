// Cliente fino sobre a Meta WhatsApp Cloud API -- só transporte
// (assinar/verificar, enviar mensagens). Nenhuma regra de negócio
// vive aqui; quem decide O QUE enviar são os flows
// (whatsapp-webhook/flows.ts) e o notifier.

const GRAPH_VERSION = "v21.0";

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente em falta: ${name}`);
  return value;
}

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 do corpo com o App
 * Secret) -- rejeita qualquer pedido cuja assinatura não bata certo,
 * antes de processar o que quer que seja. */
export async function verifyMetaSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = "sha256=" + Array.from(new Uint8Array(signatureBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Comparação em tempo constante -- evita side-channel por diferença
  // de tempo entre assinaturas quase certas e completamente erradas.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

async function graphFetch(path: string, body: unknown) {
  const phoneNumberId = env("META_PHONE_NUMBER_ID");
  const accessToken = env("META_ACCESS_TOKEN");
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Meta Graph API ${res.status}: ${detail}`);
  }
  return res.json();
}

export function sendText(to: string, body: string) {
  return graphFetch("messages", { messaging_product: "whatsapp", to, type: "text", text: { body } });
}

export interface Button {
  id: string;
  title: string; // máx. 20 caracteres (limite da Meta)
}

export function sendInteractiveButtons(to: string, bodyText: string, buttons: Button[]) {
  return graphFetch("messages", {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  });
}

export interface ListRow {
  id: string;
  title: string; // máx. 24 caracteres
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export function sendInteractiveList(to: string, bodyText: string, buttonText: string, sections: ListSection[]) {
  return graphFetch("messages", {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: { button: buttonText, sections },
    },
  });
}

/** Registo de templates aprovados pela Meta -- nomes lógicos usados
 * pelos flows, nunca o nome/ID real do template espalhado pelo
 * código. Os nomes/idiomas reais têm de corresponder ao que foi
 * criado e aprovado no Meta Business Manager -- ver
 * docs/whatsapp-channel.md, secção "Templates". */
export const TEMPLATES = {
  QUEUE_NEAR_TURN: { name: "queue_near_turn", language: "pt_PT" },
  QUEUE_CALLED: { name: "queue_called", language: "pt_PT" },
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

/** Mensagens-template só podem ser usadas para reabrir a conversa fora
 * da janela de 24h (é exactamente o caso dos dois avisos automáticos
 * -- "está quase"/"é a sua vez" -- que o servidor inicia, não o
 * cidadão). Ver Fase 5/18 da conversa. */
export function sendTemplate(to: string, key: TemplateKey, bodyParams: string[]) {
  const tpl = TEMPLATES[key];
  return graphFetch("messages", {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: tpl.name,
      language: { code: tpl.language },
      components: bodyParams.length > 0
        ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
        : undefined,
    },
  });
}
