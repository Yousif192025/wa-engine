# معاينة ترحيل Supabase لجلسة Baileys

## الغرض

يضيف هذا الترحيل **جدولين جديدين فقط** ولا يغير أو يحذف أي جدول موجود للذاكرة أو الرسائل أو قاعدة المعرفة. يخزن جدول `whatsapp_auth_state` حزم اعتماد Baileys المشفرة اللازمة لاستعادة الاتصال بعد إعادة تشغيل العملية. أما `whatsapp_connection_state` فيسجل حالة اتصال غير حساسة لتظهر في `/health` و`/whatsapp/status`، مثل وقت آخر اتصال أو ظهور QR، من دون تخزين QR أو مفاتيح أو رموز جلسة.

قبل الحفظ، سيشفر المحرك كل قيمة اعتماد محليًا بتشفير **AES-256-GCM** باستخدام المتغير الخادمي `BAILEYS_AUTH_ENCRYPTION_KEY`. لذلك لا يحتوي صف Supabase على اعتماد قابل للاستخدام وحده؛ لا يمكن فكّه من دون مفتاح البيئة الذي يبقى خارج المستودع وقاعدة البيانات.

| الجدول | البيانات | الحساسية | الوصول |
| --- | --- | --- | --- |
| `whatsapp_auth_state` | اعتماد Baileys وSignal keys بعد التشفير | عالٍ | مفتاح الخدمة في محرك Node.js فقط؛ RLS بلا سياسات عامة. |
| `whatsapp_connection_state` | الحالة وJID ووقت QR/الاتصال والخطأ المختصر | متوسط | مفتاح الخدمة في محرك Node.js فقط؛ RLS بلا سياسات عامة. |

## SQL المقترح

```sql
-- Baileys auth state, encrypted by wa-engine before database persistence.
create table if not exists public.whatsapp_auth_state (
  account_id text not null default 'default'
    check (account_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  auth_category text not null
    check (auth_category in ('creds', 'keys')),
  auth_key_id text not null
    check (char_length(auth_key_id) between 1 and 500),
  encrypted_value jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (account_id, auth_category, auth_key_id)
);

create table if not exists public.whatsapp_connection_state (
  account_id text primary key default 'default'
    check (account_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connecting', 'qr_pending', 'connected', 'logged_out', 'error')),
  connected_jid text,
  last_qr_at timestamptz,
  last_connected_at timestamptz,
  last_disconnect_at timestamptz,
  last_error text,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists whatsapp_connection_state_status_updated_at_idx
  on public.whatsapp_connection_state (status, updated_at desc);

create or replace trigger whatsapp_auth_state_set_updated_at
before update on public.whatsapp_auth_state
for each row execute function public.set_updated_at();

create or replace trigger whatsapp_connection_state_set_updated_at
before update on public.whatsapp_connection_state
for each row execute function public.set_updated_at();

alter table public.whatsapp_auth_state enable row level security;
alter table public.whatsapp_connection_state enable row level security;
```

## الأثر المتوقع

لا يحتاج الترحيل إلى تعديل Render، ولا يعتمد على قرص محلي، ولا يحتاج إلى نقل بيانات المحادثات القائمة. يحتاج المحرك إلى متغير جديد باسم `BAILEYS_AUTH_ENCRYPTION_KEY` بقيمة base64 تمثل 32 بايت. عند أول تشغيل لا توجد صفوف اعتماد؛ لذلك يظهر QR. بعد المسح تحفظ Baileys الاعتماد المشفر، وعند إعادة تشغيل الخدمة يعيد المحرك تحميله بدل إنشاء QR جديد، ما دامت الجلسة لم تسجل خروجًا من الهاتف.

لا يتضمن هذا الترحيل أي سياسة قراءة عامة. إذا أضيفت لوحة إدارة لاحقًا، فيجب إضافة سياسات RLS ضيقة ومصادقة منفصلة بدل كشف حالة المصادقة للمتصفح.
