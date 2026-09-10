// Peça central do canal WhatsApp: em vez de reescrever pull_ticket/
// waiting_ahead_count/cancel_ticket etc. "para o servidor", garantimos
// uma conta REAL (auth.users) ligada a cada número de telefone e
// geramos uma sessão dessa conta -- as RPCs correm depois com
// auth.uid() = essa conta, exactamente como quando é a app do cidadão
// a chamá-las. RLS não muda nada; zero lógica de fila duplicada aqui.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente em falta: ${name}`);
  return value;
}

function adminClient(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Email sintético e determinístico -- nunca usado para login por
 * password (a conta não tem nenhuma definida), só como identificador
 * técnico exigido pelo Supabase Auth. Facilmente distinguível de
 * contas reais nos relatórios (domínio fixo + user_metadata.channel). */
function syntheticEmail(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return `${digits}@whatsapp.filacerta.local`;
}

export interface CitizenSession {
  userId: string;
  accessToken: string;
  isNewContact: boolean;
}

/** Garante a conta ligada a este número (cria-a da 1ª vez) e devolve
 * um access_token válido dessa conta. */
export async function ensureCitizenSession(phone: string, displayName?: string): Promise<CitizenSession> {
  const admin = adminClient();
  const email = syntheticEmail(phone);

  const { data: existingContact, error: lookupError } = await admin
    .from("whatsapp_contacts")
    .select("user_id")
    .eq("phone", phone)
    .maybeSingle();
  if (lookupError) throw lookupError;

  let userId = existingContact?.user_id as string | undefined;
  let isNewContact = false;

  if (!userId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { channel: "whatsapp", phone, name: displayName ?? null },
    });
    if (createError) throw createError;
    userId = created.user.id;
    isNewContact = true;

    const { error: contactError } = await admin
      .from("whatsapp_contacts")
      .insert({ phone, user_id: userId, name: displayName ?? null });
    if (contactError) throw contactError;
  }

  // Troca um magic link por uma sessão real, sem enviar nenhum email
  // (a conta não tem email de verdade) -- generateLink só cria o
  // token, /auth/v1/verify troca-o por access_token/refresh_token.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkError) throw linkError;
  const hashedToken = linkData.properties?.hashed_token;
  if (!hashedToken) throw new Error("não foi possível gerar sessão para o contacto");

  const verifyRes = await fetch(`${requiredEnv("SUPABASE_URL")}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: requiredEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: hashedToken }),
  });
  if (!verifyRes.ok) throw new Error(`falha ao trocar o token por uma sessão: ${await verifyRes.text()}`);
  const verifyData = await verifyRes.json();

  return { userId: userId!, accessToken: verifyData.access_token as string, isNewContact };
}

/** Cliente Supabase autenticado COMO o cidadão -- as RPCs chamadas com
 * isto correm com auth.uid() = a conta deste telefone. */
export function citizenClient(accessToken: string): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Cliente com service_role -- só para as poucas leituras/escritas que
 * são mesmo do domínio do canal (whatsapp_contacts, estado da
 * conversa, log de mensagens), nunca para tickets/institutions. */
export function serviceClient(): SupabaseClient {
  return adminClient();
}
