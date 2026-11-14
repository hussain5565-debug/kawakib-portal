(() => {
'use strict';

/* =========================================================
   لوحة تحكم بوابة الكواكب
   - تسجيل دخول باسم مستخدم وكلمة مرور (Supabase Auth)
   - صلاحيات: admin (مدير) / editor (محرر)
   - إدارة الأعمال والملفات والمسارات والفريق والمستخدمين
   ========================================================= */

const C = window.KAWAKIB_CONFIG || {};
const BUCKET = C.STORAGE_BUCKET || 'attachments';
const MAX_BYTES = (C.MAX_FILE_MB || 50) * 1024 * 1024;
const BLOCKED = new Set((C.BLOCKED_EXTENSIONS || []).map((x) => String(x).toLowerCase()));

const STATUS = { draft: 'مسودة', pending: 'بانتظار الاعتماد', approved: 'معتمد' };
const ROLES = { admin: 'مدير', editor: 'محرر', none: 'بدون صلاحية' };
const CATEGORIES = ['تعلم', 'إدارة', 'رعاية'];
const TABLES = { records: 'الأعمال', attachments: 'الملفات', sections: 'المسارات', team_members: 'الفريق', profiles: 'المستخدمون', settings: 'الإعدادات' };
const ACTIONS = { insert: 'إضافة', update: 'تعديل', delete: 'حذف' };

let sb = null;
let me = null;          // auth user
let profile = null;     // row in profiles
let sections = [];
let currentView = 'overview';

const $ = (s, r = document) => r.querySelector(s);
const isAdmin = () => profile?.role === 'admin';

/* ---------- أدوات DOM آمنة (لا innerHTML لبيانات المستخدم) ---------- */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'type', 'required'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const num = (n) => Number(n || 0).toLocaleString('ar-SA');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
function fmtSize(b) {
  b = Number(b || 0);
  if (b < 1024) return `${num(b)} بايت`;
  if (b < 1048576) return `${num((b / 1024).toFixed(1))} ك.ب`;
  if (b < 1073741824) return `${num((b / 1048576).toFixed(1))} م.ب`;
  return `${num((b / 1073741824).toFixed(2))} ج.ب`;
}
const badge = (cls, text) => h('span', { class: `badge ${cls}`, text });

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3800);
}

function errMsg(e) {
  const m = String(e?.message || e || '');
  if (/Invalid login credentials/i.test(m)) return 'اسم المستخدم أو كلمة المرور غير صحيحة';
  if (/Email not confirmed/i.test(m)) return 'الحساب غير مفعّل بعد';
  if (/row-level security|permission denied|violates row-level/i.test(m)) return 'ليست لديك صلاحية لهذا الإجراء';
  if (/JWT|session/i.test(m)) return 'انتهت الجلسة، الرجاء تسجيل الدخول مجددًا';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'تعذّر الاتصال بالخادم، تحقق من الإنترنت';
  if (/Payload too large|maximum allowed size|exceeded/i.test(m)) return 'حجم الملف أكبر من المسموح';
  if (/duplicate key/i.test(m)) return 'القيمة مسجّلة مسبقًا';
  if (/rate limit/i.test(m)) return 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة';
  if (/[؀-ۿ]/.test(m)) return m;   // رسائل عربية من قاعدة البيانات
  return m ? `حدث خطأ: ${m}` : 'حدث خطأ غير متوقع';
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  return [...b].map((x, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + x.toString(16).padStart(2, '0')).join('');
}

/* ---------- النوافذ ---------- */
function openModal(title, body, actions = []) {
  const dlg = $('#modal');
  const holder = $('#modalBody');
  const close = () => { if (dlg.open) dlg.close(); };
  holder.replaceChildren(h('div', { class: 'modal-inner' },
    h('h2', { text: title }), body,
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null));
  if (!dlg.open) dlg.showModal();
  return close;
}

function confirmBox(text, okLabel = 'تأكيد الحذف') {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.removeEventListener('close', onClose); if (dlg.open) dlg.close(); resolve(v); };
    const onClose = () => finish(false);
    openModal('تأكيد', h('p', { class: 'muted', text }), [
      h('button', { class: 'btn danger', type: 'button', text: okLabel, on: { click: () => finish(true) } }),
      h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => finish(false) } })
    ]);
    dlg.addEventListener('close', onClose);
  });
}

function field(label, input, full = false) {
  return h('label', { class: full ? 'full' : null }, label, input);
}

/* ---------- قفل محاولات الدخول ---------- */
const LOCK_KEY = 'kw_login_guard';
function getGuard() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || { fails: 0, until: 0 }; }
  catch { return { fails: 0, until: 0 }; }
}
function setGuard(g) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(g)); } catch { /* ignore */ } }

function toEmail(u) {
  u = u.trim().toLowerCase();
  return u.includes('@') ? u : `${u}@${C.USERNAME_DOMAIN || 'kawakib.local'}`;
}

async function onLogin(ev) {
  ev.preventDefault();
  const msg = $('#loginMsg');
  const btn = $('#loginBtn');
  msg.textContent = '';
  const g = getGuard();
  if (g.until > Date.now()) {
    const mins = Math.ceil((g.until - Date.now()) / 60000);
    msg.textContent = `تم إيقاف الدخول مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد ${num(mins)} دقيقة.`;
    return;
  }
  const user = $('#loginUser').value;
  const pass = $('#loginPass').value;
  if (!user.trim() || !pass) { msg.textContent = 'أدخل اسم المستخدم وكلمة المرور'; return; }
  if (!user.includes('@') && !/^[a-zA-Z0-9._-]{2,64}$/.test(user.trim())) {
    msg.textContent = 'اسم المستخدم يقبل الحروف الإنجليزية والأرقام والرموز ( . _ - ) فقط';
    return;
  }
  btn.disabled = true; btn.textContent = 'جارٍ التحقق…';
  const { error } = await sb.auth.signInWithPassword({ email: toEmail(user), password: pass });
  btn.disabled = false; btn.textContent = 'دخول';
  if (error) {
    const fails = (g.fails || 0) + 1;
    const max = C.MAX_LOGIN_ATTEMPTS || 5;
    if (fails >= max) {
      setGuard({ fails: 0, until: Date.now() + (C.LOCKOUT_MINUTES || 15) * 60000 });
      msg.textContent = `تم إيقاف الدخول مؤقتًا لمدة ${num(C.LOCKOUT_MINUTES || 15)} دقيقة بعد ${num(max)} محاولات خاطئة.`;
    } else {
      setGuard({ fails, until: 0 });
      msg.textContent = `${errMsg(error)} (المتبقي ${num(max - fails)} محاولات)`;
    }
    $('#loginPass').value = '';
    return;
  }
  setGuard({ fails: 0, until: 0 });
  $('#loginPass').value = '';
  await startSession();
}

async function startSession() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin();
  me = user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error || !data || !data.is_active || !['admin', 'editor'].includes(data.role)) {
    await sb.auth.signOut();
    showLogin('هذا الحساب لا يملك صلاحية الدخول إلى لوحة التحكم. تواصل مع مدير النظام.');
    return;
  }
  profile = data;
  $('#loginScreen').hidden = true;
  $('#adminApp').hidden = false;
  $('#meName').textContent = profile.full_name || profile.username || '';
  $('#meRole').textContent = ROLES[profile.role];
  document.querySelectorAll('[data-admin]').forEach((b) => { b.hidden = !isAdmin(); });
  await loadSections();
  go(location.hash.slice(1) || 'overview');
  startIdleWatch();
}

function showLogin(message = '') {
  me = null; profile = null;
  $('#adminApp').hidden = true;
  $('#loginScreen').hidden = false;
  $('#loginMsg').textContent = message;
  $('#view').replaceChildren();
}

async function logout(reason) {
  await sb.auth.signOut().catch(() => {});
  showLogin(reason || '');
}

/* ---------- تسجيل الخروج التلقائي عند عدم النشاط ---------- */
let lastActive = Date.now();
let idleTimer = null;
let idleBound = false;
function startIdleWatch() {
  const limit = (C.IDLE_LOGOUT_MINUTES || 30) * 60000;
  lastActive = Date.now();
  if (!idleBound) {
    idleBound = true;
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach((ev) =>
      document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
  }
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (profile && Date.now() - lastActive > limit) logout('تم تسجيل الخروج تلقائيًا لعدم النشاط.');
  }, 30000);
}

/* ---------- التنقل ---------- */
const VIEWS = {
  overview: { title: 'الرئيسية', render: viewOverview },
  records: { title: 'سجل الأعمال', render: viewRecords },
  files: { title: 'الملفات والشواهد', render: viewFiles },
  sections: { title: 'مسارات العمل', render: viewSections },
  team: { title: 'فريق المدرسة', render: viewTeam },
  users: { title: 'المستخدمون والصلاحيات', render: viewUsers, admin: true },
  settings: { title: 'الإعدادات', render: viewSettings, admin: true },
  log: { title: 'سجل النشاط', render: viewLog, admin: true },
  account: { title: 'حسابي', render: viewAccount }
};

async function go(name) {
  if (!VIEWS[name] || (VIEWS[name].admin && !isAdmin())) name = 'overview';
  currentView = name;
  history.replaceState(null, '', `#${name}`);
  document.querySelectorAll('#sideNav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#sidebar').classList.remove('open');
  $('#viewTitle').textContent = VIEWS[name].title;
  $('#viewActions').replaceChildren();
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'empty', text: 'جارٍ التحميل…' }));
  try {
    await VIEWS[name].render(view, $('#viewActions'));
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty', text: errMsg(e) }));
  }
}
const refresh = () => go(currentView);

async function loadSections() {
  const { data, error } = await sb.from('sections').select('*').order('sort_order').order('id');
  if (error) throw error;
  sections = data || [];
}
const sectionTitle = (id) => sections.find((s) => s.id === id)?.title || '—';
function sectionSelect(value, withEmpty = 'بدون مسار') {
  return h('select', null,
    h('option', { value: '', text: withEmpty }),
    sections.map((s) => h('option', { value: String(s.id), text: s.title, selected: String(value) === String(s.id) })));
}

function table(headers, rows, emptyText = 'لا توجد بيانات') {
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: emptyText }));
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, headers.map((x) => h('th', { text: x })))),
    h('tbody', null, rows)));
}

/* =========================================================
   الرئيسية
   ========================================================= */
async function viewOverview(view, actions) {
  const count = (q) => q.then((r) => { if (r.error) throw r.error; return r.count || 0; });
  const rec = () => sb.from('records').select('id', { count: 'exact', head: true });
  const [total, approved, pending, drafts, files, team, recent] = await Promise.all([
    count(rec()), count(rec().eq('status', 'approved')), count(rec().eq('status', 'pending')), count(rec().eq('status', 'draft')),
    sb.from('attachments').select('size_bytes').then((r) => { if (r.error) throw r.error; return r.data; }),
    count(sb.from('team_members').select('id', { count: 'exact', head: true })),
    sb.from('records').select('id,title,status,section_id,updated_at').order('updated_at', { ascending: false }).limit(8)
  ]);
  const totalSize = files.reduce((a, f) => a + Number(f.size_bytes || 0), 0);
  actions.append(h('button', { class: 'btn teal', type: 'button', text: '+ عمل جديد', on: { click: () => editRecord() } }));
  const card = (v, l) => h('div', { class: 'card' }, h('strong', { text: v }), h('span', { text: l }));
  view.replaceChildren(
    h('div', { class: 'cards' },
      card(num(total), 'إجمالي الأعمال'), card(num(approved), 'أعمال معتمدة'),
      card(num(pending), 'بانتظار الاعتماد'), card(num(drafts), 'مسودات'),
      card(num(files.length), 'ملفات وشواهد'), card(fmtSize(totalSize), 'حجم الملفات'),
      card(num(sections.length), 'مسارات العمل'), card(num(team), 'أعضاء الفريق')),
    h('div', { class: 'panel' }, h('h2', { text: 'آخر الأعمال المحدّثة' }),
      table(['العنوان', 'المسار', 'الحالة', 'آخر تحديث'],
        (recent.data || []).map((r) => h('tr', null,
          h('td', { text: r.title }), h('td', { text: sectionTitle(r.section_id) }),
          h('td', null, badge(r.status, STATUS[r.status])), h('td', { text: fmtDate(r.updated_at) }))),
        'لا توجد أعمال بعد. ابدأ بإضافة أول عمل.'))
  );
}

/* =========================================================
   سجل الأعمال
   ========================================================= */
const recFilter = { q: '', section: '', status: '' };

async function viewRecords(view, actions) {
  const { data, error } = await sb.from('records').select('*, attachments(count)').order('updated_at', { ascending: false }).limit(2000);
  if (error) throw error;
  const all = data || [];

  actions.append(
    h('button', { class: 'btn light', type: 'button', text: 'تصدير CSV', on: { click: () => exportCsv(all) } }),
    h('button', { class: 'btn teal', type: 'button', text: '+ عمل جديد', on: { click: () => editRecord() } }));

  const q = h('input', { type: 'search', placeholder: 'بحث بالعنوان أو المسؤولة…', value: recFilter.q });
  const sec = sectionSelect(recFilter.section, 'كل المسارات');
  const st = h('select', null, h('option', { value: '', text: 'كل الحالات' }),
    Object.entries(STATUS).map(([k, v]) => h('option', { value: k, text: v, selected: recFilter.status === k })));
  const holder = h('div');

  const draw = () => {
    recFilter.q = q.value.trim(); recFilter.section = sec.value; recFilter.status = st.value;
    const term = recFilter.q.toLowerCase();
    const rows = all.filter((r) =>
      (!term || `${r.title} ${r.owner_name || ''} ${r.description || ''}`.toLowerCase().includes(term)) &&
      (!recFilter.section || String(r.section_id) === recFilter.section) &&
      (!recFilter.status || r.status === recFilter.status));
    holder.replaceChildren(table(['العنوان', 'المسار', 'المسؤولة', 'الموعد', 'الحالة', 'ظاهر للزوار', 'المرفقات', ''],
      rows.map((r) => h('tr', null,
        h('td', { text: r.title }), h('td', { text: sectionTitle(r.section_id) }),
        h('td', { text: r.owner_name || '—' }), h('td', { text: fmtDate(r.target_date) }),
        h('td', null, badge(r.status, STATUS[r.status])),
        h('td', { text: r.is_public && r.status === 'approved' ? 'نعم' : 'لا' }),
        h('td', { text: num(r.attachments?.[0]?.count) }),
        h('td', { class: 'actions' },
          h('button', { class: 'btn light sm', type: 'button', text: 'الملفات', on: { click: () => recordFiles(r) } }),
          h('button', { class: 'btn light sm', type: 'button', text: 'تعديل', on: { click: () => editRecord(r) } }),
          (isAdmin() || r.created_by === me.id) &&
            h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: () => deleteRecord(r) } })))),
      all.length ? 'لا توجد نتائج مطابقة' : 'لا توجد أعمال بعد'));
  };
  [q, sec, st].forEach((x) => x.addEventListener('input', draw));
  view.replaceChildren(h('div', { class: 'toolbar' }, q, sec, st), holder);
  draw();
}

function editRecord(r = null) {
  const title = h('input', { value: r?.title || '', maxlength: 300, required: true });
  const sec = sectionSelect(r?.section_id ?? '');
  const owner = h('input', { value: r?.owner_name || '', maxlength: 200 });
  const date = h('input', { type: 'date', value: r?.target_date || '' });
  const status = h('select', null, Object.entries(STATUS).map(([k, v]) =>
    h('option', { value: k, text: v, selected: (r?.status || 'draft') === k, disabled: k === 'approved' && !isAdmin() && r?.status !== 'approved' })));
  if (!isAdmin() && r?.status === 'approved') status.disabled = true;
  const pub = h('input', { type: 'checkbox', checked: !!r?.is_public, disabled: !isAdmin() });
  const desc = h('textarea', { maxlength: 5000 }, r?.description || '');
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'حفظ' });

  const body = h('div', { class: 'form-grid' },
    field('عنوان العمل *', title, true), field('المسار', sec), field('المسؤولة', owner),
    field('الموعد المستهدف', date), field('الحالة', status),
    field('الوصف والتفاصيل', desc, true),
    h('label', { class: 'check full' }, pub, 'إظهار للزوار في البوابة (يشترط أن يكون معتمدًا)'),
    !isAdmin() ? h('p', { class: 'muted full', text: 'الاعتماد والنشر للزوار من صلاحيات المدير.' }) : null,
    h('div', { class: 'full' }, msg));

  const close = openModal(r ? 'تعديل عمل' : 'عمل جديد', body, [save,
    h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);

  save.addEventListener('click', async () => {
    msg.textContent = '';
    if (!title.value.trim()) { msg.textContent = 'عنوان العمل مطلوب'; return; }
    const payload = {
      title: title.value.trim(),
      section_id: sec.value ? Number(sec.value) : null,
      owner_name: owner.value.trim() || null,
      target_date: date.value || null,
      description: desc.value.trim() || null
    };
    if (!status.disabled && status.value !== r?.status) payload.status = status.value;
    if (!r && !payload.status) payload.status = 'draft';
    if (isAdmin()) payload.is_public = pub.checked;
    save.disabled = true;
    const res = r
      ? await sb.from('records').update(payload).eq('id', r.id).select()
      : await sb.from('records').insert(payload).select();
    save.disabled = false;
    if (res.error) { msg.textContent = errMsg(res.error); return; }
    if (!res.data?.length) { msg.textContent = 'ليست لديك صلاحية لهذا الإجراء'; return; }
    close();
    toast('تم الحفظ');
    if (!r) recordFiles(res.data[0]); else refresh();
  });
}

async function deleteRecord(r) {
  const { data: atts } = await sb.from('attachments').select('storage_path').eq('record_id', r.id);
  const ok = await confirmBox(`سيتم حذف «${r.title}» وجميع ملفاته (${num(atts?.length)}) نهائيًا. لا يمكن التراجع عن هذا الإجراء.`);
  if (!ok) return;
  const { data, error } = await sb.from('records').delete().eq('id', r.id).select('id');
  if (error || !data?.length) return toast(error ? errMsg(error) : 'ليست لديك صلاحية لهذا الإجراء', true);
  if (atts?.length) await sb.storage.from(BUCKET).remove(atts.map((a) => a.storage_path));
  toast('تم الحذف');
  refresh();
}

function exportCsv(rows) {
  const safe = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // منع حقن الصيغ في Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ['العنوان', 'المسار', 'المسؤولة', 'الموعد المستهدف', 'الحالة', 'ظاهر للزوار', 'الوصف', 'تاريخ الإنشاء', 'آخر تحديث'];
  const lines = rows.map((r) => [r.title, sectionTitle(r.section_id), r.owner_name, r.target_date, STATUS[r.status],
    r.is_public ? 'نعم' : 'لا', r.description, r.created_at, r.updated_at].map(safe).join(','));
  const blob = new Blob(['﻿' + [head.map(safe).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `سجل-الأعمال-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================================================
   الملفات
   ========================================================= */
function checkFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!file.name.includes('.') || !/^[a-z0-9]{1,10}$/.test(ext)) return 'امتداد الملف غير صالح';
  if (BLOCKED.has(ext)) return `نوع الملف (.${ext}) غير مسموح لأسباب أمنية`;
  if (file.size > MAX_BYTES) return `حجم الملف يتجاوز ${num(C.MAX_FILE_MB || 50)} م.ب`;
  if (file.size === 0) return 'الملف فارغ';
  return null;
}

async function uploadFile(file, { record_id = null, section_id = null } = {}) {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  const ext = file.name.split('.').pop().toLowerCase();
  const d = new Date();
  const path = `${record_id || 'general'}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}/${uuid()}.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '3600'
  });
  if (up.error) throw up.error;
  const ins = await sb.from('attachments').insert({
    record_id, section_id, storage_path: path,
    file_name: file.name.slice(0, 300), mime_type: file.type || null, size_bytes: file.size
  }).select().single();
  if (ins.error) {
    await sb.storage.from(BUCKET).remove([path]);
    throw ins.error;
  }
  return ins.data;
}

async function uploadMany(files, target, statusEl) {
  let ok = 0;
  const errors = [];
  for (const [i, f] of [...files].entries()) {
    statusEl.textContent = `جارٍ رفع ${num(i + 1)} من ${num(files.length)}: ${f.name}`;
    try { await uploadFile(f, target); ok++; }
    catch (e) { errors.push(`${f.name}: ${errMsg(e)}`); }
  }
  statusEl.textContent = errors.length ? errors.join(' | ') : '';
  if (ok) toast(`تم رفع ${num(ok)} ملف`);
  if (errors.length) toast(`تعذّر رفع ${num(errors.length)} ملف`, true);
  return ok;
}

function dropZone(onFiles) {
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button' },
    'اسحب الملفات هنا أو اضغط للاختيار',
    h('br'), h('small', { text: `كل الأنواع مسموحة عدا الملفات التنفيذية · الحد ${num(C.MAX_FILE_MB || 50)} م.ب للملف` }), input);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); });
  input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
  return zone;
}

async function openFile(att, download) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(att.storage_path, 120, download ? { download: att.file_name } : undefined);
  if (error) return toast(errMsg(error), true);
  const w = window.open(data.signedUrl, '_blank', 'noopener');
  if (!w) location.href = data.signedUrl;
}

async function deleteAttachment(att) {
  const ok = await confirmBox(`حذف الملف «${att.file_name}» نهائيًا؟`);
  if (!ok) return false;
  const { data, error } = await sb.from('attachments').delete().eq('id', att.id).select('id');
  if (error || !data?.length) { toast(error ? errMsg(error) : 'ليست لديك صلاحية لحذف هذا الملف', true); return false; }
  await sb.storage.from(BUCKET).remove([att.storage_path]);
  toast('تم حذف الملف');
  return true;
}

function canDeleteFile(att) { return isAdmin() || att.created_by === me.id; }

async function recordFiles(r) {
  const list = h('ul', { class: 'file-list' });
  const status = h('div', { class: 'form-msg' });
  const load = async () => {
    const { data, error } = await sb.from('attachments').select('*').eq('record_id', r.id).order('created_at');
    if (error) { status.textContent = errMsg(error); return; }
    list.replaceChildren(...(data.length ? data.map((a) => h('li', null,
      h('span', null, a.file_name, h('br'), h('small', { text: `${fmtSize(a.size_bytes)} · ${fmtDate(a.created_at)}` })),
      h('button', { class: 'btn light sm', type: 'button', text: 'عرض', on: { click: () => openFile(a, false) } }),
      h('button', { class: 'btn light sm', type: 'button', text: 'تنزيل', on: { click: () => openFile(a, true) } }),
      canDeleteFile(a) && h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: async () => { await deleteAttachment(a); recordFiles(r); } } })))
      : [h('li', null, h('span', { class: 'muted', text: 'لا توجد ملفات مرفقة بعد' }))]));
  };
  const zone = dropZone(async (files) => { await uploadMany(files, { record_id: r.id, section_id: r.section_id }, status); load(); });
  const close = openModal(`ملفات: ${r.title}`, h('div', null, zone, status, list), [
    h('button', { class: 'btn light', type: 'button', text: 'إغلاق', on: { click: () => { close(); refresh(); } } })]);
  load();
}

async function viewFiles(view, actions) {
  const { data, error } = await sb.from('attachments').select('*, records(title)').order('created_at', { ascending: false }).limit(2000);
  if (error) throw error;
  const all = data || [];
  const total = all.reduce((a, f) => a + Number(f.size_bytes || 0), 0);

  const status = h('div', { class: 'form-msg' });
  const target = sectionSelect('', 'ملف عام (بدون مسار)');
  actions.append(h('span', { class: 'muted', text: `${num(all.length)} ملف · ${fmtSize(total)}` }));

  const q = h('input', { type: 'search', placeholder: 'بحث باسم الملف أو العمل…' });
  const holder = h('div');
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = all.filter((a) => !term || `${a.file_name} ${a.records?.title || ''}`.toLowerCase().includes(term));
    holder.replaceChildren(table(['الملف', 'العمل المرتبط', 'المسار', 'الحجم', 'تاريخ الرفع', ''],
      rows.map((a) => h('tr', null,
        h('td', { text: a.file_name }), h('td', { text: a.records?.title || '—' }),
        h('td', { text: sectionTitle(a.section_id) }), h('td', { text: fmtSize(a.size_bytes) }),
        h('td', { text: fmtDate(a.created_at) }),
        h('td', { class: 'actions' },
          h('button', { class: 'btn light sm', type: 'button', text: 'عرض', on: { click: () => openFile(a, false) } }),
          h('button', { class: 'btn light sm', type: 'button', text: 'تنزيل', on: { click: () => openFile(a, true) } }),
          canDeleteFile(a) && h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: async () => { if (await deleteAttachment(a)) refresh(); } } })))),
      all.length ? 'لا توجد نتائج مطابقة' : 'لا توجد ملفات بعد'));
  };
  q.addEventListener('input', draw);

  view.replaceChildren(
    h('div', { class: 'panel' }, h('h2', { text: 'رفع ملفات' }),
      h('label', null, 'تصنيف الملفات حسب المسار', target),
      h('br'),
      dropZone(async (files) => {
        const n = await uploadMany(files, { section_id: target.value ? Number(target.value) : null }, status);
        if (n) refresh();
      }), status),
    h('div', { class: 'toolbar' }, q), holder);
  draw();
}

/* =========================================================
   مسارات العمل
   ========================================================= */
async function viewSections(view, actions) {
  await loadSections();
  actions.append(h('button', { class: 'btn teal', type: 'button', text: '+ مسار جديد', on: { click: () => editSection() } }));
  view.replaceChildren(table(['الترتيب', 'المسار', 'التصنيف', 'العبارة المختصرة', ''],
    sections.map((s) => h('tr', null,
      h('td', { text: num(s.sort_order) }), h('td', { text: s.title }), h('td', { text: s.category }),
      h('td', { text: s.tagline || '—' }),
      h('td', { class: 'actions' },
        h('button', { class: 'btn light sm', type: 'button', text: 'تعديل', on: { click: () => editSection(s) } }),
        isAdmin() && h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: () => removeRow('sections', s.id, s.title) } })))),
    'لا توجد مسارات'));
}

function editSection(s = null) {
  const title = h('input', { value: s?.title || '', maxlength: 200 });
  const cat = h('select', null, CATEGORIES.map((c) => h('option', { value: c, text: c, selected: (s?.category || 'إدارة') === c })));
  const order = h('input', { type: 'number', value: String(s?.sort_order ?? sections.length + 1), min: '0', max: '9999' });
  const tag = h('input', { value: s?.tagline || '', maxlength: 200 });
  const desc = h('textarea', { maxlength: 1000 }, s?.description || '');
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'حفظ' });
  const close = openModal(s ? 'تعديل مسار' : 'مسار جديد', h('div', { class: 'form-grid' },
    field('اسم المسار *', title, true), field('التصنيف', cat), field('الترتيب', order),
    field('العبارة المختصرة', tag, true), field('الوصف', desc, true), h('div', { class: 'full' }, msg)),
    [save, h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);
  save.addEventListener('click', async () => {
    if (!title.value.trim()) { msg.textContent = 'اسم المسار مطلوب'; return; }
    const payload = { title: title.value.trim(), category: cat.value, sort_order: Number(order.value) || 0,
      tagline: tag.value.trim() || null, description: desc.value.trim() || null };
    save.disabled = true;
    const res = s ? await sb.from('sections').update(payload).eq('id', s.id).select() : await sb.from('sections').insert(payload).select();
    save.disabled = false;
    if (res.error || !res.data?.length) { msg.textContent = res.error ? errMsg(res.error) : 'ليست لديك صلاحية لهذا الإجراء'; return; }
    close(); toast('تم الحفظ'); refresh();
  });
}

async function removeRow(tableName, id, label) {
  const ok = await confirmBox(`حذف «${label}» نهائيًا؟`);
  if (!ok) return;
  const { data, error } = await sb.from(tableName).delete().eq('id', id).select('id');
  if (error || !data?.length) return toast(error ? errMsg(error) : 'ليست لديك صلاحية لهذا الإجراء', true);
  toast('تم الحذف');
  if (tableName === 'sections') await loadSections();
  refresh();
}

/* =========================================================
   فريق المدرسة
   ========================================================= */
async function viewTeam(view, actions) {
  const { data, error } = await sb.from('team_members').select('*').order('sort_order').order('id');
  if (error) throw error;
  actions.append(h('button', { class: 'btn teal', type: 'button', text: '+ إضافة عضو', on: { click: () => editMember(null, data.length) } }));
  view.replaceChildren(
    h('p', { class: 'muted', text: 'الأعضاء الظاهرون يُعرضون في قسم «قيادة المدرسة» بالبوابة.' }),
    table(['الترتيب', 'الاسم', 'المسمى الوظيفي', 'ظاهر للزوار', ''],
      data.map((m) => h('tr', null,
        h('td', { text: num(m.sort_order) }), h('td', { text: m.full_name }), h('td', { text: m.position || '—' }),
        h('td', { text: m.is_public ? 'نعم' : 'لا' }),
        h('td', { class: 'actions' },
          h('button', { class: 'btn light sm', type: 'button', text: 'تعديل', on: { click: () => editMember(m) } }),
          isAdmin() && h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: () => removeRow('team_members', m.id, m.full_name) } })))),
      'لم تتم إضافة أعضاء بعد'));
}

function editMember(m = null, count = 0) {
  const name = h('input', { value: m?.full_name || '', maxlength: 200 });
  const pos = h('input', { value: m?.position || '', maxlength: 200, placeholder: 'مثال: مديرة المدرسة' });
  const order = h('input', { type: 'number', value: String(m?.sort_order ?? count + 1), min: '0', max: '9999' });
  const pub = h('input', { type: 'checkbox', checked: m ? m.is_public : true });
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'حفظ' });
  const close = openModal(m ? 'تعديل عضو' : 'إضافة عضو', h('div', { class: 'form-grid' },
    field('الاسم الكامل *', name, true), field('المسمى الوظيفي', pos), field('الترتيب', order),
    h('label', { class: 'check full' }, pub, 'إظهار في البوابة للزوار'), h('div', { class: 'full' }, msg)),
    [save, h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);
  save.addEventListener('click', async () => {
    if (!name.value.trim()) { msg.textContent = 'الاسم مطلوب'; return; }
    const payload = { full_name: name.value.trim(), position: pos.value.trim() || null, sort_order: Number(order.value) || 0, is_public: pub.checked };
    save.disabled = true;
    const res = m ? await sb.from('team_members').update(payload).eq('id', m.id).select() : await sb.from('team_members').insert(payload).select();
    save.disabled = false;
    if (res.error || !res.data?.length) { msg.textContent = res.error ? errMsg(res.error) : 'ليست لديك صلاحية لهذا الإجراء'; return; }
    close(); toast('تم الحفظ'); refresh();
  });
}

/* =========================================================
   المستخدمون (للمدير)
   ========================================================= */
function strongPassword(p) {
  if (p.length < 10) return 'كلمة المرور يجب ألا تقل عن 10 أحرف';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'كلمة المرور يجب أن تحتوي على حروف وأرقام';
  return null;
}

async function callAdminFn(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let detail = '';
    try { detail = (await error.context.json()).error; } catch { /* ignore */ }
    if (!detail && /Failed to send|not found|404/i.test(error.message || ''))
      detail = 'خدمة إدارة المستخدمين (admin-users) غير منشورة بعد. راجع README، أو أنشئ المستخدم من لوحة Supabase.';
    throw new Error(detail || error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function viewUsers(view, actions) {
  const { data, error } = await sb.from('profiles').select('*').order('created_at');
  if (error) throw error;
  actions.append(h('button', { class: 'btn teal', type: 'button', text: '+ مستخدم جديد', on: { click: createUser } }));
  view.replaceChildren(
    h('p', { class: 'muted', text: 'المدير: صلاحيات كاملة · المحرر: إضافة وتعديل الأعمال والملفات دون الاعتماد أو الحذف الشامل · بدون صلاحية: لا يمكنه الدخول.' }),
    table(['اسم المستخدم', 'الاسم', 'الصلاحية', 'الحالة', 'تاريخ الإنشاء', ''],
      data.map((u) => h('tr', null,
        h('td', { dir: 'ltr', text: u.username || '—' }), h('td', { text: u.full_name || '—' }),
        h('td', null, badge(u.role, ROLES[u.role])), h('td', { text: u.is_active ? 'نشط' : 'معطّل' }),
        h('td', { text: fmtDate(u.created_at) }),
        h('td', { class: 'actions' },
          h('button', { class: 'btn light sm', type: 'button', text: 'تعديل', on: { click: () => editUser(u) } }),
          h('button', { class: 'btn light sm', type: 'button', text: 'كلمة المرور', on: { click: () => resetUserPassword(u) } }),
          u.id !== me.id && h('button', { class: 'btn danger sm', type: 'button', text: 'حذف', on: { click: () => deleteUser(u) } })))),
      'لا يوجد مستخدمون'));
}

function roleSelect(value, self) {
  return h('select', { disabled: self }, Object.entries(ROLES).map(([k, v]) => h('option', { value: k, text: v, selected: value === k })));
}

function editUser(u) {
  const self = u.id === me.id;
  const name = h('input', { value: u.full_name || '', maxlength: 200 });
  const role = roleSelect(u.role, self);
  const active = h('input', { type: 'checkbox', checked: u.is_active, disabled: self });
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'حفظ' });
  const close = openModal(`تعديل المستخدم: ${u.username || ''}`, h('div', { class: 'form-grid' },
    field('الاسم', name, true), field('الصلاحية', role),
    h('label', { class: 'check' }, active, 'الحساب نشط'),
    self ? h('p', { class: 'muted full', text: 'لا يمكنك تغيير صلاحية حسابك أو تعطيله.' }) : null,
    h('div', { class: 'full' }, msg)),
    [save, h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);
  save.addEventListener('click', async () => {
    const payload = { full_name: name.value.trim() || null };
    if (!self) { payload.role = role.value; payload.is_active = active.checked; }
    save.disabled = true;
    const res = await sb.from('profiles').update(payload).eq('id', u.id).select();
    save.disabled = false;
    if (res.error || !res.data?.length) { msg.textContent = res.error ? errMsg(res.error) : 'ليست لديك صلاحية لهذا الإجراء'; return; }
    if (self) { profile = res.data[0]; $('#meName').textContent = profile.full_name || profile.username; }
    close(); toast('تم الحفظ'); refresh();
  });
}

function createUser() {
  const username = h('input', { dir: 'ltr', maxlength: 32, placeholder: 'مثال: teacher1', autocomplete: 'off' });
  const name = h('input', { maxlength: 200 });
  const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'new-password' });
  const role = h('select', null, h('option', { value: 'editor', text: ROLES.editor }), h('option', { value: 'admin', text: ROLES.admin }));
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'إنشاء' });
  const close = openModal('مستخدم جديد', h('div', { class: 'form-grid' },
    field('اسم المستخدم * (إنجليزي)', username), field('الاسم الكامل', name),
    field('كلمة المرور * (10 أحرف على الأقل، حروف وأرقام)', pass), field('الصلاحية', role),
    h('div', { class: 'full' }, msg)),
    [save, h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);
  save.addEventListener('click', async () => {
    msg.textContent = '';
    const u = username.value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) { msg.textContent = 'اسم المستخدم: 3–32 حرفًا إنجليزيًا أو أرقامًا أو ( . _ - )'; return; }
    const weak = strongPassword(pass.value);
    if (weak) { msg.textContent = weak; return; }
    save.disabled = true;
    try {
      await callAdminFn({ action: 'create', username: u, full_name: name.value.trim(), password: pass.value, role: role.value });
      close(); toast('تم إنشاء المستخدم'); refresh();
    } catch (e) { msg.textContent = errMsg(e); }
    save.disabled = false;
  });
}

function resetUserPassword(u) {
  const pass = h('input', { type: 'password', dir: 'ltr', autocomplete: 'new-password' });
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'تعيين' });
  const close = openModal(`تعيين كلمة مرور جديدة: ${u.username || ''}`, h('div', null,
    field('كلمة المرور الجديدة', pass), msg),
    [save, h('button', { class: 'btn light', type: 'button', text: 'إلغاء', on: { click: () => close() } })]);
  save.addEventListener('click', async () => {
    const weak = strongPassword(pass.value);
    if (weak) { msg.textContent = weak; return; }
    save.disabled = true;
    try { await callAdminFn({ action: 'reset_password', user_id: u.id, password: pass.value }); close(); toast('تم تغيير كلمة المرور'); }
    catch (e) { msg.textContent = errMsg(e); }
    save.disabled = false;
  });
}

async function deleteUser(u) {
  const ok = await confirmBox(`حذف حساب «${u.username}» نهائيًا؟ ستبقى الأعمال والملفات التي أنشأها.`);
  if (!ok) return;
  try { await callAdminFn({ action: 'delete', user_id: u.id }); toast('تم حذف المستخدم'); refresh(); }
  catch (e) { toast(errMsg(e), true); }
}

/* =========================================================
   الإعدادات (للمدير)
   ========================================================= */
async function viewSettings(view) {
  const { data, error } = await sb.from('settings').select('*');
  if (error) throw error;
  const map = Object.fromEntries((data || []).map((s) => [s.key, s.value]));
  const year = h('input', { value: map.academic_year || '', maxlength: 60, placeholder: 'اتركه فارغًا ليُحسب تلقائيًا بالتقويم الهجري' });
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'حفظ الإعدادات' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    const { error: e } = await sb.from('settings').upsert({ key: 'academic_year', value: year.value.trim() });
    save.disabled = false;
    if (e) msg.textContent = errMsg(e); else toast('تم الحفظ');
  });
  view.replaceChildren(h('div', { class: 'panel' },
    h('h2', { text: 'إعدادات البوابة' }),
    field('العام الدراسي المعروض في لوحة المتابعة (مثال: ١٤٤٨ - ١٤٤٩ هـ)', year), msg, save));
}

/* =========================================================
   سجل النشاط (للمدير)
   ========================================================= */
async function viewLog(view) {
  const [{ data, error }, users] = await Promise.all([
    sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(300),
    sb.from('profiles').select('id,username,full_name')
  ]);
  if (error) throw error;
  const names = Object.fromEntries((users.data || []).map((u) => [u.id, u.full_name || u.username]));
  const label = (d) => {
    const row = d?.new || d?.old || {};
    return row.title || row.full_name || row.file_name || row.username || row.key || '';
  };
  view.replaceChildren(
    h('p', { class: 'muted', text: 'يُسجَّل كل تعديل تلقائيًا من قاعدة البيانات، ولا يمكن تعديل هذا السجل أو حذفه من الواجهة. (آخر 300 عملية)' }),
    table(['الوقت', 'المستخدم', 'الإجراء', 'القسم', 'العنصر'],
      (data || []).map((l) => h('tr', null,
        h('td', { text: fmtDateTime(l.created_at) }), h('td', { text: l.actor ? (names[l.actor] || 'مستخدم محذوف') : 'النظام' }),
        h('td', { text: ACTIONS[l.action] || l.action }), h('td', { text: TABLES[l.table_name] || l.table_name }),
        h('td', { text: label(l.details) || '—' }))),
      'لا يوجد نشاط مسجّل بعد'));
}

/* =========================================================
   حسابي
   ========================================================= */
function viewAccount(view) {
  const p1 = h('input', { type: 'password', dir: 'ltr', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', dir: 'ltr', autocomplete: 'new-password' });
  const msg = h('div', { class: 'form-msg' });
  const save = h('button', { class: 'btn teal', type: 'button', text: 'تغيير كلمة المرور' });
  save.addEventListener('click', async () => {
    msg.textContent = '';
    const weak = strongPassword(p1.value);
    if (weak) { msg.textContent = weak; return; }
    if (p1.value !== p2.value) { msg.textContent = 'كلمتا المرور غير متطابقتين'; return; }
    save.disabled = true;
    const { error } = await sb.auth.updateUser({ password: p1.value });
    save.disabled = false;
    if (error) { msg.textContent = errMsg(error); return; }
    p1.value = ''; p2.value = '';
    toast('تم تغيير كلمة المرور');
  });
  view.replaceChildren(
    h('div', { class: 'panel' }, h('h2', { text: 'بيانات الحساب' }),
      h('p', null, 'اسم المستخدم: ', h('b', { dir: 'ltr', text: profile.username || '' })),
      h('p', null, 'الاسم: ', h('b', { text: profile.full_name || '—' })),
      h('p', null, 'الصلاحية: ', badge(profile.role, ROLES[profile.role]))),
    h('div', { class: 'panel' }, h('h2', { text: 'تغيير كلمة المرور' }),
      h('div', { class: 'form-grid' }, field('كلمة المرور الجديدة', p1), field('تأكيد كلمة المرور', p2)), msg, save));
}

/* =========================================================
   التشغيل
   ========================================================= */
async function init() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) {
    $('#setupScreen').hidden = false;
    return;
  }
  sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.sessionStorage, storageKey: 'kw_admin_session' }
  });
  $('#loginForm').addEventListener('submit', onLogin);
  $('#logoutBtn').addEventListener('click', () => logout());
  $('#sideToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.querySelectorAll('#sideNav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && profile) showLogin('انتهت الجلسة.'); });

  const { data: { session } } = await sb.auth.getSession();
  if (session) await startSession(); else showLogin();
}

init().catch((e) => { console.error(e); showLogin(errMsg(e)); });
})();
