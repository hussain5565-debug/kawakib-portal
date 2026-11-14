(() => {
'use strict';

const C = window.KAWAKIB_CONFIG || {};
const $ = (id) => document.getElementById(id);
const ar = (n) => Number(n || 0).toLocaleString('ar-SA');

// مسارات احتياطية تُعرض فقط إذا لم تكن قاعدة البيانات متصلة بعد
const FALLBACK_SECTIONS = [
  ['اللجان وفرق العمل','التشكيلات والتكليفات والخطط ومحاضر الاجتماعات','من القرار إلى الإنجاز','إدارة'],
  ['الاختبارات ونواتج التعلم','تنظيم الاختبارات وتحليل النتائج وبرامج نافس','بوصلة إتقان المهارة','تعلم'],
  ['المبادرات والنشاط','من الفكرة إلى التنفيذ، وصولًا إلى قياس الأثر','رحلة المبادرة إلى الأثر','تعلم'],
  ['الشراكة المجتمعية','شراكات هادفة مع الأسرة والمجتمع تدعم التعلم وتوثّق الأثر','من الشراكة إلى الأثر','رعاية'],
  ['التطوير المهني','الدورات والدروس التطبيقية ومجتمعات التعلم','من التدريب إلى الصف','إدارة'],
  ['التوجيه الطلابي والانضباط','برامج الرعاية وتعزيز القيم والانضباط المدرسي','نبض الانضباط المدرسي','رعاية'],
  ['ركن الروضة','تعلم باللعب، ونمو واكتشاف في كل يوم','استوديو الخبرة واللعب','تعلم'],
  ['متابعة منصة مدرستي','الممارسات التدريسية والحصص المتزامنة','جسر إتمام المهام','تعلم'],
  ['الجودة والتحسين','التقويم الذاتي وخطط التحسين ومؤشرات الأداء','دورة تحسين قصيرة','إدارة'],
  ['ملف إنجاز المدرسة','ذاكرة المدرسة ومنجزاتها في مكان واحد','عدسة جاهزية الشاهد','إدارة'],
  ['مكتبة الملفات والنماذج','الخطط والأدلة والتعاميم والنماذج المعتمدة','جواز الوثيقة','إدارة']
].map((s, i) => ({ id: null, title: s[0], description: s[1], tagline: s[2], category: s[3], sort_order: i + 1 }));

let sections = FALLBACK_SECTIONS;
let stats = { sections: sections.length, records: 0, approved: 0, pending: 0, attachments: 0, by_section: {} };
let currentFilter = 'all';

// إنشاء عنصر بنص آمن (بدون innerHTML لمنع حقن الشيفرات)
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderSections(filter = currentFilter) {
  currentFilter = filter;
  const grid = $('sectionGrid');
  grid.replaceChildren();
  sections.forEach((s, i) => {
    if (filter !== 'all' && s.category !== filter) return;
    const count = (s.id != null && stats.by_section[s.id]) || 0;
    const card = el('article', 'section-card');
    card.append(
      el('span', 'number', String(i + 1).padStart(2, '0')),
      el('h3', null, s.title),
      el('p', null, s.description || ''),
      el('small', null, `${s.tagline ? s.tagline + ' · ' : ''}${ar(count)} أعمال موثقة`)
    );
    grid.appendChild(card);
  });
}

function renderStats() {
  $('statSections').textContent = ar(stats.sections);
  $('statRecords').textContent = ar(stats.records);
  $('statApproved').textContent = ar(stats.approved);
  $('statAttachments').textContent = ar(stats.attachments);
  $('recordCount').textContent = ar(stats.records);
  $('dashApproved').textContent = ar(stats.approved);
  $('dashPending').textContent = ar(stats.pending);
}

function renderTeam(members) {
  const grid = $('teamGrid');
  grid.replaceChildren();
  members.forEach((m) => {
    const card = el('article');
    card.append(
      el('div', 'avatar', (m.full_name || '').trim().charAt(0)),
      el('small', null, m.position || ''),
      el('h3', null, m.full_name)
    );
    grid.appendChild(card);
  });
}

const STATUS = { approved: 'معتمد', pending: 'بانتظار الاعتماد', draft: 'مسودة' };

function renderPublicRecords(records) {
  const holder = $('publicRecords');
  const empty = $('emptyState');
  holder.replaceChildren();
  if (!records.length) { empty.hidden = false; return; }
  empty.hidden = true;
  const grid = el('div', 'section-grid');
  const byId = Object.fromEntries(sections.map((s) => [s.id, s.title]));
  records.forEach((r) => {
    const card = el('article', 'section-card');
    const date = r.target_date ? new Date(r.target_date).toLocaleDateString('ar-SA') : '';
    card.append(
      el('span', 'number', byId[r.section_id] || ''),
      el('h3', null, r.title),
      el('p', null, r.description || ''),
      el('small', null, [STATUS[r.status], r.owner_name, date].filter(Boolean).join(' · '))
    );
    grid.appendChild(card);
  });
  holder.appendChild(grid);
}

function renderAcademicYear(value) {
  let text = (value || '').trim();
  if (!text) {
    try {
      const y = Number(new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { year: 'numeric' })
        .formatToParts(new Date()).find((p) => p.type === 'year').value);
      const n = (v) => v.toLocaleString('ar-SA', { useGrouping: false });
      text = `${n(y)} - ${n(y + 1)} هـ`;
    } catch { text = ''; }
  }
  $('academicYear').textContent = text ? `العام الدراسي ${text}` : '';
}

async function loadFromSupabase() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) return;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const [sec, st, team, recs, settings] = await Promise.all([
    sb.from('sections').select('id,title,description,tagline,category,sort_order').order('sort_order').order('id'),
    sb.rpc('public_stats'),
    sb.from('team_members').select('full_name,position,sort_order').eq('is_public', true).order('sort_order').order('id'),
    sb.from('records').select('title,description,owner_name,target_date,status,section_id')
      .eq('is_public', true).eq('status', 'approved').order('updated_at', { ascending: false }).limit(12),
    sb.from('settings').select('key,value')
  ]);
  if (!sec.error && sec.data) sections = sec.data;
  if (!st.error && st.data) stats = { ...stats, ...st.data, by_section: st.data.by_section || {} };
  renderSections();
  renderStats();
  if (!team.error && team.data) renderTeam(team.data);
  if (!recs.error && recs.data) renderPublicRecords(recs.data);
  if (!settings.error && settings.data) {
    const map = Object.fromEntries(settings.data.map((s) => [s.key, s.value]));
    renderAcademicYear(map.academic_year);
  }
  [sec, st, team, recs, settings].forEach((r) => r.error && console.warn('Supabase:', r.error.message));
}

// ---------- الواجهة ----------
renderSections();
renderStats();
renderTeam([]);
renderAcademicYear('');

document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  renderSections(b.dataset.filter);
}));
$('menuToggle').addEventListener('click', () => $('nav').classList.toggle('open'));
document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', () => $('nav').classList.remove('open')));
$('printBtn').addEventListener('click', () => window.print());
$('year').textContent = new Date().getFullYear();

loadFromSupabase().catch((e) => console.warn('تعذّر الاتصال بقاعدة البيانات:', e));
})();
