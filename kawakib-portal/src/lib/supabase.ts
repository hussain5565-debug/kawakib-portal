import { createClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';

// الجلسة تُحفظ في sessionStorage فتنتهي بإغلاق المتصفح
export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.sessionStorage, storageKey: 'kawakib-session' },
});

export function toEmail(username: string) {
  const u = username.trim().toLowerCase();
  return u.includes('@') ? u : `${u}@${CONFIG.USERNAME_DOMAIN}`;
}
export function toUsername(email: string) {
  const e = (email || '').toLowerCase();
  return e.endsWith('@' + CONFIG.USERNAME_DOMAIN) ? e.slice(0, -(CONFIG.USERNAME_DOMAIN.length + 1)) : e;
}

/* ---------- قفل محاولات الدخول ---------- */
const GUARD = 'kawakib-login-guard';
function guard(): { fails: number; until: number } {
  try { return JSON.parse(localStorage.getItem(GUARD) || '') || { fails: 0, until: 0 }; } catch { return { fails: 0, until: 0 }; }
}
function setGuard(g: { fails: number; until: number }) { try { localStorage.setItem(GUARD, JSON.stringify(g)); } catch { /* ignore */ } }

export async function signIn(username: string, password: string) {
  const g = guard();
  if (g.until > Date.now()) {
    throw new Error(`تم إيقاف الدخول مؤقتًا بسبب محاولات خاطئة متكررة. حاولي بعد ${Math.ceil((g.until - Date.now()) / 60000).toLocaleString('ar-SA')} دقيقة.`);
  }
  if (!username.trim() || !password) throw new Error('أدخلي اسم المستخدم وكلمة المرور.');
  if (!username.includes('@') && !/^[a-zA-Z0-9._-]{2,64}$/.test(username.trim()))
    throw new Error('اسم المستخدم يقبل الحروف الإنجليزية والأرقام والرموز ( . _ - ) فقط.');
  const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
  if (error) {
    const fails = g.fails + 1;
    if (fails >= CONFIG.MAX_LOGIN_ATTEMPTS) {
      setGuard({ fails: 0, until: Date.now() + CONFIG.LOCKOUT_MINUTES * 60000 });
      throw new Error(`تم إيقاف الدخول مؤقتًا لمدة ${CONFIG.LOCKOUT_MINUTES.toLocaleString('ar-SA')} دقيقة بعد محاولات خاطئة متكررة.`);
    }
    setGuard({ fails, until: 0 });
    const msg = /Invalid login credentials/i.test(error.message) ? 'اسم المستخدم أو كلمة المرور غير صحيحة'
      : /Failed to fetch/i.test(error.message) ? 'تعذّر الاتصال بالخادم، تحققي من الإنترنت' : error.message;
    throw new Error(`${msg} (المتبقي ${(CONFIG.MAX_LOGIN_ATTEMPTS - fails).toLocaleString('ar-SA')} محاولات)`);
  }
  setGuard({ fails: 0, until: 0 });
}

export async function signOut() { await sb.auth.signOut().catch(() => {}); }

/* ---------- تسجيل خروج تلقائي عند عدم النشاط ---------- */
let last = Date.now();
let bound = false;
export function watchIdle() {
  if (bound) return;
  bound = true;
  ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, () => { last = Date.now(); }, { passive: true }));
  setInterval(async () => {
    const { data } = await sb.auth.getSession();
    if (data.session && Date.now() - last > CONFIG.IDLE_LOGOUT_MINUTES * 60000) signOut();
  }, 30000);
}
