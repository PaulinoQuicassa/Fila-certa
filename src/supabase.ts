import { createClient } from '@supabase/supabase-js';

// Projecto Supabase real (qdfpqispcntitvczybfl) -- ver
// docs/migration-plan.md, Fase 3. A "anon key" (agora "publishable key",
// prefixo sb_publishable_) não é secreta -- o controlo de acesso vive nas
// políticas RLS (docs/security.md), não na chave, exactamente como a
// config web do Firebase que substitui.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY em falta (ver .env.example).');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/** Garante uma sessão (anónima se não houver nenhuma) -- usado só pelo
 * painel de TV (`PublicDisplay.tsx`), que não faz login. Centralizado
 * aqui para a página não chamar `supabase.auth` directamente (mantém a
 * separação UI → data source pedida na Fase 10). */
export async function ensureAnonymousSession() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    await supabase.auth.signInAnonymously();
  }
}
