// Supabase Edge Function: admin-users
// إنشاء المستخدمين وتغيير كلمات المرور وحذف الحسابات من لوحة التحكم.
// يتحقق من أن المستدعي "مدير" قبل أي إجراء، ويستخدم مفتاح service_role
// داخل الخادم فقط (لا يصل إلى المتصفح أبدًا).
//
// النشر:  supabase functions deploy admin-users
// متغير اختياري: supabase secrets set USERNAME_DOMAIN=kawakib.local

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

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
  const domain = Deno.env.get('USERNAME_DOMAIN') || 'kawakib.local';

  // التحقق من هوية المستدعي وصلاحيته
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await asCaller.auth.getUser();
  if (!user) return json({ error: 'يجب تسجيل الدخول' }, 401);
  const { data: isAdmin, error: roleErr } = await asCaller.rpc('is_admin');
  if (roleErr || isAdmin !== true) return json({ error: 'هذا الإجراء للمدير فقط' }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'طلب غير صالح' }, 400); }

  try {
    switch (body.action) {
      case 'create': {
        const username = String(body.username ?? '').trim().toLowerCase();
        const fullName = String(body.full_name ?? '').trim().slice(0, 200) || username;
        const role = body.role === 'admin' ? 'admin' : 'editor';
        if (!USERNAME_RE.test(username)) return json({ error: 'اسم المستخدم غير صالح' }, 400);
        const weak = weakPassword(body.password);
        if (weak) return json({ error: weak }, 400);

        const { data, error } = await admin.auth.admin.createUser({
          email: `${username}@${domain}`,
          password: body.password as string,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (error) {
          const msg = /already|registered|exists/i.test(error.message) ? 'اسم المستخدم مستخدم مسبقًا' : error.message;
          return json({ error: msg }, 400);
        }
        const { error: pErr } = await admin.from('profiles')
          .upsert({ id: data.user.id, username, full_name: fullName, role, is_active: true });
        if (pErr) return json({ error: pErr.message }, 400);
        return json({ ok: true, id: data.user.id });
      }

      case 'reset_password': {
        const id = String(body.user_id ?? '');
        if (!UUID_RE.test(id)) return json({ error: 'معرّف غير صالح' }, 400);
        const weak = weakPassword(body.password);
        if (weak) return json({ error: weak }, 400);
        const { error } = await admin.auth.admin.updateUserById(id, { password: body.password as string });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case 'delete': {
        const id = String(body.user_id ?? '');
        if (!UUID_RE.test(id)) return json({ error: 'معرّف غير صالح' }, 400);
        if (id === user.id) return json({ error: 'لا يمكنك حذف حسابك' }, 400);
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: 'إجراء غير معروف' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
