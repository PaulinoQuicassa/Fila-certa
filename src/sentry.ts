import * as Sentry from '@sentry/react';

// DSN não é secreta (mesma natureza da publishable key do Supabase) --
// identifica só o projecto Sentry para onde os eventos são enviados,
// não dá acesso a nada. Projecto: Synovaris / fila-certa-staff.
const SENTRY_DSN = 'https://c2c9bf2d35932d531cf3948ea40bacd2@o4512046055161856.ingest.us.sentry.io/4512046087208960';

// Nunca deixar sair um destes valores para o Sentry, mesmo por engano
// num `extra`/`tags` passado a reportError -- redacção defensiva
// aplicada a QUALQUER string do evento antes de sair (Fase 16:
// "NUNCA enviar OTP, password, tokens, telefone completo").
const REDACT_KEY_PATTERN = /token|password|senha|secret|otp|c[oó]digo/i;
const PHONE_PATTERN = /(\+?\d[\d\s-]{7,}\d)/g;
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;

function redactString(value: string): string {
  return value.replace(JWT_PATTERN, '[jwt-removido]').replace(PHONE_PATTERN, (m) => `${m.slice(0, 3)}…[oculto]`);
}

function redactValue(value: unknown, key?: string): unknown {
  if (typeof key === 'string' && REDACT_KEY_PATTERN.test(key)) return '[redigido]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request?.headers) delete event.request.headers['Authorization'];
  if (event.extra) event.extra = redactValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = redactValue(event.contexts) as typeof event.contexts;
  if (event.message) event.message = redactString(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactString(value.value);
  }
  return event;
}

export function initSentry() {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    // Só rastreio de erros -- sem tracing/session replay (custo de
    // performance e quota sem necessidade comprovada), mas com os
    // handlers globais/dedupe/linked-errors por omissão para apanhar
    // também excepções não tratadas (antes `integrations: []`
    // desligava isto por completo -- nenhum erro fora do
    // ErrorBoundary chegava a ser reportado).
    integrations: [Sentry.dedupeIntegration(), Sentry.linkedErrorsIntegration()],
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: redactEvent,
  });
}

/** Reporta um erro com contexto de negócio (que acção, que instituição/
 * filial) -- usado nos pontos onde a app já trata o erro (RPCs, auth),
 * para o Sentry mostrar mais do que só "Error: ...". O `context` passa
 * sempre pela redacção de `beforeSend`, mas nunca deve conter
 * propositadamente password/token/OTP/telefone completo -- a redacção
 * é uma rede de segurança, não uma licença para passar isso aqui. */
export function reportError(error: unknown, context?: Record<string, unknown>) {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
