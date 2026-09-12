import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { captureException } from "./sentry.ts";

const originalFetch = globalThis.fetch;

Deno.test("captureException: envia um envelope válido com o erro e as tags esperadas", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: string | undefined;
  let capturedHeaders: HeadersInit | undefined;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    capturedHeaders = init?.headers;
    return Promise.resolve(new Response("", { status: 200 }));
  };

  try {
    await captureException(new Error("falha ao enviar SMS"), {
      functionName: "whatsapp-notifier",
      tags: { channel: "sms" },
      extra: { ticketId: "abc-123" },
    });

    assertStringIncludes(capturedUrl!, "/envelope/?sentry_key=");
    assertEquals((capturedHeaders as Record<string, string>)["Content-Type"], "application/x-sentry-envelope");

    const lines = capturedBody!.split("\n");
    assertEquals(lines.length, 3);
    const eventLine = JSON.parse(lines[2]);
    assertEquals(eventLine.server_name, "whatsapp-notifier");
    assertEquals(eventLine.tags.runtime, "edge-function");
    assertEquals(eventLine.tags.channel, "sms");
    assertEquals(eventLine.exception.values[0].value, "falha ao enviar SMS");
    assertEquals(eventLine.extra.ticketId, "abc-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("captureException: redige chaves sensíveis em extra antes de enviar", async () => {
  let capturedBody: string | undefined;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body);
    return Promise.resolve(new Response("", { status: 200 }));
  };

  try {
    await captureException(new Error("falha na verificação"), {
      functionName: "whatsapp-webhook",
      extra: { otpCode: "123456", accessToken: "eyJ.abc.def", ticketId: "xyz" },
    });

    const eventLine = JSON.parse(capturedBody!.split("\n")[2]);
    assertEquals(eventLine.extra.otpCode, "[redigido]");
    assertEquals(eventLine.extra.accessToken, "[redigido]");
    assertEquals(eventLine.extra.ticketId, "xyz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("captureException: mascara números de telefone na mensagem da excepção", async () => {
  let capturedBody: string | undefined;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body);
    return Promise.resolve(new Response("", { status: 200 }));
  };

  try {
    await captureException(new Error("falha ao enviar para +244923456789"), { functionName: "test" });
    const eventLine = JSON.parse(capturedBody!.split("\n")[2]);
    assertEquals(eventLine.exception.values[0].value.includes("923456789"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("captureException: nunca lança, mesmo que o envio falhe", async () => {
  globalThis.fetch = () => Promise.reject(new Error("rede em baixo"));
  try {
    await captureException(new Error("erro original"), { functionName: "test" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
