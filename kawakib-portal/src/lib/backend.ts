/*
 * طبقة الربط مع Supabase — بديل مسارات الخادم الأصلية (app/api/*).
 * تحافظ على نفس عناوين الطلبات ونفس الرسائل والتحقق، فتعمل الواجهة الأصلية دون تغيير.
 * الحماية الفعلية مطبّقة أيضًا داخل قاعدة البيانات (RLS + مشغّلات).
 */
import { z } from 'zod';
import { sb, toEmail, toUsername } from './supabase';
import { CONFIG } from '../config';
import { categories, statuses, stages, committeeUnits, defaults } from './school';
import { sectionDefaults, domains, type Viewer } from './sections';
import { parseTool, validateTool, renderToolSummary } from './innovation';

const MSG = {
  AUTH: 'يلزم تسجيل الدخول لحفظ أعمال المدرسة.',
  FORBIDDEN: 'هذا الإجراء متاح للإدارة أو مسؤولة القسم المخولة فقط.',
  FAIL: 'تعذر إتمام العملية. أعد المحاولة، ولم يتم تأكيد الحفظ.',
};
class ApiError extends Error {}
function fail(m: string): never { throw new ApiError(m); }
function dbError(e: any): never {
  const m = String(e?.message || '');
  if (/row-level security|permission denied/i.test(m)) fail(MSG.FORBIDDEN);
  if (/[؀-ۿ]/.test(m)) fail(m);             // رسائل عربية من مشغّلات قاعدة البيانات
  if (/Failed to fetch|NetworkError/i.test(m)) fail('تعذّر الاتصال بالخادم، تحققي من الإنترنت.');
  console.error('School API operation failed', m);
  fail(MSG.FAIL);
  throw e;
}

/* ---------- السياق والصلاحيات (بديل lib/access.ts) ---------- */
type Ctx = { user: { id: string; email: string } | null; role: 'admin' | 'editor' | 'visitor'; allowed: string[]; member: any; viewer: Viewer };
async function context(visitor: boolean): Promise<Ctx> {
  const { data: { session } } = await sb.auth.getSession();
  const user = session?.user ? { id: session.user.id, email: (session.user.email || '').toLowerCase() } : null;
  let member: any = null;
  if (user && !visitor) {
    const { data } = await sb.from('members').select('*').eq('email', user.email).eq('active', 1).maybeSingle();
    member = data;
  }
  const role = visitor || !member ? 'visitor' : member.role === 'admin' ? 'admin' : 'editor';
  const allowed = role === 'admin' ? categories.map((c) => c.id) : role === 'editor' && Array.isArray(member.categories) ? member.categories : [];
  return { user, role, allowed, member, viewer: { role, categories: allowed, signedIn: !!user, name: role === 'visitor' ? 'زائر' : member?.name || 'الإدارة' } };
}
const canEdit = (c: Ctx, category: string) => !!c.user && (c.role === 'admin' || (c.role === 'editor' && c.allowed.includes(category)));
function requireAdmin(c: Ctx) { if (c.role !== 'admin') fail(c.user ? MSG.FORBIDDEN : MSG.AUTH); }

/* ---------- تحويل الأسماء بين قاعدة البيانات والواجهة ---------- */
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
function fromRow(r: any) { const o: any = {}; for (const [k, v] of Object.entries(r || {})) o[camel(k)] = v; return o; }
function toRow(r: any) { const o: any = {}; for (const [k, v] of Object.entries(r || {})) o[snake(k)] = v; return o; }

async function org() {
  const { data, error } = await sb.from('organization').select('*').eq('id', 'kawakib').maybeSingle();
  if (error) dbError(error);
  return data;
}

/* ---------- /api/records ---------- */
const recordSchema = z.object({
  toolData: z.string().max(30000).default(''), track: z.string().max(200).default(''),
  unit: z.string().refine((v) => v === '' || committeeUnits.includes(v)).default(''),
  criterionId: z.string().uuid().or(z.literal('')).nullable().optional(),
  publicVisible: z.number().int().min(0).max(1).default(0),
  category: z.string().refine((v) => categories.some((c) => c.id === v)),
  title: z.string().trim().min(2).max(200), owner: z.string().trim().min(2).max(150),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), due: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/),
  stage: z.string().refine((v) => stages.includes(v)), status: z.string().refine((v) => statuses.includes(v)),
  description: z.string().max(40000), members: z.string().max(4000),
  link: z.string().max(2000).refine((v) => !v || /^https?:\/\//i.test(v)), notes: z.string().max(4000),
});

async function getRecords(visitor: boolean) {
  const { data, error } = await sb.rpc('kw_records', { p_visitor: visitor });
  if (error) dbError(error);
  return { records: (data.records || []).map(fromRow), files: data.files || [], syncedAt: data.syncedAt };
}

async function saveRecord(payload: any, edit: boolean) {
  const c = await context(false);
  const parsed = recordSchema.safeParse(payload);
  if (!parsed.success) fail('تحققي من العنوان والمسؤولة والتاريخ والرابط وبقية الحقول.');
  const p = parsed.data!;
  const toolErrors = validateTool(p.category, p.toolData);
  if (toolErrors.length) fail(toolErrors[0]);
  const tool = parseTool(p.toolData);
  let sourceTitle = '';
  if (tool?.values.sourceId) {
    if (payload.id === tool.values.sourceId) fail('لا يمكن ربط البطاقة بنفسها.');
    const all = await getRecords(false);
    const source = all.records.find((r: any) => r.id === String(tool.values.sourceId));
    if (!source) fail('السجل المرجعي غير متاح لهذا الحساب.');
    sourceTitle = source.title;
    if (p.category === 'library' && source.category !== 'library') fail('الإصدار السابق يختار من المكتبة.');
  }
  if (!canEdit(c, p.category)) fail(c.user ? MSG.FORBIDDEN : MSG.AUTH);
  if (c.role !== 'admin' && p.status === 'معتمد') fail('اعتماد الأعمال متاح للإدارة؛ أرسلي العمل للمراجعة.');
  const data: any = {
    ...p,
    description: tool ? renderToolSummary(tool) + (sourceTitle ? '\n\nالسجل المرجعي: ' + sourceTitle : '') : p.description,
    criterionId: p.criterionId || null,
    publicVisible: c.role === 'admin' && p.status === 'معتمد' ? p.publicVisible : 0,
  };
  if (data.criterionId) {
    const { data: cr } = await sb.from('criteria').select('id').eq('id', data.criterionId).maybeSingle();
    if (!cr) fail('المعيار المرتبط غير موجود.');
  }
  if (edit) {
    const id = z.string().uuid().safeParse(payload.id);
    if (!id.success) fail('سجل غير صالح.');
    const { data: old, error } = await sb.from('records').select('*').eq('id', id.data!).maybeSingle();
    if (error) dbError(error);
    if (!old) fail('السجل غير موجود.');
    if (!canEdit(c, old.category)) fail(MSG.FORBIDDEN);
    if (payload.updatedAt && old.updated_at !== payload.updatedAt) fail('عُدّل السجل من حساب آخر. أغلقيه وأعيدي فتحه قبل الحفظ.');
    const res = await sb.from('records').update(toRow(data)).eq('id', id.data!).eq('updated_at', old.updated_at).select();
    if (res.error) dbError(res.error);
    if (!res.data?.length) fail('تغيّر السجل أثناء الحفظ؛ أعيدي فتحه.');
    return { record: fromRow(res.data![0]) };
  }
  const res = await sb.from('records').insert(toRow(data)).select().single();
  if (res.error) dbError(res.error);
  return { record: fromRow(res.data) };
}

async function archiveRecord(payload: any) {
  const c = await context(false);
  const p = z.object({ id: z.string().uuid(), archived: z.boolean() }).safeParse(payload);
  if (!p.success) fail('طلب غير صالح.');
  const { data: r } = await sb.from('records').select('id,category').eq('id', p.data!.id).maybeSingle();
  if (!r) fail(c.user ? 'السجل غير موجود.' : MSG.AUTH);
  if (!canEdit(c, r.category)) fail(c.user ? MSG.FORBIDDEN : MSG.AUTH);
  const res = await sb.from('records').update({ archived: p.data!.archived ? new Date().toISOString() : null }).eq('id', r.id).select('id');
  if (res.error) dbError(res.error);
  return { ok: true };
}

/* ---------- /api/files ---------- */
const fileTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'];

async function uploadFile(form: FormData) {
  const c = await context(false);
  if (!c.user) fail(MSG.AUTH);
  const file = form.get('file'), recordId = String(form.get('recordId') || '');
  if (!(file instanceof File) || !fileTypes.includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size)
    fail('ارفع ملف PDF أو صورة أو ملف Office بحد أقصى ١٠ ميجابايت.');
  const { data: r } = await sb.from('records').select('id,category').eq('id', recordId).maybeSingle();
  if (!r) fail('السجل غير موجود.');
  if (!canEdit(c, r.category)) fail(MSG.FORBIDDEN);
  const f = file as File;
  const id = crypto.randomUUID(), key = `kawakib/${recordId}/${id}`;
  const up = await sb.storage.from(CONFIG.BUCKET).upload(key, f, { contentType: f.type, upsert: false });
  if (up.error) dbError(up.error);
  const ins = await sb.from('files').insert({ id, key, record_id: recordId, name: f.name.slice(0, 200), type: f.type, size: f.size });
  if (ins.error) { await sb.storage.from(CONFIG.BUCKET).remove([key]); dbError(ins.error); }
  return { ok: true };
}

/** تنزيل مرفق برابط موقّع قصير الصلاحية (بديل GET /api/files?id=) */
export async function openFile(id: string) {
  const { data: f } = await sb.from('files').select('key,name').eq('id', id).maybeSingle();
  if (!f) throw new Error('الملف غير متاح للعرض.');
  const { data, error } = await sb.storage.from(CONFIG.BUCKET).createSignedUrl(f.key, 120, { download: f.name });
  if (error || !data) throw new Error('تعذر العثور على المرفق.');
  window.location.assign(data.signedUrl);
}

/* ---------- /api/config و /api/settings ---------- */
const planSchema = z.object({
  vision: z.string().max(3000), mission: z.string().max(3000), goals: z.string().max(6000), objectives: z.string().max(6000),
  leadRole: z.string().max(150), leadName: z.string().max(150), supervisorRole: z.string().max(150), supervisorName: z.string().max(150),
  annualTarget: z.number().int().min(0).max(10000),
});
const plansOf = (o: any) => ({ ...sectionDefaults(), ...(o?.sections || {}) });
const schoolOf = (o: any) => ({ ...defaults, ...(o?.school || {}) });

async function getConfig(visitor: boolean) {
  const [c, o] = await Promise.all([context(visitor), org()]);
  return { school: schoolOf(o), sections: plansOf(o), viewer: c.viewer, syncedAt: new Date().toISOString() };
}
async function savePlan(payload: any) {
  const c = await context(false); requireAdmin(c);
  const p = z.object({ key: z.string().refine((k) => k in sectionDefaults()), plan: planSchema }).safeParse(payload);
  if (!p.success) fail('تحققي من بيانات القسم والمسؤوليات.');
  const sections = plansOf(await org());
  sections[p.data!.key] = p.data!.plan;
  const res = await sb.from('organization').update({ sections }).eq('id', 'kawakib').select('id');
  if (res.error) dbError(res.error);
  if (!res.data?.length) fail(MSG.FORBIDDEN);
  return { ok: true };
}
async function saveSettings(payload: any) {
  const c = await context(false); requireAdmin(c);
  const shape = Object.fromEntries(Object.keys(defaults).map((k) => [k, z.string().max(3000)]));
  const p = z.object(shape).safeParse(payload);
  if (!p.success || !String(p.data.name || '').trim()) fail('تحققي من بيانات المدرسة.');
  const res = await sb.from('organization').update({ school: p.data }).eq('id', 'kawakib').select('id');
  if (res.error) dbError(res.error);
  if (!res.data?.length) fail(MSG.FORBIDDEN);
  return { ok: true };
}

/* ---------- /api/criteria ---------- */
const criterionSchema = z.object({
  applicable: z.number().int().min(0).max(1).default(1), publicVisible: z.number().int().min(0).max(1).default(0),
  id: z.string().uuid().optional(), domain: z.string().refine((v) => domains.some((d) => d.id === v)),
  subdomain: z.string().max(200), code: z.string().trim().min(1).max(60), title: z.string().trim().min(3).max(400),
  description: z.string().max(6000), expected: z.string().max(6000), responsible: z.string().max(150),
  archived: z.string().nullable().optional(),
});
async function getCriteria(visitor: boolean) {
  const c = await context(visitor);
  const { data, error } = await sb.from('criteria').select('*').order('created_at', { ascending: false });
  if (error) dbError(error);
  return { criteria: (data || []).map(fromRow).filter((r: any) => c.role !== 'visitor' || (r.publicVisible === 1 && !r.archived)) };
}
async function saveCriterion(payload: any) {
  const c = await context(false);
  if (!canEdit(c, 'portfolio')) fail(c.user ? MSG.FORBIDDEN : MSG.AUTH);
  const p = criterionSchema.safeParse(payload);
  if (!p.success) fail('تحققي من المجال ورمز المعيار وعنوانه.');
  const { id, ...fields } = p.data!;
  fields.publicVisible = c.role === 'admin' ? fields.publicVisible : 0;
  const res = id
    ? await sb.from('criteria').update(toRow(fields)).eq('id', id).select('id')
    : await sb.from('criteria').insert(toRow(fields)).select('id');
  if (res.error) dbError(res.error);
  if (!res.data?.length) fail(MSG.FORBIDDEN);
  return { ok: true };
}

/* ---------- /api/access (الحسابات والصلاحيات) ---------- */
async function getMembers() {
  const c = await context(false); requireAdmin(c);
  const { data, error } = await sb.from('members').select('*').order('updated_at', { ascending: false });
  if (error) dbError(error);
  // تُعرض الأقسام كنص JSON كما تتوقعه الواجهة الأصلية، والبريد كاسم مستخدم
  return { members: (data || []).map((m: any) => ({ ...m, email: toUsername(m.email), categories: JSON.stringify(m.categories || []) })) };
}
async function saveMember(payload: any) {
  const c = await context(false); requireAdmin(c);
  const p = z.object({
    email: z.string().trim().min(2).max(254), name: z.string().trim().min(2).max(150),
    role: z.enum(['admin', 'editor']),
    categories: z.array(z.string().refine((s) => categories.some((x) => x.id === s))).max(categories.length),
    active: z.number().int().min(0).max(1), password: z.string().max(200).optional(),
  }).safeParse(payload);
  if (!p.success) fail('تحققي من اسم المستخدم والاسم والأقسام المسموح بها.');
  const { password, ...m } = p.data!;
  if (!m.email.includes('@') && !/^[a-z0-9._-]{3,32}$/i.test(m.email)) fail('اسم المستخدم: ٣–٣٢ حرفًا إنجليزيًا أو أرقامًا أو ( . _ - ).');
  const email = toEmail(m.email);
  const res = await sb.from('members').upsert({ ...m, email, categories: m.role === 'admin' ? [] : m.categories });
  if (res.error) dbError(res.error);
  if (password) {
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      fail('حُفظت الصلاحيات، لكن كلمة المرور يجب ألا تقل عن ١٠ أحرف وتحتوي حروفًا إنجليزية وأرقامًا.');
    const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'set_password', email, password, full_name: m.name } });
    if (error || data?.error) {
      fail('حُفظت الصلاحيات، وتعذر تعيين كلمة المرور: ' + (data?.error || 'خدمة إنشاء الحسابات غير منشورة؛ أنشئي الحساب من لوحة Supabase بنفس اسم المستخدم.'));
    }
  }
  return { ok: true };
}

/* ---------- الموجّه: نفس عناوين الواجهة الأصلية ---------- */
export async function api(url: string, options?: RequestInit): Promise<any> {
  const u = new URL(url, window.location.origin);
  const visitor = u.searchParams.get('visitor') === '1';
  const method = (options?.method || 'GET').toUpperCase();
  const body = () => { try { return JSON.parse(String(options?.body || '{}')); } catch { return fail('طلب غير صالح.'); } };
  try {
    switch (`${method} ${u.pathname}`) {
      case 'GET /api/records': return await getRecords(visitor || !(await sb.auth.getSession()).data.session);
      case 'POST /api/records': return await saveRecord(body(), false);
      case 'PUT /api/records': return await saveRecord(body(), true);
      case 'PATCH /api/records': return await archiveRecord(body());
      case 'POST /api/files': return await uploadFile(options!.body as FormData);
      case 'GET /api/config': return await getConfig(visitor);
      case 'PUT /api/config': return await savePlan(body());
      case 'GET /api/criteria': return await getCriteria(visitor);
      case 'POST /api/criteria': return await saveCriterion(body());
      case 'GET /api/settings': return { settings: schoolOf(await org()) };
      case 'PUT /api/settings': return await saveSettings(body());
      case 'GET /api/access': return await getMembers();
      case 'POST /api/access': return await saveMember(body());
      default: return fail('طلب غير معروف.');
    }
  } catch (e) {
    if (e instanceof ApiError) throw new Error(e.message);
    if (e instanceof Error && /[؀-ۿ]/.test(e.message)) throw e;
    console.error(e);
    throw new Error(MSG.FAIL);
  }
}
