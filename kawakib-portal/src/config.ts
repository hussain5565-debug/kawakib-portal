/*
 * إعدادات الاتصال بقاعدة البيانات Supabase
 * المفتاح العام (anon) آمن للنشر لأن الحماية مطبّقة بسياسات RLS داخل قاعدة البيانات.
 * لا تضع مفتاح service_role هنا أبدًا.
 */
export const CONFIG = {
  SUPABASE_URL: 'https://eierwruyxdteystoxgtz.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpZXJ3cnV5eGR0ZXlzdG94Z3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NzM2MzUsImV4cCI6MjExMDI0OTYzNX0.Qs4Zd6ev3_ZubXuy6ieUSRejEj-YrfKwYdNkAEk32Do',
  // يُكمَل اسم المستخدم بهذا النطاق عند الدخول (مثال: nahlaa1448 ← nahlaa1448@kawakib.com)
  USERNAME_DOMAIN: 'kawakib.com',
  BUCKET: 'school-files',
  IDLE_LOGOUT_MINUTES: 30,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 15,
} as const;
