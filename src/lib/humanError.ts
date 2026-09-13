/** Traduz erros técnicos (RPC/JWT/HTTP) para linguagem humana. */
export function humanError(err: unknown, fallback = 'Não foi possível concluir. Tente novamente.'): string {
  const raw = err instanceof Error ? err.message : '';
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (
    lower.includes('jwt') ||
    lower.includes('pgrst') ||
    lower.includes('rpc') ||
    lower.includes('permission denied') ||
    lower.includes('row-level') ||
    lower.includes('internal server') ||
    /^\d{3}\b/.test(raw)
  ) {
    return fallback;
  }
  if (/[áàâãéêíóôõúç]/i.test(raw) || raw.includes('senha') || raw.includes('balcão') || raw.includes('fila')) {
    return raw;
  }
  return fallback;
}
