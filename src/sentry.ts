import * as Sentry from '@sentry/react';

// DSN não é secreta (mesma natureza da publishable key do Supabase) --
// identifica só o projecto Sentry para onde os eventos são enviados,
// não dá acesso a nada. Projecto: Synovaris / fila-certa-staff.
const SENTRY_DSN = 'https://c2c9bf2d35932d531cf3948ea40bacd2@o4512046055161856.ingest.us.sentry.io/4512046087208960';

export function initSentry() {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    // Sem tracing/session replay -- só rastreio de erros (é o que foi
    // pedido; tracing teria custo de performance e quota sem
    // necessidade comprovada ainda).
    integrations: [],
    tracesSampleRate: 0,
  });
}

/** Reporta um erro com contexto de negócio (que acção, que instituição/
 * filial) -- usado nos pontos onde a app já trata o erro (RPCs, auth),
 * para o Sentry mostrar mais do que só "Error: ...". */
export function reportError(error: unknown, context?: Record<string, unknown>) {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
