# محرك دعم WhatsApp عبر Baileys

## الغرض والبنية

يبقى تطبيق Next.js القائم منفصلًا كما هو، بينما يشغّل `src/engine` عملية Node.js مستقلة تتصل مباشرةً بـ WhatsApp Web عبر Baileys. تستقبل العملية الرسالة، تحفظ الذاكرة وقاعدة المعرفة في Supabase، ثم تستخدم Gemini 2.5 Flash لإعداد الرد، وتحفظه وتعيده في المحادثة نفسها. لا يحتاج هذا المسار إلى Wassenger أو Vercel Relay أو واجهة WhatsApp مدفوعة.

> Baileys مكتبة مجتمع تتصل عبر WebSocket بواجهة WhatsApp Web، وليست واجهة WhatsApp Business الرسمية. استخدمها بشكل مسؤول ووفق سياسات WhatsApp؛ وثائقها نفسها تحذر من الممارسات المخالفة للشروط أو الإرسال المزعج. [1]

```text
WhatsApp
  -> Baileys WebSocket
  -> wa-engine
     -> Supabase: auth state + memory + knowledge base
     -> Gemini 2.5 Flash
  -> Baileys reply
```

| المكوّن | المسؤولية |
| --- | --- |
| `src/engine/baileys-client.ts` | الاتصال، QR محلي، إعادة الاتصال، الإرسال، حالة الكتابة، ومنع `fromMe` loops. |
| `src/engine/supabase-auth-state.ts` | تحميل وحفظ `creds` وSignal keys بعد تشفيرها. |
| `src/engine/auth-crypto.ts` | تشفير وفك تشفير AES-256-GCM محليًا. |
| `src/engine/baileys-session-repository.ts` | الوصول الخادمي فقط إلى جدولي session الجديدين. |
| `src/engine/processor.ts` | تطبيع الرسائل، منع التكرار، اللغة، الذاكرة، Gemini، وحفظ الرسائل. |
| `src/engine/documents.ts` | تنزيل PDF وDOC وDOCX والتحقق من التوقيع والحجم واستخراج النص. |
| `src/engine/server.ts` | `GET /health` و`GET /whatsapp/status` فقط؛ لا توجد نقطة webhook للإرسال. |

## المتطلبات والإعداد المحلي

يتطلب المحرك Node.js من 20 إلى أقل من 23، وقد ثُبِّت هذا النطاق في `package.json`. يتطلب Baileys Node.js 20 أو أحدث. [1] انسخ ملف البيئة ولا تضع ملف `.env` أو أي قيم فعلية في Git.

```bash
cp .env.example .env
pnpm install
pnpm run bot:build
pnpm run bot:start
```

يتطلب `BAILEYS_AUTH_ENCRYPTION_KEY` قيمة base64 تمثل 32 بايت. أنشئها محليًا مرة واحدة، وخزّنها في مدير أسرار بيئة النشر نفسه؛ تغييرها بعد ربط الحساب يجعل حالة المصادقة المحفوظة غير قابلة للقراءة، وعندها يجب مسح حالة الجلسة وإعادة مسح QR.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| المتغير | مطلوب | الاستخدام |
| --- | --- | --- |
| `GEMINI_API_KEY` | نعم | مفتاح Gemini الخادمي فقط. |
| `GEMINI_MODEL` | نعم | الافتراضي `gemini-2.5-flash`. |
| `SUPABASE_URL` | نعم | عنوان مشروع Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | نعم | مفتاح خادمي فقط؛ لا يوضع في متغير `NEXT_PUBLIC_*`. |
| `BAILEYS_AUTH_ENCRYPTION_KEY` | نعم | مفتاح base64 بطول 32 بايت لتشفير الاعتماد قبل Supabase. |
| `BAILEYS_ACCOUNT_ID` | لا | معرّف حساب معزول؛ الافتراضي `default`. |
| `BAILEYS_RECONNECT_DELAY_MS` | لا | تأخير إعادة الاتصال الآمن؛ الافتراضي 5000. |
| `ENABLE_GROUP_REPLY` | لا | اتركه `false` لمنع الردود في المجموعات افتراضيًا. |
| `MAX_FILE_SIZE` | لا | حد الملف بالبايت؛ الافتراضي 8 MiB. |

## Supabase وحالة الجلسة

طبّق الترحيلات بالترتيب في محرر SQL أو CLI الخاص بـ Supabase. الترحيل الثاني هو الترحيل المعتمد للجلسة؛ يضيف فقط `whatsapp_auth_state` و`whatsapp_connection_state` ولا يغير أي جدول قائم.

```text
supabase/migrations/20260815_001_bot_engine.sql
supabase/migrations/20260815_002_baileys_session_state.sql
```

يخزن التطبيق `creds` وSignal keys بعد تشفير AES-256-GCM محليًا. لا يُخزن مفتاح التشفير في Supabase أو Git، ولا يُسجل في السجلات. تُفعّل RLS على الجدولين الجديدين ولا تنشأ أي سياسة عامة؛ لذا لا تصل متصفحات المستخدمين العاديين إليهما. مفتاح الخدمة داخل عملية المحرك وحده هو القادر على الوصول. يمكن التراجع يدويًا، إذا اقتضى الأمر، عبر `supabase/rollbacks/20260815_002_baileys_session_state.down.sql`؛ يحذف هذا الملف حالة Baileys الجديدة فقط ولا يلمس الذاكرة أو قاعدة المعرفة الحالية.

## QR والاتصال واستعادة الجلسة

في أول تشغيل لا يجد المحرك اعتمادًا محفوظًا؛ لذلك يسجل `whatsapp_qr_generated` ويطبع QR في طرفية تشغيل المحرك. امسحه من الهاتف عبر **WhatsApp > الأجهزة المرتبطة > ربط جهاز**. عند نجاح الربط يسجل `whatsapp_connected`، وتحفظ Baileys أي تغيير في `creds` وSignal keys إلى Supabase بشكل مشفر. في إعادة التشغيل التالية يحمل المحرك الحالة نفسها ولا يحتاج QR جديدًا ما لم تسجل خروج الحساب أو تلغِ الأجهزة المرتبطة أو تغير مفتاح التشفير.

عند انقطاع الاتصال غير النهائي يحفظ المحرك حالة `disconnected` ويحاول إعادة الاتصال بعد التأخير المكوّن. عند `loggedOut` يمسح الاعتماد المشفر حتى لا يحاول استعادته، ثم ينتظر QR جديدًا. لا تسجل السجلات محتوى الاعتماد أو QR أو مفاتيح API.

## الرسائل والملفات والأمان

يتجاهل المحرك الرسائل المرسلة من الحساب نفسه و`status@broadcast` افتراضيًا، ويمنع ردود المجموعات ما لم تضبط `ENABLE_GROUP_REPLY=true`. يستعمل `message.key.id` لمنع تكرار الحدث في `webhook_events` الموجود، ويحفظ هوية المحادثة بالـ JID ذاته لتبقى ذاكرة العميل مستقلة. يستعمل Gemini تاريخ المحادثة وقاعدة المعرفة كسياق غير موثوق، ولا يطيع تعليمات مضمنة في رسالة أو مستند تحاول تغيير الدور أو كشف الأسرار.

تقبل معالجة الملفات PDF وDOC وDOCX فقط. يُفحَص الحجم قبل التنزيل وبعده، ثم يتحقق المحرك من توقيع PDF أو DOC/OLE أو DOCX/ZIP قبل الاستخراج. لا ينفذ محتوى الملفات؛ وتعالج النصوص المستخرجة كسياق غير موثوق. يحذف مسار DOC الملف المؤقت دائمًا.

## فحوص الصحة والاختبارات

```bash
pnpm run bot:typecheck
pnpm test
pnpm run bot:build
pnpm run bot:start
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:8080/whatsapp/status
```

يعني `GET /health` أن عملية HTTP تعمل. ويعرض الحقل `whatsapp.connected` ما إذا كان WebSocket متصلًا؛ لا تعني صحة HTTP وحدها أن الحساب مرتبط بالفعل. اختبارات الوحدة محلية ولا تحتاج أسرارًا حقيقية، وتغطي الإعدادات وتطبيع رسالة Baileys وتشفير AES-256-GCM وفك التشفير وحفظ واسترجاع creds وSignal key عبر عقد مخزن معزول، إضافةً إلى حماية سياق Gemini.

## Render

يحتوي المشروع على `render.yaml` مخصص للمحرك، وليس لتطبيق Next.js. استخدم إعدادات الخدمة التالية:

| الإعداد | القيمة |
| --- | --- |
| نوع الخدمة | Web Service / Node.js |
| Build Command | `pnpm install --frozen-lockfile && pnpm run bot:build` |
| Start Command | `pnpm run bot:start` |
| Health Check Path | `/health` |
| الأسرار | `GEMINI_API_KEY` و`SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` و`BAILEYS_AUTH_ENCRYPTION_KEY` في لوحة البيئة فقط. |

| أسلوب التشغيل | الملاءمة | التكلفة والتعقيد | القيد الأساسي |
| --- | --- | --- | --- |
| Render Free مع Supabase | مناسب لاختبار QR والجلسة والبناء | إعداد بسيط وخطة مجانية | تتوقف الخدمة بعد 15 دقيقة من غياب الحركة، فتغلق WebSocket؛ لا تُستخدم لبوت مباشر موثوق. [2] |
| خدمة Node.js دائمة ومدفوعة أو خادم موجود دائم التشغيل | مناسب للإنتاج | تكلفة تشغيل وإدارة أو اشتراك بسيط | يحافظ على WebSocket ويعيد الاتصال بعد الاستعادة. |
| جهاز محلي يبقى متصلاً دائمًا | مناسب لتجربة قليلة الكلفة | لا كلفة استضافة إضافية | يتوقف البوت عند توقف الجهاز أو الإنترنت. |

يوفر Render فحوص HTTP لإعادة تشغيل العملية غير المستجيبة، ويقبل `GET /health` كفحص صحة. [3] استخدم الخدمة المجانية للتحقق الفني فقط. لا يمكن لنبض HTTP إلى `/health` تحويلها إلى منصة موثوقة لإدارة اتصال WhatsApp مباشر طوال الوقت؛ استخدم عملية دائمة للإنتاج.

## المراجع

[1] [Baileys — الحزمة الرسمية المجتمعية والتوثيق](https://www.npmjs.com/package/@whiskeysockets/baileys)
[2] [Render — قيود الخدمات المجانية](https://render.com/docs/free)
[3] [Render — Health Checks](https://render.com/docs/health-checks)
[4] [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
[5] [Gemini API — Text generation](https://ai.google.dev/gemini-api/docs/text-generation)
