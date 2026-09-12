import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { twilioSmsProvider } from "./twilioSmsProvider.ts";

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function setEnv() {
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest");
  Deno.env.set("TWILIO_AUTH_TOKEN", "token-test");
  Deno.env.set("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
}

Deno.test("twilioSmsProvider.sendMessage: sucesso devolve providerMessageId e status sent", async () => {
  setEnv();
  mockFetch(201, { sid: "SM123", status: "queued" });
  try {
    const result = await twilioSmsProvider.sendMessage("+244912345678", "olá");
    assertEquals(result, { providerMessageId: "SM123", status: "sent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("twilioSmsProvider.sendMessage: erro da API nunca vira sucesso silencioso", async () => {
  setEnv();
  mockFetch(400, { code: 21211, message: "número inválido" });
  try {
    const result = await twilioSmsProvider.sendMessage("+244000000000", "olá");
    assertEquals(result.status, "failed");
    assertEquals(result.errorCode, "21211");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("twilioSmsProvider: credencial em falta falha de forma explícita, nunca silenciosa", async () => {
  Deno.env.delete("TWILIO_ACCOUNT_SID");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_MESSAGING_SERVICE_SID");
  Deno.env.delete("TWILIO_SMS_FROM");
  await assertRejects(() => twilioSmsProvider.sendMessage("+244912345678", "olá"));
});

Deno.test("twilioSmsProvider.getDeliveryStatus: mapeia 'delivered' correctamente", async () => {
  setEnv();
  mockFetch(200, { status: "delivered" });
  try {
    const result = await twilioSmsProvider.getDeliveryStatus("SM123");
    assertEquals(result.status, "delivered");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
