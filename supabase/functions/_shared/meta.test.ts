import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyMetaSignature } from "./meta.ts";

const SECRET = "test-app-secret";

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("verifyMetaSignature: aceita uma assinatura correcta", async () => {
  Deno.env.set("META_APP_SECRET", SECRET);
  const body = JSON.stringify({ hello: "world" });
  const signature = await sign(body, SECRET);
  assertEquals(await verifyMetaSignature(body, signature), true);
});

Deno.test("verifyMetaSignature: rejeita uma assinatura errada", async () => {
  Deno.env.set("META_APP_SECRET", SECRET);
  const body = JSON.stringify({ hello: "world" });
  const wrongSignature = await sign(body, "chave-errada");
  assertEquals(await verifyMetaSignature(body, wrongSignature), false);
});

Deno.test("verifyMetaSignature: rejeita corpo alterado depois de assinado", async () => {
  Deno.env.set("META_APP_SECRET", SECRET);
  const signature = await sign(JSON.stringify({ hello: "world" }), SECRET);
  const tamperedBody = JSON.stringify({ hello: "mundo alterado" });
  assertEquals(await verifyMetaSignature(tamperedBody, signature), false);
});

Deno.test("verifyMetaSignature: rejeita cabeçalho em falta", async () => {
  Deno.env.set("META_APP_SECRET", SECRET);
  assertEquals(await verifyMetaSignature("{}", null), false);
});

Deno.test("verifyMetaSignature: rejeita formato sem prefixo sha256=", async () => {
  Deno.env.set("META_APP_SECRET", SECRET);
  assertEquals(await verifyMetaSignature("{}", "abcdef"), false);
});
