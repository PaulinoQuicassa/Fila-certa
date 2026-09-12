import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { reportError } from '../sentry';
import type { StaffProfile } from '../types';

interface AuthState {
  user: User | null;
  profile: StaffProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchProfile(uid: string): Promise<StaffProfile | null> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, role, institution_id, branch_id, counter_id')
    .eq('id', uid)
    .maybeSingle();
  if (error || !data) return null;
  return {
    uid: data.id,
    name: data.name,
    role: data.role,
    institutionId: data.institution_id,
    branchId: data.branch_id,
    counterId: data.counter_id ?? undefined,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function applySession(u: User | null) {
      setUser(u);
      if (u) {
        const p = await fetchProfile(u.id);
        if (active) setProfile(p);
      } else if (active) {
        setProfile(null);
      }
      if (active) setLoading(false);
    }

    supabase.auth.getSession()
      .then(({ data }) => applySession(data.session?.user ?? null))
      .catch(() => {
        if (active) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session?.user ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      // Nunca o email/password em si -- só a classificação do erro
      // (código da Auth), suficiente para detectar um pico de falhas
      // de login sem guardar quem tentou nem com que credencial.
      reportError(error ?? new Error('login-failed'), { flow: 'staff_login', authErrorCode: error?.code });
      throw error ?? new Error('login-failed');
    }
    const p = await fetchProfile(data.user.id);
    if (!p) {
      await supabase.auth.signOut();
      throw new Error('no-staff-profile');
    }
  }

  async function logout() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
