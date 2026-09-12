import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { twilioWhatsAppProvider } from "./twilioWhatsAppProvider.ts";

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function setEnv() {
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest");
  Deno.env.set("TWILIO_AUTH_TOKEN", "token-test");
  Deno.env.set("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
  Deno.env.set("TWILIO_WHATSAPP_TEMPLATE_QUEUE_CALLED", "HXtest");
}

Deno.test("twilioWhatsAppProvider.sendTemplate: sucesso devolve providerMessageId", async () => {
  setEnv();
  mockFetch(201, { sid: "SM999", status: "queued" });
  try {
    const result = await twilioWhatsAppProvider.sendTemplate("+244912345678", "QUEUE_CALLED", ["B001", "Guichê 1"]);
    assertEquals(result, { providerMessageId: "SM999", status: "sent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("twilioWhatsAppProvider.sendTemplate: template sem Content SID configurado falha de forma explícita", async () => {
  setEnv();
  Deno.env.delete("TWILIO_WHATSAPP_TEMPLATE_QUEUE_NEAR_TURN");
  let threw = false;
  try {
    await twilioWhatsAppProvider.sendTemplate("+244912345678", "QUEUE_NEAR_TURN", ["B002"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("twilioWhatsAppProvider.sendTemplate: erro da API nunca vira sucesso silencioso", async () => {
  setEnv();
  mockFetch(400, { code: 63016, message: "fora da janela de 24h sem template aprovado" });
  try {
    const result = await twilioWhatsAppProvider.sendTemplate("+244912345678", "QUEUE_CALLED", ["B001", "Guichê 1"]);
    assertEquals(result.status, "failed");
    assertEquals(result.errorCode, "63016");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
