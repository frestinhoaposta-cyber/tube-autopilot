const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const AUTH_MODE = process.env.AUTH_MODE === 'single' ? 'single' : 'supabase';
const SINGLE_USER_ID = String(process.env.SINGLE_USER_ID || '').trim();
const SINGLE_USER_EMAIL = String(process.env.SINGLE_USER_EMAIL || 'administrador').trim();
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD || '');
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

function isSingleUserConfigured() {
  return AUTH_MODE === 'single' && Boolean(SINGLE_USER_ID) && PANEL_PASSWORD.length >= 12;
}

function validateSingleUserAuthentication() {
  if (AUTH_MODE !== 'single') return;
  if (!SINGLE_USER_ID) throw new Error('Configuração obrigatória ausente: SINGLE_USER_ID.');
  if (PANEL_PASSWORD.length < 12) throw new Error('PANEL_PASSWORD deve conter ao menos 12 caracteres.');
}

function authConfig() {
  return { mode: AUTH_MODE, registrationEnabled: AUTH_MODE !== 'single', email: AUTH_MODE === 'single' ? SINGLE_USER_EMAIL : null };
}

function verifySingleUserPassword(password) {
  if (!isSingleUserConfigured()) return false;
  const actual = Buffer.from(String(password));
  const expected = Buffer.from(PANEL_PASSWORD);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function singleUser() {
  return { id: SINGLE_USER_ID, email: SINGLE_USER_EMAIL };
}

module.exports = { authMode: AUTH_MODE, isSupabaseConfigured, signUp, signIn, isSingleUserConfigured, validateSingleUserAuthentication, authConfig, verifySingleUserPassword, singleUser };
