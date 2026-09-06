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
