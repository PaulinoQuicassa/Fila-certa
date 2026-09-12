// Reporte de erros das Edge Functions para o Sentry (Fase 16 do
// hardening: "monitorizar ... webhooks ... Twilio SMS ... Twilio
// WhatsApp ... RPCs críticas"). Sem SDK -- POST directo ao protocolo
// de envelope do Sentry (documentado publicamente), no mesmo espírito
// do resto deste ficheiro _shared (fetch cru para a Meta/Twilio, nunca
// um SDK pesado dentro de uma Edge Function). Reaproveita a mesma DSN
// do projecto "Synovaris / fila-certa-staff" já usada em
// `src/sentry.ts` -- uma DSN não é secreta (mesma natureza da
// publishable key do Supabase), por isso não há aqui nenhuma
// credencial nova a configurar; eventos das Edge Functions aparecem
// no mesmo projecto, distinguíveis pela tag `runtime: "edge-function"`
// e por `server_name` (nome da função).
const SENTRY_DSN = 'https://c2c9bf2d35932d531cf3948ea40bacd2@o4512046055161856.ingest.us.sentry.io/4512046087208960';

interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    return { publicKey: url.username, host: url.host, projectId };
  } catch {
    return null;
  }
}

const PARSED_DSN = parseDsn(SENTRY_DSN);

// Nunca deixar sair um destes valores, mesmo por engano num `extra`
// passado por um chamador -- rede de segurança, não uma licença para
// passar isto aqui (Fase 16: "NUNCA enviar OTP, password, tokens,
// telefone completo").
const REDACT_KEY_PATTERN = /token|password|senha|secret|otp|c[oó]digo|auth_token/i;
const PHONE_PATTERN = /(\+?\d[\d\s-]{7,}\d)/g;

function redactString(value: string): string {
  return value.replace(PHONE_PATTERN, (m) => `${m.slice(0, 3)}…[oculto]`);
}

function redactValue(value: unknown, key?: string): unknown {
  if (typeof key === 'string' && REDACT_KEY_PATTERN.test(key)) return '[redigido]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

export interface CaptureOptions {
  /** Nome da Edge Function que reporta -- aparece como server_name no Sentry. */
  functionName: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** Reporta uma excepção ao Sentry -- nunca lança (uma falha a reportar
 * um erro não pode, ela própria, derrubar quem chama). `extra`/`tags`
 * passam sempre pela redacção acima antes de sair. */
export async function captureException(error: unknown, options: CaptureOptions): Promise<void> {
  if (!PARSED_DSN) return;

  const message = error instanceof Error ? error.message : String(error);
  const exceptionType = error instanceof Error ? error.name : 'Error';
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp: now,
    platform: 'other',
    level: 'error',
    server_name: options.functionName,
    tags: { runtime: 'edge-function', function: options.functionName, ...(options.tags ?? {}) },
    extra: options.extra ? redactValue(options.extra) : undefined,
    exception: {
      values: [{ type: exceptionType, value: redactString(message) }],
    },
  };

  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: now, dsn: SENTRY_DSN });
  const itemHeader = JSON.stringify({ type: 'event' });
  const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}`;

  const ingestUrl = `https://${PARSED_DSN.host}/api/${PARSED_DSN.projectId}/envelope/?sentry_key=${PARSED_DSN.publicKey}&sentry_version=7`;

  try {
    await fetch(ingestUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body });
  } catch (sendError) {
    // Nunca deixar uma falha de rede a reportar um erro apagar o erro
    // original do log -- fica pelo menos no console da função.
    console.error(`[sentry] falha ao reportar erro de ${options.functionName}:`, sendError);
  }
}
