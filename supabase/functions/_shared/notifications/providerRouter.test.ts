import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendSms, sendWhatsAppTemplate } from "./providerRouter.ts";

const originalFetch = globalThis.fetch;

function clearEnv(...names: string[]) {
  for (const name of names) Deno.env.delete(name);
}

Deno.test("sendWhatsAppTemplate: sem fallback configurado, falha do principal fica como falha", async () => {
  clearEnv("WHATSAPP_PROVIDER", "WHATSAPP_PROVIDER_FALLBACK", "META_PHONE_NUMBER_ID", "META_ACCESS_TOKEN");
  const result = await sendWhatsAppTemplate("+244912345678", "QUEUE_CALLED", ["B001", "1"]);
  assertEquals(result.usedFallback, false);
  assertEquals(result.status, "failed");
  assertEquals(result.providerName, "meta");
});

Deno.test("sendWhatsAppTemplate: falha do fornecedor principal usa o de reserva (Fase 13)", async () => {
  clearEnv("META_PHONE_NUMBER_ID", "META_ACCESS_TOKEN"); // força o meta (principal) a falhar
  Deno.env.set("WHATSAPP_PROVIDER", "meta");
  Deno.env.set("WHATSAPP_PROVIDER_FALLBACK", "twilio");
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest");
  Deno.env.set("TWILIO_AUTH_TOKEN", "token-test");
  Deno.env.set("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
  Deno.env.set("TWILIO_WHATSAPP_TEMPLATE_QUEUE_CALLED", "HXtest");

  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }));

  try {
    const result = await sendWhatsAppTemplate("+244912345678", "QUEUE_CALLED", ["B001", "1"]);
    assertEquals(result.usedFallback, true);
    assertEquals(result.providerName, "twilio");
    assertEquals(result.status, "sent");
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv("WHATSAPP_PROVIDER", "WHATSAPP_PROVIDER_FALLBACK");
  }
});

Deno.test("sendSms: sucesso do fornecedor principal não toca no de reserva", async () => {
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest");
  Deno.env.set("TWILIO_AUTH_TOKEN", "token-test");
  Deno.env.set("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
  clearEnv("SMS_PROVIDER_FALLBACK");

  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ sid: "SM2", status: "queued" }), { status: 201 }));

  try {
    const result = await sendSms("+244912345678", "olá");
    assertEquals(result.usedFallback, false);
    assertEquals(result.providerName, "twilio");
    assertEquals(result.status, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
