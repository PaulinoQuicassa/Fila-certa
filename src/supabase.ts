import { createClient } from '@supabase/supabase-js';

// Projecto Supabase real (qdfpqispcntitvczybfl) -- ver
// docs/migration-plan.md, Fase 3. A "publishable key" (prefixo
// sb_publishable_) não é secreta -- o controlo de acesso vive
// inteiramente nas políticas RLS (docs/security-rls.md), nunca na chave.
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

// Conta técnica partilhada por balcão -- usada só pela estação de
// auto-atendimento (`Estacao.tsx`), sem login visível para o cidadão que
// chega fisicamente ao balcão. Não é uma sessão anónima: `pull_ticket`
// recusa explicitamente sessões anónimas ("apenas clientes autenticados
// podem tirar senha"), por isso a estação precisa de uma conta real,
// mas sem nenhum dado pessoal do cidadão associado -- todas as senhas
// tiradas na estação ficam associadas a esta mesma conta técnica.
// Mesmo tratamento de "não secreto" que o resto deste ficheiro: quem
// está fisicamente à frente do quiosque já pode tirar uma senha à
// vontade, expor a conta que faz exactamente isso não abre nenhuma
// porta nova.
const STATION_EMAIL = import.meta.env.VITE_STATION_EMAIL ?? 'estacao@filacerta.test';
const STATION_PASSWORD = import.meta.env.VITE_STATION_PASSWORD ?? 'teste123';

/** Garante a sessão da conta de estação -- usado só por `Estacao.tsx`. */
export async function ensureStationSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInWithPassword({ email: STATION_EMAIL, password: STATION_PASSWORD });
  if (error) throw new Error(`Conta de estação não configurada: ${error.message}`);
}
