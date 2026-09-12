// Verificação de assinatura dos webhooks/callbacks da Twilio (Fase 20:
// "Rever todos os webhooks Twilio/Meta ... validar assinatura, tempo
// constante"). Mesmo algoritmo documentado publicamente pela Twilio:
// HMAC-SHA1(AuthToken, url + parâmetros de formulário ordenados por
// chave, concatenados sem separador), Base64, comparado à cabeçalho
// `X-Twilio-Signature`.
//
// A "url" usada tem de ser exactamente a URL configurada na consola da
// Twilio para este callback -- nunca `req.url` directamente, porque
// atrás de um proxy/CDN (como é o caso de qualquer Edge Function) o
// protocolo/host que a Twilio assinou pode não bater certo com o que
// o runtime vê. Por isso esta função recebe a URL completa já
// resolvida por quem chama (a partir de `TWILIO_STATUS_CALLBACK_URL`),
// nunca a deriva sozinha de `req`.
function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente em falta: ${name}`);
  return value;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `params` deve conter todos os campos do corpo `application/x-www-form-urlencoded`
 * do pedido (nunca query string -- só o corpo, por definição da Twilio). */
export async function verifyTwilioSignature(fullUrl: string, params: Record<string, string>, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false;
  const authToken = requiredEnv("TWILIO_AUTH_TOKEN");

  const sortedKeys = Object.keys(params).sort();
  let data = fullUrl;
  for (const key of sortedKeys) data += key + params[key];

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = base64FromBytes(new Uint8Array(signatureBytes));

  return constantTimeEquals(expected, signatureHeader);
}
