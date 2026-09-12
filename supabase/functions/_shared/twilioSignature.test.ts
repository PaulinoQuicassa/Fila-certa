import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyTwilioSignature } from "./twilioSignature.ts";

const AUTH_TOKEN = "test-auth-token";
const URL = "https://example.supabase.co/functions/v1/twilio-status-callback";

// Mesmo algoritmo documentado pela Twilio, implementado de forma
// independente aqui (não chama a função testada) -- confirma que
// `verifyTwilioSignature` aceita uma assinatura calculada
// correctamente e rejeita qualquer adulteração, tal como
// `meta.test.ts` já faz para a Meta.
async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  let binary = "";
  for (const b of new Uint8Array(sigBytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

Deno.test("verifyTwilioSignature: aceita uma assinatura correcta", async () => {
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  const params = { MessageSid: "SM123", MessageStatus: "delivered", To: "+244912345678" };
  const signature = await sign(URL, params, AUTH_TOKEN);
  assertEquals(await verifyTwilioSignature(URL, params, signature), true);
});

Deno.test("verifyTwilioSignature: rejeita uma assinatura com o Auth Token errado", async () => {
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  const params = { MessageSid: "SM123", MessageStatus: "delivered" };
  const signature = await sign(URL, params, "auth-token-errado");
  assertEquals(await verifyTwilioSignature(URL, params, signature), false);
});

Deno.test("verifyTwilioSignature: rejeita parâmetros alterados depois de assinados", async () => {
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  const signature = await sign(URL, { MessageSid: "SM123", MessageStatus: "delivered" }, AUTH_TOKEN);
  const tamperedParams = { MessageSid: "SM123", MessageStatus: "failed" };
  assertEquals(await verifyTwilioSignature(URL, tamperedParams, signature), false);
});

Deno.test("verifyTwilioSignature: rejeita cabeçalho em falta", async () => {
  Deno.env.set("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  assertEquals(await verifyTwilioSignature(URL, { MessageSid: "SM123" }, null), false);
});
