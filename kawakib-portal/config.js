/*
 * إعدادات الاتصال بقاعدة بيانات Supabase
 * ------------------------------------------------------------
 * انسخ القيمتين من: Supabase Dashboard → Project Settings → API
 *   - SUPABASE_URL      : Project URL
 *   - SUPABASE_ANON_KEY : المفتاح العام (anon / publishable)
 *
 * تنبيه أمني: لا تضع هنا مفتاح service_role أو secret أبدًا؛
 * المفتاح العام آمن لأن الحماية مطبّقة عبر سياسات RLS في قاعدة البيانات.
 */
window.KAWAKIB_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://eierwruyxdteystoxgtz.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpZXJ3cnV5eGR0ZXlzdG94Z3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NzM2MzUsImV4cCI6MjExMDI0OTYzNX0.Qs4Zd6ev3_ZubXuy6ieUSRejEj-YrfKwYdNkAEk32Do',

  // يُكمَل اسم المستخدم بهذا النطاق عند الدخول (مثال: admin ← admin@kawakib.local)
  // يجب أن يطابق النطاق المستخدم عند إنشاء الحسابات في Supabase.
  USERNAME_DOMAIN: 'kawakib.local',

  STORAGE_BUCKET: 'attachments',
  MAX_FILE_MB: 50,                 // الحد الأقصى لحجم الملف الواحد
  IDLE_LOGOUT_MINUTES: 30,         // تسجيل خروج تلقائي بعد عدم النشاط
  MAX_LOGIN_ATTEMPTS: 5,           // محاولات الدخول الخاطئة قبل القفل المؤقت
  LOCKOUT_MINUTES: 15,

  // امتدادات ممنوعة لأسباب أمنية (ملفات تنفيذية وسكربتات)
  BLOCKED_EXTENSIONS: ['exe','msi','bat','cmd','com','scr','ps1','vbs','vbe','js','mjs','jse','wsf','hta','jar','sh','dll','html','htm','xhtml','svg','php','apk']
});
