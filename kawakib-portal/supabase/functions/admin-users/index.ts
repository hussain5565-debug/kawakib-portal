// Supabase Edge Function: admin-users (اختيارية)
// تنشئ حساب الدخول أو تغيّر كلمة مروره من «لوحة التحكم ← الحسابات والصلاحيات».
// تتحقق أن المستدعي «إدارة» في جدول members، وتستخدم مفتاح service_role داخل الخادم فقط.
//
// النشر:  npx supabase functions deploy admin-users

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function weakPassword(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 10 || p.length > 200) return 'كلمة المرور يجب ألا تقل عن 10 أحرف';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'كلمة المرور يجب أن تحتوي على حروف وأرقام';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await asCaller.auth.getUser();
  if (!user) return json({ error: 'يجب تسجيل الدخول' }, 401);
  const { data: isAdmin, error: roleErr } = await asCaller.rpc('kw_is_admin');
  if (roleErr || isAdmin !== true) return json({ error: 'هذا الإجراء للإدارة فقط' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'طلب غير صالح' }, 400); }
  if (body.action !== 'set_password') return json({ error: 'إجراء غير معروف' }, 400);

  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return json({ error: 'اسم المستخدم غير صالح' }, 400);
  const weak = weakPassword(body.password);
  if (weak) return json({ error: weak }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // يُسمح فقط بحسابات مضافة مسبقًا في جدول الصلاحيات
  const { data: member } = await admin.from('members').select('email').eq('email', email).maybeSingle();
  if (!member) return json({ error: 'أضيفي الحساب في جدول الصلاحيات أولًا' }, 400);

  try {
    const created = await admin.auth.admin.createUser({
      email, password: body.password as string, email_confirm: true,
      user_metadata: { full_name: String(body.full_name ?? '').slice(0, 150) },
    });
    if (!created.error) return json({ ok: true, created: true });
    if (!/already|registered|exists/i.test(created.error.message)) return json({ error: created.error.message }, 400);

    // الحساب موجود: نبحث عنه ونحدّث كلمة المرور
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return json({ error: error.message }, 400);
      const found = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
      if (found) {
        const { error: upErr } = await admin.auth.admin.updateUserById(found.id, { password: body.password as string });
        if (upErr) return json({ error: upErr.message }, 400);
        return json({ ok: true, created: false });
      }
      if (data.users.length < 200) break;
    }
    return json({ error: 'تعذر العثور على الحساب' }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
