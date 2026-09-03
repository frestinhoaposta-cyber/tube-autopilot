const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const supabase = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

function ensureSupabase() {
  if (!isSupabaseConfigured()) {
    throw Object.assign(new Error('Autenticação não configurada no servidor.'), { status: 503 });
  }
}

function friendlyEmailError(message) {
  const text = String(message || '');
  if (/already|cadastrado|exists|registered/i.test(text)) return 'Este e-mail já está cadastrado.';
  if (/password|senha|weak|short|minimum|at least/i.test(text)) return 'A senha não atende aos requisitos mínimos.';
  return 'Não foi possível criar a conta.';
}

async function signUp({ email, password }) {
  ensureSupabase();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw Object.assign(new Error(friendlyEmailError(error.message)), { status: 400 });
  if (!data?.user || !data?.session) throw Object.assign(new Error('Não foi possível criar a conta.'), { status: 400 });
  return { id: data.user.id, email: data.user.email };
}

async function signIn({ email, password }) {
  ensureSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data?.user) throw Object.assign(new Error('E-mail ou senha inválidos.'), { status: 401 });
  return { id: data.user.id, email: data.user.email };
}

module.exports = { isSupabaseConfigured, signUp, signIn };