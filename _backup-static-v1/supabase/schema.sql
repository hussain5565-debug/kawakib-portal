-- =====================================================================
--  بوابة الكواكب — مخطط قاعدة بيانات Supabase
--  شغّل هذا الملف كاملًا مرة واحدة من: Supabase Dashboard → SQL Editor
--  الملف آمن لإعادة التشغيل (idempotent) قدر الإمكان.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) الملفات الشخصية والصلاحيات
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  full_name   text,
  role        text not null default 'none' check (role in ('none','editor','admin')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- إنشاء ملف شخصي تلقائيًا لكل مستخدم جديد (بدون أي صلاحية حتى يمنحها المدير)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    lower(split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- دوال مساعدة للصلاحيات (security definer لتجنّب التكرار داخل سياسات RLS)
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('editor','admin'), false)
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'admin', false)
$$;

-- ---------------------------------------------------------------------
-- 2) جداول المحتوى
-- ---------------------------------------------------------------------
create table if not exists public.sections (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 1000),
  tagline     text check (char_length(tagline) <= 200),
  category    text not null default 'إدارة' check (category in ('تعلم','إدارة','رعاية')),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  id          bigint generated always as identity primary key,
  full_name   text not null check (char_length(full_name) between 1 and 200),
  position    text check (char_length(position) <= 200),
  sort_order  int  not null default 0,
  is_public   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.records (
  id           uuid primary key default gen_random_uuid(),
  section_id   bigint references public.sections(id) on delete set null,
  title        text not null check (char_length(title) between 1 and 300),
  description  text check (char_length(description) <= 5000),
  owner_name   text check (char_length(owner_name) <= 200),
  target_date  date,
  status       text not null default 'draft' check (status in ('draft','pending','approved')),
  is_public    boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists records_section_idx on public.records(section_id);
create index if not exists records_status_idx  on public.records(status);

create table if not exists public.attachments (
  id            uuid primary key default gen_random_uuid(),
  record_id     uuid references public.records(id) on delete cascade,
  section_id    bigint references public.sections(id) on delete set null,
  storage_path  text not null unique,
  file_name     text not null check (char_length(file_name) <= 300),
  mime_type     text,
  size_bytes    bigint not null default 0 check (size_bytes >= 0),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists attachments_record_idx on public.attachments(record_id);

create table if not exists public.settings (
  key         text primary key check (key ~ '^[a-z_]{1,50}$'),
  value       text check (char_length(value) <= 2000),
  updated_at  timestamptz not null default now()
);

create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  actor       uuid,
  action      text not null,
  table_name  text not null,
  row_id      text,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists activity_log_created_idx on public.activity_log(created_at desc);

-- ---------------------------------------------------------------------
-- 3) مشغّلات الحماية
-- ---------------------------------------------------------------------
-- تحديث updated_at + منع غير المدير من الاعتماد أو النشر للعامة
create or replace function public.guard_records()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then          -- تنفيذ من لوحة Supabase / service role
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();      -- منع انتحال صاحب السجل
    if not public.is_admin() and (new.status = 'approved' or new.is_public) then
      raise exception 'الاعتماد والنشر للعامة من صلاحيات المدير فقط';
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
    if not public.is_admin() and (
         (new.status is distinct from old.status and 'approved' in (new.status, old.status))
         or new.is_public is distinct from old.is_public) then
      raise exception 'الاعتماد والنشر للعامة من صلاحيات المدير فقط';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists records_guard on public.records;
create trigger records_guard before insert or update on public.records
  for each row execute function public.guard_records();

create or replace function public.guard_attachments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  return new;
end $$;

drop trigger if exists attachments_guard on public.attachments;
create trigger attachments_guard before insert on public.attachments
  for each row execute function public.guard_attachments();

-- منع المدير من سحب صلاحيته عن نفسه أو تعطيل حسابه (تجنّبًا لفقدان الوصول)
create or replace function public.guard_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  if auth.uid() = old.id and (new.role <> 'admin' or not new.is_active) and old.role = 'admin' then
    raise exception 'لا يمكنك سحب صلاحية المدير عن حسابك أو تعطيله';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profiles();

create or replace function public.touch_settings()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before insert or update on public.settings
  for each row execute function public.touch_settings();

-- سجل النشاط (لا يمكن لأي مستخدم تعديله أو حذفه من الواجهة)
create or replace function public.log_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rid text;
  payload jsonb;
begin
  if tg_op = 'DELETE' then
    payload := jsonb_build_object('old', to_jsonb(old));
    rid := (to_jsonb(old)->>coalesce(nullif(tg_argv[0], ''), 'id'));
  elsif tg_op = 'UPDATE' then
    payload := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
    rid := (to_jsonb(new)->>coalesce(nullif(tg_argv[0], ''), 'id'));
  else
    payload := jsonb_build_object('new', to_jsonb(new));
    rid := (to_jsonb(new)->>coalesce(nullif(tg_argv[0], ''), 'id'));
  end if;
  insert into public.activity_log(actor, action, table_name, row_id, details)
  values (auth.uid(), lower(tg_op), tg_table_name, rid, payload);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['records','attachments','sections','team_members','profiles'] loop
    execute format('drop trigger if exists %I_log on public.%I', t, t);
    execute format('create trigger %I_log after insert or update or delete on public.%I
                    for each row execute function public.log_activity(''id'')', t, t);
  end loop;
  execute 'drop trigger if exists settings_log on public.settings';
  execute 'create trigger settings_log after insert or update or delete on public.settings
           for each row execute function public.log_activity(''key'')';
end $$;

-- ---------------------------------------------------------------------
-- 4) سياسات أمان الصفوف (RLS)
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.sections     enable row level security;
alter table public.team_members enable row level security;
alter table public.records      enable row level security;
alter table public.attachments  enable row level security;
alter table public.settings     enable row level security;
alter table public.activity_log enable row level security;

-- حذف السياسات القديمة لإعادة الإنشاء بأمان
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('profiles','sections','team_members','records','attachments','settings','activity_log')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- profiles: المستخدم يرى ملفه فقط، والمدير يرى ويعدّل الجميع
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- sections: قراءة عامة، تعديل للفريق، حذف للمدير
create policy sections_read   on public.sections for select to anon, authenticated using (true);
create policy sections_insert on public.sections for insert to authenticated with check (public.is_staff());
create policy sections_update on public.sections for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy sections_delete on public.sections for delete to authenticated using (public.is_admin());

-- team_members: العامة يرون الظاهر فقط
create policy team_read   on public.team_members for select to anon, authenticated using (is_public or public.is_staff());
create policy team_insert on public.team_members for insert to authenticated with check (public.is_staff());
create policy team_update on public.team_members for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy team_delete on public.team_members for delete to authenticated using (public.is_admin());

-- records: العامة يرون المعتمد والمنشور فقط
create policy records_read   on public.records for select to anon, authenticated
  using ((is_public and status = 'approved') or public.is_staff());
create policy records_insert on public.records for insert to authenticated with check (public.is_staff());
create policy records_update on public.records for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy records_delete on public.records for delete to authenticated
  using (public.is_admin() or (public.is_staff() and created_by = auth.uid()));

-- attachments: للفريق فقط
create policy attachments_read   on public.attachments for select to authenticated using (public.is_staff());
create policy attachments_insert on public.attachments for insert to authenticated with check (public.is_staff());
create policy attachments_delete on public.attachments for delete to authenticated
  using (public.is_admin() or (public.is_staff() and created_by = auth.uid()));

-- settings: قراءة عامة، تعديل للمدير
create policy settings_read  on public.settings for select to anon, authenticated using (true);
create policy settings_write on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- activity_log: قراءة للمدير فقط، ولا كتابة من الواجهة إطلاقًا
create policy activity_read on public.activity_log for select to authenticated using (public.is_admin());

-- صلاحيات الوصول عبر الـ API (صريحة حتى لو أُوقف خيار Automatically expose new tables)
-- الحماية الفعلية تتم عبر سياسات RLS أعلاه.
grant usage on schema public to anon, authenticated;
grant select on public.sections, public.team_members, public.records, public.settings to anon;
grant select, insert, update, delete on public.sections, public.team_members, public.records,
      public.attachments, public.settings to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.activity_log to authenticated;
grant usage on all sequences in schema public to authenticated;
grant execute on function public.app_role(), public.is_staff(), public.is_admin() to anon, authenticated;

revoke insert, update, delete on public.activity_log from anon, authenticated;
revoke insert, delete on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) إحصاءات عامة مجمّعة (أرقام فقط دون أي تفاصيل)
-- ---------------------------------------------------------------------
create or replace function public.public_stats()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'sections',      (select count(*) from public.sections),
    'records',       (select count(*) from public.records where status <> 'draft'),
    'approved',      (select count(*) from public.records where status = 'approved'),
    'pending',       (select count(*) from public.records where status = 'pending'),
    'attachments',   (select count(*) from public.attachments),
    'by_section',    coalesce((select json_object_agg(section_id, c) from (
                        select section_id, count(*) c from public.records
                        where status <> 'draft' and section_id is not null
                        group by section_id) s), '{}'::json)
  )
$$;
revoke all on function public.public_stats() from public;
grant execute on function public.public_stats() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) التخزين (Storage) — حاوية خاصة لكل أنواع الملفات
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)   -- 50MB لكل ملف
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists kw_files_read   on storage.objects;
drop policy if exists kw_files_insert on storage.objects;
drop policy if exists kw_files_update on storage.objects;
drop policy if exists kw_files_delete on storage.objects;

create policy kw_files_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.is_staff());
create policy kw_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_staff());
create policy kw_files_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and public.is_admin());
create policy kw_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (public.is_admin() or (public.is_staff() and owner_id = auth.uid()::text)));

-- ---------------------------------------------------------------------
-- 7) بيانات هيكلية أولية (مسارات العمل فقط — لا أسماء ولا أرقام)
-- ---------------------------------------------------------------------
insert into public.sections (title, description, tagline, category, sort_order)
select * from (values
  ('اللجان وفرق العمل','التشكيلات والتكليفات والخطط ومحاضر الاجتماعات','من القرار إلى الإنجاز','إدارة',1),
  ('الاختبارات ونواتج التعلم','تنظيم الاختبارات وتحليل النتائج وبرامج نافس','بوصلة إتقان المهارة','تعلم',2),
  ('المبادرات والنشاط','من الفكرة إلى التنفيذ، وصولًا إلى قياس الأثر','رحلة المبادرة إلى الأثر','تعلم',3),
  ('الشراكة المجتمعية','شراكات هادفة مع الأسرة والمجتمع تدعم التعلم وتوثّق الأثر','من الشراكة إلى الأثر','رعاية',4),
  ('التطوير المهني','الدورات والدروس التطبيقية ومجتمعات التعلم','من التدريب إلى الصف','إدارة',5),
  ('التوجيه الطلابي والانضباط','برامج الرعاية وتعزيز القيم والانضباط المدرسي','نبض الانضباط المدرسي','رعاية',6),
  ('ركن الروضة','تعلم باللعب، ونمو واكتشاف في كل يوم','استوديو الخبرة واللعب','تعلم',7),
  ('متابعة منصة مدرستي','الممارسات التدريسية والحصص المتزامنة','جسر إتمام المهام','تعلم',8),
  ('الجودة والتحسين','التقويم الذاتي وخطط التحسين ومؤشرات الأداء','دورة تحسين قصيرة','إدارة',9),
  ('ملف إنجاز المدرسة','ذاكرة المدرسة ومنجزاتها في مكان واحد','عدسة جاهزية الشاهد','إدارة',10),
  ('مكتبة الملفات والنماذج','الخطط والأدلة والتعاميم والنماذج المعتمدة','جواز الوثيقة','إدارة',11)
) v(title, description, tagline, category, sort_order)
where not exists (select 1 from public.sections);

insert into public.settings (key, value) values ('academic_year', '')
on conflict (key) do nothing;

-- =====================================================================
--  بعد إنشاء أول مستخدم من (Authentication → Users → Add user)
--  امنحه صلاحية المدير بتشغيل السطر التالي بعد تعديل اسم المستخدم:
--
--  update public.profiles set role = 'admin', full_name = 'اسم المدير'
--  where username = 'admin';
-- =====================================================================
