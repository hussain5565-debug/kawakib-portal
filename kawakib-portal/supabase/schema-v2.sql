-- =====================================================================
--  بوابة الكواكب — الإصدار 10 على Supabase
--  مطابق لجداول النسخة الأصلية: records, files, organization, members, criteria
--  يحذف جداول النسخة التجريبية السابقة (كانت فارغة) ويحتفظ بحساب المدير الحالي.
--  شغّله مرة واحدة كاملًا من SQL Editor.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 0) نقل حساب المدير الحالي ثم إزالة جداول النسخة السابقة
-- ---------------------------------------------------------------------
create table if not exists public.members (
  email       text primary key check (email = lower(email) and char_length(email) between 3 and 254),
  name        text not null check (char_length(name) between 2 and 150),
  role        text not null check (role in ('admin','editor')),
  categories  jsonb not null default '[]'::jsonb,
  active      int  not null default 1 check (active in (0,1)),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if to_regclass('public.profiles') is not null then
    insert into public.members (email, name, role, categories, active)
    select lower(u.email), coalesce(nullif(p.full_name,''), split_part(u.email,'@',1)), 'admin', '[]'::jsonb, 1
    from public.profiles p join auth.users u on u.id = p.id
    where p.role = 'admin' and p.is_active and u.email is not null
    on conflict (email) do update set role = 'admin', active = 1;
  end if;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.attachments cascade;
drop table if exists public.records cascade;
drop table if exists public.team_members cascade;
drop table if exists public.sections cascade;
drop table if exists public.settings cascade;
drop table if exists public.profiles cascade;
drop function if exists public.public_stats() cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.guard_records() cascade;
drop function if exists public.guard_attachments() cascade;
drop function if exists public.guard_profiles() cascade;
drop function if exists public.touch_settings() cascade;
drop function if exists public.is_staff() cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.app_role() cascade;
drop policy if exists kw_files_read   on storage.objects;
drop policy if exists kw_files_insert on storage.objects;
drop policy if exists kw_files_update on storage.objects;
drop policy if exists kw_files_delete on storage.objects;

-- ---------------------------------------------------------------------
-- 1) الجداول (مطابقة للأصل)
-- ---------------------------------------------------------------------
create table if not exists public.organization (
  id          text primary key,
  owner_id    uuid,
  school      jsonb not null default '{}'::jsonb,
  sections    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
insert into public.organization (id) values ('kawakib') on conflict (id) do nothing;

create table if not exists public.criteria (
  id                uuid primary key default gen_random_uuid(),
  reference_version text not null default 'school',
  previous_code     text not null default '',
  applicable        int  not null default 1 check (applicable in (0,1)),
  public_visible    int  not null default 0 check (public_visible in (0,1)),
  domain            text not null check (domain in ('leadership','teaching','outcomes','environment')),
  subdomain         text not null default '' check (char_length(subdomain) <= 200),
  code              text not null check (char_length(code) between 1 and 60),
  title             text not null check (char_length(title) between 3 and 400),
  description       text not null default '' check (char_length(description) <= 6000),
  expected          text not null default '' check (char_length(expected) <= 6000),
  responsible       text not null default '' check (char_length(responsible) <= 150),
  archived          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid default auth.uid(),
  school_id      text not null default 'kawakib',
  category       text not null check (category in ('committees','exams','initiatives','partnerships','development','guidance','kindergarten','madrasati','quality','portfolio','library')),
  unit           text not null default '',
  tool_data      text not null default '' check (char_length(tool_data) <= 30000),
  track          text not null default '' check (char_length(track) <= 200),
  public_visible int  not null default 0 check (public_visible in (0,1)),
  criterion_id   uuid references public.criteria(id) on delete set null,
  title          text not null check (char_length(title) between 2 and 200),
  owner          text not null check (char_length(owner) between 2 and 150),
  date           text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  due            text not null default '' check (due = '' or due ~ '^\d{4}-\d{2}-\d{2}$'),
  stage          text not null check (stage in ('عام','الروضة','الابتدائي','الأول الابتدائي','الثاني الابتدائي','الثالث الابتدائي')),
  status         text not null check (status in ('مسودة','قيد التنفيذ','بانتظار الاعتماد','معتمد')),
  description    text not null default '' check (char_length(description) <= 40000),
  members        text not null default '' check (char_length(members) <= 4000),
  link           text not null default '' check (link = '' or link ~* '^https?://'),
  notes          text not null default '' check (char_length(notes) <= 4000),
  archived       timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists records_category_idx on public.records(category);
create index if not exists records_updated_idx on public.records(updated_at desc);

create table if not exists public.files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),
  record_id   uuid not null references public.records(id) on delete cascade,
  name        text not null check (char_length(name) <= 200),
  type        text not null check (type in ('application/pdf','image/png','image/jpeg','image/webp',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation')),
  size        bigint not null check (size > 0 and size <= 10485760),
  key         text not null unique,
  created_at  timestamptz not null default now()
);
create index if not exists files_record_idx on public.files(record_id);

create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  actor       uuid,
  action      text not null,
  table_name  text not null,
  row_id      text,
  details     jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) دوال الصلاحيات (بديل lib/access.ts)
-- ---------------------------------------------------------------------
create or replace function public.kw_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.members
  where email = lower(coalesce(auth.jwt()->>'email','')) and active = 1
$$;

create or replace function public.kw_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.kw_role() = 'admin', false)
$$;

create or replace function public.kw_can_edit(p_category text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.members m
    where m.email = lower(coalesce(auth.jwt()->>'email','')) and m.active = 1
      and (m.role = 'admin' or (m.role = 'editor' and m.categories ? p_category)))
$$;

create or replace function public.kw_can_read_record(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.records r where r.id = p_id
    and (public.kw_can_edit(r.category) or (r.archived is null and r.status = 'معتمد' and r.public_visible = 1)))
$$;

-- ---------------------------------------------------------------------
-- 3) مشغّلات الحماية (بديل التحقق في مسارات الخادم)
-- ---------------------------------------------------------------------
create or replace function public.kw_guard_records()
returns trigger language plpgsql security definer set search_path = public as $$
declare admin boolean := public.kw_is_admin();
begin
  if auth.uid() is null then
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.user_id := auth.uid(); new.created_at := now(); new.school_id := 'kawakib';
    if not admin and new.status = 'معتمد' then
      raise exception 'اعتماد الأعمال متاح للإدارة؛ أرسلي العمل للمراجعة.';
    end if;
  else
    new.user_id := old.user_id; new.created_at := old.created_at; new.school_id := old.school_id;
    if not admin and new.status = 'معتمد' and old.status is distinct from 'معتمد' then
      raise exception 'اعتماد الأعمال متاح للإدارة؛ أرسلي العمل للمراجعة.';
    end if;
  end if;
  -- الإتاحة للزائر للإدارة فقط وبعد الاعتماد
  if new.status <> 'معتمد' then new.public_visible := 0; end if;
  if not admin and new.public_visible = 1 and (tg_op = 'INSERT' or old.public_visible = 0) then
    new.public_visible := 0;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists records_guard on public.records;
create trigger records_guard before insert or update on public.records
  for each row execute function public.kw_guard_records();

-- رفع مرفق من غير الإدارة يعيد العمل للمراجعة (كما في الأصل)
create or replace function public.kw_after_file()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.kw_is_admin() then
    update public.records set updated_at = now() where id = new.record_id;
  else
    update public.records set updated_at = now(), status = 'بانتظار الاعتماد', public_visible = 0 where id = new.record_id;
  end if;
  return new;
end $$;
create or replace function public.kw_guard_files()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.created_at := now();
  if new.key not like 'kawakib/' || new.record_id::text || '/%' then
    raise exception 'مسار ملف غير صالح';
  end if;
  return new;
end $$;
drop trigger if exists files_guard on public.files;
create trigger files_guard before insert on public.files for each row execute function public.kw_guard_files();
drop trigger if exists files_after on public.files;
create trigger files_after after insert on public.files for each row execute function public.kw_after_file();

create or replace function public.kw_guard_criteria()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.kw_is_admin() then new.public_visible := 0; end if;
  if tg_op = 'UPDATE' then new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists criteria_guard on public.criteria;
create trigger criteria_guard before insert or update on public.criteria
  for each row execute function public.kw_guard_criteria();

create or replace function public.kw_guard_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') and auth.uid() is not null
     and old.email = lower(coalesce(auth.jwt()->>'email','')) then
    if tg_op = 'DELETE' then
      raise exception 'لا يمكنك سحب صلاحية الإدارة عن حسابك أو إيقافه.';
    elsif new.role <> 'admin' or new.active <> 1 then
      raise exception 'لا يمكنك سحب صلاحية الإدارة عن حسابك أو إيقافه.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.email := lower(trim(new.email));
  if new.role = 'admin' then new.categories := '[]'::jsonb; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before insert or update or delete on public.members
  for each row execute function public.kw_guard_members();

create or replace function public.kw_touch()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists organization_touch on public.organization;
create trigger organization_touch before update on public.organization
  for each row execute function public.kw_touch();

-- سجل النشاط
create or replace function public.log_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare rid text; payload jsonb;
begin
  if tg_op = 'DELETE' then payload := jsonb_build_object('old', to_jsonb(old)); rid := to_jsonb(old)->>tg_argv[0];
  elsif tg_op = 'UPDATE' then payload := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)); rid := to_jsonb(new)->>tg_argv[0];
  else payload := jsonb_build_object('new', to_jsonb(new)); rid := to_jsonb(new)->>tg_argv[0]; end if;
  insert into public.activity_log(actor, action, table_name, row_id, details)
  values (auth.uid(), lower(tg_op), tg_table_name, rid, payload);
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['records','files','criteria','organization'] loop
    execute format('drop trigger if exists %I_log on public.%I', t, t);
    execute format('create trigger %I_log after insert or update or delete on public.%I for each row execute function public.log_activity(''id'')', t, t);
  end loop;
  execute 'drop trigger if exists members_log on public.members';
  execute 'create trigger members_log after insert or update or delete on public.members for each row execute function public.log_activity(''email'')';
end $$;

-- ---------------------------------------------------------------------
-- 4) سياسات أمان الصفوف (RLS)
-- ---------------------------------------------------------------------
alter table public.organization enable row level security;
alter table public.members      enable row level security;
alter table public.criteria     enable row level security;
alter table public.records      enable row level security;
alter table public.files        enable row level security;
alter table public.activity_log enable row level security;

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public'
           and tablename in ('organization','members','criteria','records','files','activity_log')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

create policy org_read   on public.organization for select to anon, authenticated using (true);
create policy org_update on public.organization for update to authenticated using (public.kw_is_admin()) with check (public.kw_is_admin());

create policy members_read  on public.members for select to authenticated
  using (public.kw_is_admin() or email = lower(coalesce(auth.jwt()->>'email','')));
create policy members_write on public.members for all to authenticated
  using (public.kw_is_admin()) with check (public.kw_is_admin());

create policy criteria_read on public.criteria for select to anon, authenticated
  using (public.kw_role() is not null or (public_visible = 1 and archived is null));
create policy criteria_insert on public.criteria for insert to authenticated with check (public.kw_can_edit('portfolio'));
create policy criteria_update on public.criteria for update to authenticated
  using (public.kw_can_edit('portfolio')) with check (public.kw_can_edit('portfolio'));

-- السجلات: الزائر يقرأ عبر الدالة kw_records فقط (تحجب الملاحظات)
create policy records_read on public.records for select to authenticated using (public.kw_can_edit(category));
create policy records_insert on public.records for insert to authenticated with check (public.kw_can_edit(category));
create policy records_update on public.records for update to authenticated
  using (public.kw_can_edit(category)) with check (public.kw_can_edit(category));

create policy files_read on public.files for select to anon, authenticated using (public.kw_can_read_record(record_id));
create policy files_insert on public.files for insert to authenticated
  with check (exists (select 1 from public.records r where r.id = record_id and public.kw_can_edit(r.category)));

create policy activity_read on public.activity_log for select to authenticated using (public.kw_is_admin());

revoke all on public.records, public.files, public.members, public.criteria, public.organization, public.activity_log from anon;
grant usage on schema public to anon, authenticated;
grant select on public.organization, public.criteria, public.files to anon;
grant select, insert, update on public.records, public.files, public.criteria, public.members to authenticated;
grant delete on public.members to authenticated;
grant select, update on public.organization to authenticated;
grant select on public.activity_log to authenticated;
revoke insert, update, delete on public.activity_log from authenticated;
grant execute on function public.kw_role(), public.kw_is_admin(), public.kw_can_edit(text), public.kw_can_read_record(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) قراءة الأعمال (بديل GET /api/records)
-- ---------------------------------------------------------------------
create or replace function public.kw_records(p_visitor boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; f jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb) into r from (
    select rec.id, rec.category, rec.unit, rec.tool_data, rec.track, rec.public_visible, rec.criterion_id,
           rec.title, rec.owner, rec.date, rec.due, rec.stage, rec.status, rec.description, rec.members, rec.link,
           case when not p_visitor and public.kw_can_edit(rec.category) then rec.notes else '' end as notes,
           rec.archived, rec.created_at, rec.updated_at
    from public.records rec
    where (not p_visitor and public.kw_can_edit(rec.category))
       or (rec.archived is null and rec.status = 'معتمد' and rec.public_visible = 1)
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('id', fl.id, 'recordId', fl.record_id, 'name', fl.name,
           'type', fl.type, 'size', fl.size::text, 'createdAt', fl.created_at)), '[]'::jsonb) into f
  from public.files fl
  where fl.record_id in (select (e->>'id')::uuid from jsonb_array_elements(r) e);
  return jsonb_build_object('records', r, 'files', f, 'syncedAt', now());
end $$;
revoke all on function public.kw_records(boolean) from public;
grant execute on function public.kw_records(boolean) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) التخزين: حاوية خاصة للمرفقات (حتى ١٠ ميجابايت كما في الأصل)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('school-files', 'school-files', false, 10485760, array[
  'application/pdf','image/png','image/jpeg','image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists kw2_files_read   on storage.objects;
drop policy if exists kw2_files_insert on storage.objects;
drop policy if exists kw2_files_delete on storage.objects;
create policy kw2_files_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'school-files' and exists (
    select 1 from public.files f where f.key = objects.name and public.kw_can_read_record(f.record_id)));
create policy kw2_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'school-files' and (storage.foldername(objects.name))[1] = 'kawakib'
    and exists (select 1 from public.records r
                where r.id::text = (storage.foldername(objects.name))[2] and public.kw_can_edit(r.category)));
-- حذف ملف رُفع ولم يُسجَّل (تنظيف عند فشل الحفظ)
create policy kw2_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'school-files' and owner_id = auth.uid()::text
    and not exists (select 1 from public.files f where f.key = objects.name));

-- ---------------------------------------------------------------------
-- 7) معايير ملف الإنجاز (54 سجلًا من نسخة التسليم الأصلية)
-- ---------------------------------------------------------------------
alter table public.criteria disable trigger criteria_guard;
insert into public.criteria (id, reference_version, previous_code, applicable, public_visible, domain, subdomain, code, title, description, expected, responsible, archived, created_at, updated_at) values
('e7ec2023-0000-4000-8000-000000000001'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التخطيط', '1-1-1-1', 'تصميم الخطة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة تتضمن مسؤوليات ومواعيد، وسجل متابعة يوضح التعديلات ونتائجها.', 'مديرة المدرسة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000002'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التخطيط', '1-1-1-2', 'متابعة الخطة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة تتضمن مسؤوليات ومواعيد، وسجل متابعة يوضح التعديلات ونتائجها.', 'مديرة المدرسة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000003'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'قيادة العملية التعليمية', '1-2-1-1', 'ترسيخ الانتماء', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة البرنامج، توثيق التنفيذ، وقراءة للنتائج تبين ما تغير لدى المستفيدين.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000004'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'قيادة العملية التعليمية', '1-2-1-2', 'أخلاقيات المهنة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة البرنامج، توثيق التنفيذ، وقراءة للنتائج تبين ما تغير لدى المستفيدين.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000005'::uuid, 'general-2026-v2', '1-2-1-3', 1, 1, 'leadership', 'حقوق المتعلم وحمايته', '1-5-1-2', 'الأمان النفسي والاجتماعي', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: توعية بالحقوق وطرق طلب المساندة، إجراءات واضحة للتعامل مع المخاطر، وأنشطة وقائية ونتائج مجمعة لاستطلاع الشعور بالأمان. يُرفق توثيق عام من دون أسماء أو تفاصيل حالات فردية.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000006'::uuid, 'general-2026-v2', '1-2-1-4', 1, 1, 'leadership', 'قيادة العملية التعليمية', '1-2-1-3', 'ضبط المواظبة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة البرنامج، توثيق التنفيذ، وقراءة للنتائج تبين ما تغير لدى المستفيدين.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000007'::uuid, 'general-2026-v2', '1-2-1-5', 1, 1, 'leadership', 'قيادة العملية التعليمية', '1-2-1-4', 'تعزيز الإيجابية', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة البرنامج، توثيق التنفيذ، وقراءة للنتائج تبين ما تغير لدى المستفيدين.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000008'::uuid, 'general-2026-v2', '1-2-1-6', 1, 1, 'leadership', 'قيادة العملية التعليمية', '1-2-1-5', 'رعاية المواهب', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة البرنامج، توثيق التنفيذ، وقراءة للنتائج تبين ما تغير لدى المستفيدين.', 'مديرة المدرسة وفريق العمل', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000009'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'المجتمع المدرسي', '1-3-1-1', 'تعاون الفريق', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة تعاون وأدوار محددة، توثيق المشاركة، واستطلاع أو قياس أثر مناسب.', 'منسقة الشراكة المجتمعية', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000010'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'المجتمع المدرسي', '1-3-1-2', 'مساندة الأسرة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة تعاون وأدوار محددة، توثيق المشاركة، واستطلاع أو قياس أثر مناسب.', 'منسقة الشراكة المجتمعية', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000011'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'المجتمع المدرسي', '1-3-1-3', 'التكامل المجتمعي', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: خطة تعاون وأدوار محددة، توثيق المشاركة، واستطلاع أو قياس أثر مناسب.', 'منسقة الشراكة المجتمعية', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000012'::uuid, 'general-2026-v2', '', 0, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-1', 'جاهزية المعلمين', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع. خاص بالأهلي والعالمي في المرجع؛ خارج احتساب المدرسة الحكومية.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000013'::uuid, 'general-2026-v2', '', 0, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-2', 'جاهزية الإداريين', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع. خاص بالأهلي والعالمي في المرجع؛ خارج احتساب المدرسة الحكومية.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000014'::uuid, 'general-2026-v2', '', 0, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-3', 'استقرار التمويل', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع. خاص بالأهلي والعالمي في المرجع؛ خارج احتساب المدرسة الحكومية.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000015'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-4', 'الترخيص المهني', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000016'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-5', 'تنمية الكفاءات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000017'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-6', 'التشخيص الذاتي', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000018'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'التطوير المؤسسي', '1-4-1-7', 'تنفيذ التحسين', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تشخيص للاحتياج، إجراءات تنفيذية، وسجل مراجعة للتقدم.', 'مديرة المدرسة ومنسقة الجودة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000019'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-1', 'عدالة الفرص', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000020'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-2', 'تفعيل المنهج', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000021'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-3', 'تنويع التدريس', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000022'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-4', 'توظيف التقنية', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000023'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-5', 'التطبيق الحياتي', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000024'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-6', 'تأسيس المهارات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000025'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-7', 'التفكير والبحث والابتكار', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000026'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-8', 'النضج الوجداني', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000027'::uuid, 'retired-2023', '', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-9', 'التمكن الرقمي', 'عنوان مختصر للتنظيم؛ النص الرسمي وتفاصيل التطبيق في المرجع: معايير التقويم والاعتماد المدرسي — هيئة تقويم التعليم والتدريب، 2023.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', '2026-11-13T21:43:23.270Z'::timestamptz, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000028'::uuid, 'general-2026-v2', '2-1-1-10', 1, 1, 'teaching', 'بناء خبرات التعلم', '2-1-1-9', 'تحفيز التعلم', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: تحضير ونماذج أنشطة، ملاحظة صفية، ونماذج أعمال منزوعة البيانات الشخصية توضح التعلم.', 'وكيلة المدرسة والمعلمات', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000029'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'تقويم التعلم', '2-2-1-1', 'تنوع قياس الأداء', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: أدوات قياس، تحليل للإجابات، وخطوات دعم تبين أثر المتابعة.', 'المعلمات ومنسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000030'::uuid, 'general-2026-v2', '2-2-1-2', 1, 1, 'teaching', 'تقويم التعلم', '2-2-1-3', 'استثمار النتائج', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: أدوات قياس، تحليل للإجابات، وخطوات دعم تبين أثر المتابعة.', 'المعلمات ومنسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000031'::uuid, 'general-2026-v2', '2-2-1-3', 1, 1, 'teaching', 'تقويم التعلم', '2-2-1-4', 'إرشاد المتعلم والأسرة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: أدوات قياس، تحليل للإجابات، وخطوات دعم تبين أثر المتابعة.', 'المعلمات ومنسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000032'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-1', 'إتقان القراءة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000033'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-2', 'إتقان الرياضيات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000034'::uuid, 'general-2026-v2', '', 0, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-3', 'إتقان العلوم', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع. القياس الوطني للعلوم خارج الاحتساب افتراضيًا للصفوف الأولية؛ يراجع انطباقه وفق تقرير المدرسة.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000035'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-4', 'تحسن القراءة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000036'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-5', 'تحسن الرياضيات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000037'::uuid, 'general-2026-v2', '', 0, 1, 'outcomes', 'التحصيل التعليمي', '3-1-1-6', 'تحسن العلوم', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع. القياس الوطني للعلوم خارج الاحتساب افتراضيًا للصفوف الأولية؛ يراجع انطباقه وفق تقرير المدرسة.', 'مقترح مدرسي: نتائج الاختبارات الوطنية المعنية، تحليل المقارنة المتاحة، وخطة متابعة مبنية على النتائج.', 'منسقة التحصيل الدراسي', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000038'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-1', 'الاعتزاز الوطني', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000039'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-2', 'تقدير الذات والآخرين', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000040'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-3', 'العادات الصحية', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000041'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-4', 'الإسهام التطوعي', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000042'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-5', 'السلوك المنضبط', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000043'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-6', 'الاستقلال بالتعلم', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000044'::uuid, 'general-2026-v2', '', 1, 1, 'outcomes', 'التطور الشخصي والصحي والاجتماعي', '3-2-1-7', 'احترام الثقافات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: رصد مجمع للسلوك أو المشاركة، توثيق الأنشطة، وشاهد يوضح التغير دون بيانات فردية حساسة.', 'الموجهة الطلابية ورائدة النشاط', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000045'::uuid, 'general-2026-v2', '4-1-1-1', 1, 1, 'environment', 'المبنى المدرسي', '4-1-1-2', 'ملاءمة المساحات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: حصر مرافق وتجهيزات، قائمة تحقق ملائمة للمرحلة، وخطة معالجة موثقة.', 'وكيلة المدرسة ومنسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000046'::uuid, 'general-2026-v2', '4-1-1-2', 1, 1, 'environment', 'المبنى المدرسي', '4-1-1-3', 'تجهيز التعلم', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: حصر مرافق وتجهيزات، قائمة تحقق ملائمة للمرحلة، وخطة معالجة موثقة.', 'وكيلة المدرسة ومنسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000047'::uuid, 'general-2026-v2', '4-1-1-3', 1, 1, 'environment', 'المبنى المدرسي', '4-1-1-4', 'إتاحة الخدمات', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: حصر مرافق وتجهيزات، قائمة تحقق ملائمة للمرحلة، وخطة معالجة موثقة.', 'وكيلة المدرسة ومنسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000048'::uuid, 'general-2026-v2', '', 1, 1, 'environment', 'الأمن والسلامة', '4-2-1-1', 'الوقاية بالمرافق', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: سجل فحص دوري، إجراءات تصحيحية، وشواهد إغلاق الملاحظات.', 'منسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000049'::uuid, 'general-2026-v2', '', 1, 1, 'environment', 'الأمن والسلامة', '4-2-1-2', 'استدامة الصيانة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: سجل فحص دوري، إجراءات تصحيحية، وشواهد إغلاق الملاحظات.', 'منسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000050'::uuid, 'general-2026-v2', '', 1, 1, 'environment', 'الأمن والسلامة', '4-2-1-3', 'العناية بالنظافة', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: سجل فحص دوري، إجراءات تصحيحية، وشواهد إغلاق الملاحظات.', 'منسقة الأمن والسلامة', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000051'::uuid, 'general-2026-v2', '', 1, 1, 'leadership', 'حقوق المتعلم وحمايته', '1-5-1-1', 'حفظ الحقوق والحماية', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: توعية بالحقوق وطرق طلب المساندة، إجراءات واضحة للتعامل مع المخاطر، وأنشطة وقائية ونتائج مجمعة لاستطلاع الشعور بالأمان. يُرفق توثيق عام من دون أسماء أو تفاصيل حالات فردية.', 'مديرة المدرسة والموجهة الطلابية', null, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000052'::uuid, 'retired-2026', '', 1, 1, 'leadership', 'حقوق المتعلم وحمايته', '1-5-1-2', 'توفر المدرسة مناخًا آمنًا للتعلم والنمو نفسيًّا واجتماعيًّا.', 'المعيار الخامس في الإدارة المدرسية وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026، ص11. مرجع الإضافة: نسخة الوثيقة المتاحة عبر Scribd.', 'مقترح مدرسي: توعية بالحقوق وطرق طلب المساندة، إجراءات واضحة للتعامل مع المخاطر، وأنشطة وقائية ونتائج مجمعة لاستطلاع الشعور بالأمان. يُرفق توثيق عام من دون أسماء أو تفاصيل حالات فردية.', 'مديرة المدرسة والموجهة الطلابية', '2026-11-13T21:43:23.270Z'::timestamptz, '2026-11-13T00:00:00.000Z'::timestamptz, '2026-11-13T21:43:23.270Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000053'::uuid, 'general-2026-v2', '', 1, 1, 'teaching', 'تقويم التعلم', '2-2-1-2', 'قياس أهداف المنهج', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: أدوات قياس، تحليل للإجابات، وخطوات دعم تبين أثر المتابعة.', 'المعلمات ومنسقة التحصيل الدراسي', null, '2026-11-14T00:00:00.000Z'::timestamptz, '2026-11-14T00:00:00.000Z'::timestamptz),
('e7ec2023-0000-4000-8000-000000000054'::uuid, 'general-2026-v2', '', 1, 1, 'environment', 'المبنى المدرسي', '4-1-1-1', 'استيفاء اشتراطات المبنى', 'عنوان تنظيمي مختصر وفق وثيقة معايير التقويم والتصنيف والاعتماد المدرسي للتعليم العام — الإصدار الثاني 2026. النص والتفاصيل في صفحات 11–14 من نسخة الوثيقة المتاحة للاطلاع.', 'مقترح مدرسي: حصر مرافق وتجهيزات، قائمة تحقق ملائمة للمرحلة، وخطة معالجة موثقة.', 'وكيلة المدرسة ومنسقة الأمن والسلامة', null, '2026-11-14T00:00:00.000Z'::timestamptz, '2026-11-14T00:00:00.000Z'::timestamptz)
on conflict (id) do nothing;
alter table public.criteria enable trigger criteria_guard;

-- تأكد: يجب أن يظهر 54
select count(*) as criteria_count from public.criteria;
