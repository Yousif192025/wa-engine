# محرك بوت دعم واتساب

## الغرض وحدود البنية

يحتوي هذا المستودع الآن على مسارين متكاملين لكن مستقلين. يبقى تطبيق Next.js القائم لوحة إدارة تتصل بخدمة BerryLabs كما كان، بينما يضيف `src/engine` خدمة Node.js مستقلة لمعالجة رسائل واتساب الواردة عبر Wassenger، والرد باستخدام Gemini، وحفظ الذاكرة والمعرفة في Supabase. لم تُستبدل لوحة الإدارة ولم تُحذف واجهاتها أو نماذج Prisma الحالية.

> **القرار المعماري:** المحرك الجديد لا يعتمد على ذاكرة العملية أو جلسة متصفح واتساب. إنه يستقبل webhooks من Wassenger، ولذلك يتطلب عنوان HTTPS ثابتًا عند النشر وتشغيلًا مستمرًا.

| العنصر | المسؤولية |
| --- | --- |
| `src/engine/server.ts` | نقطة ويبهوك محمية، حد معدل الطلبات، وإقرار سريع للأحداث. |
| `src/engine/processor.ts` | منع التكرار، حفظ الرسائل، اللغة، الاسترجاع، الاستدعاء، والإرسال. |
| `src/engine/gemini.ts` | استخدام SDK `@google/genai` وخيار `gemini-2.5-flash` على الخادم فقط. |
| `src/engine/repository.ts` | ذاكرة المحادثات، الوثائق، قاعدة المعرفة، وسجل idempotency في Supabase. |
| `src/engine/documents.ts` | فحص الحجم والتوقيع واستخراج PDF وDOC وDOCX وحذف المؤقتات. |
| `supabase/migrations/20260815_001_bot_engine.sql` | إنشاء الجداول والفهارس وRLS. |

## تدفق الرسالة

ينفذ المحرك التدفق التالي لكل حدث وارد: يتحقق من سر الويبهوك، ثم يسجل `external_event_id` مرة واحدة. بعد ذلك ينشئ أو يحمّل المستخدم والمحادثة، ويستنتج اللغة مع المحافظة على لغة المحادثة السابقة، ويحفظ الرسالة. بالنسبة للمستندات، يتحقق من الحجم والتوقيع الفعلي قبل استخراج النص. بعدها يجلب نافذة صغيرة من الرسائل السابقة وبحثًا نصيًا محدودًا من قاعدة المعرفة، ويغلف كل ذلك كسياق غير موثوق قبل إرسال الطلب إلى Gemini. وأخيرًا يتحقق من الرد، يحفظه، ويرسله عبر Wassenger.

```text
Wassenger webhook
  -> signature + rate-limit + idempotency
  -> user / conversation / message in Supabase
  -> optional PDF/DOC/DOCX text extraction
  -> recent messages + knowledge-base search
  -> Gemini 2.5 Flash
  -> response validation
  -> Supabase outbound message + Wassenger reply
```

## المتطلبات

تحتاج إلى Node.js 20 أو أحدث، وحساب Supabase، ومفتاح Gemini Server-side، وحساب Wassenger به رقم واتساب عامل. تدعم Wassenger إرسال واستقبال الرسائل والـ webhooks الفورية؛ يجب إعداد الويبهوك من لوحة Wassenger أو واجهتها ليشير إلى الخدمة المنشورة. [1]

| المتطلب | القيمة أو الإجراء |
| --- | --- |
| Node.js | `>=20`، مع Node.js 22 أو أحدث إذا انتقلت إلى الإصدار 3 من SDK مستقبلًا. |
| قاعدة البيانات | مشروع Supabase واحد لكل بيئة. |
| Gemini | مفتاح من Google AI Studio وحفظه في `GEMINI_API_KEY` فقط. |
| WhatsApp | جهاز/رقم متصل في Wassenger ومفتاح API له. |
| عنوان عام | HTTPS ثابت يمكن أن يصل إليه Wassenger، مثل `https://bot.example.com/webhooks/wassenger`. |

## الإعداد المحلي

انسخ ملف المثال ولا تضف ملف `.env` إلى Git. يستخدم المستودع `pnpm-lock.yaml`، لذلك الأمر المفضل هو `pnpm install`. كما يمكن استعمال `npm install` عند الحاجة، لكن يجب اختيار مدير حزم واحد للفريق لتجنب اختلاف ملفات القفل.

```bash
cp .env.example .env
pnpm install
pnpm bot:start
```

أضف قيم Supabase وGemini وWassenger الحقيقية إلى `.env`. في التطوير يمكن ترك `NODE_ENV=development`، لكن يجب تعيين `NODE_ENV=production` و`WEBHOOK_SHARED_SECRET` طويل وعشوائي في الإنتاج. لا تضع أي مفتاح تحت متغير يبدأ بـ `NEXT_PUBLIC_`.

| المتغير | مطلوب | الاستخدام |
| --- | --- | --- |
| `GEMINI_API_KEY` | نعم | مصادقة Gemini على الخادم. |
| `GEMINI_MODEL` | نعم | القيمة الافتراضية `gemini-2.5-flash`. |
| `SUPABASE_URL` | نعم | عنوان مشروع Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | نعم | صلاحية خادمية فقط؛ لا تُكشف للمتصفح. |
| `WASSENGER_API_KEY` | نعم | مصادقة API الإرسال والتنزيل. |
| `WASSENGER_DEVICE_ID` | مستحسن | يقيّد الإرسال إلى الرقم المقصود. |
| `WEBHOOK_SHARED_SECRET` | إلزامي في الإنتاج | يطابق ترويسة `x-webhook-secret` التي تضبطها في Wassenger. |
| `ENABLE_GROUP_REPLY` | لا | اتركه `false` لحظر الردود على المجموعات افتراضيًا. |
| `MAX_HISTORY_MESSAGES` | لا | حجم نافذة الذاكرة؛ الافتراضي 12. |
| `MAX_FILE_SIZE` | لا | حد الملف بالبايت؛ الافتراضي 8 MiB. |

## إعداد Supabase

نفّذ ملف الترحيل `supabase/migrations/20260815_001_bot_engine.sql` مرة واحدة في محرر SQL الخاص بالمشروع أو باستخدام CLI. ينشئ الترحيل جداول `bot_users` و`conversations` و`messages` و`documents` و`knowledge_base` و`bot_settings` و`webhook_events`.

العلاقات الأساسية هي `bot_users -> conversations -> messages`، بينما ترتبط الوثائق بالمستخدم والمحادثة. يفرض `webhook_events.external_event_id` الفريد معالجة الرسالة مرة واحدة، وتفهرس الرسائل حسب المحادثة والزمن، وتستخدم `knowledge_base.search_vector` فهرس GIN للبحث النصي. فُعّل RLS على جميع الجداول ولا توجد سياسة عامة للمتصفح؛ المفتاح الخدمي يعمل داخل المحرك فقط. توصي Supabase بتفعيل RLS على الجداول في المخطط المكشوف وإبقاء مفاتيح الخدمة خارج المتصفح. [2]

لبناء قاعدة المعرفة، أضف صفوفًا مؤكدة فقط إلى `public.knowledge_base` من خلال محرر Supabase أو عملية إدارة خادمية. على سبيل المثال:

```sql
insert into public.knowledge_base (title, category, content)
values (
  'مواعيد الاختبارات',
  'exams',
  'تُحدّث مواعيد الاختبارات رسميًا من قسم القبول والتسجيل. تواصل مع المعهد للحصول على الموعد المؤكد.'
);
```

البحث الأولي نصي ووزنه بسيط عمدًا. إذا كبرت قاعدة المعرفة أو احتاجت مطابقة دلالية أوسع، يوضح أسفل الترحيل نقطة التوسع الاختيارية إلى `pgvector`. لا تضف متجهات قبل اختيار نموذج embeddings وأبعاده، لأن مقارنة embeddings التي أنشأتها نماذج مختلفة غير صحيحة. [3]

## إعداد Wassenger والويبهوك

1. اربط رقم المؤسسة في لوحة Wassenger وتأكد من أن حالته نشطة.
2. انشر المحرك على عنوان HTTPS عام، ثم تحقق من `GET /health`.
3. أنشئ webhooks للأحداث الواردة `message:in` أو `message:in:new` حسب إعداد حسابك، وأشر إلى `POST /webhooks/wassenger`.
4. أضف ترويسة مخصصة باسم `x-webhook-secret` وبالقيمة نفسها في `WEBHOOK_SHARED_SECRET`.
5. أرسل رسالة نصية اختبارية من رقم غير رقم البوت. يجب أن يظهر صف وارد ورد صادر في Supabase.

لا يفتح المحرك نقطة إرسال عامة، ولا يستقبل أسرارًا في الجسم، ولا يرد على المجموعات ما لم تضبط `ENABLE_GROUP_REPLY=true`. يدعم Wassenger ترويسات مخصصة للـ webhook، لذا استخدمها للتحقق من مصدر الطلب بدل قبول أي POST وارد. [1]

## دعم الملفات

تقبل الخدمة PDF وDOC وDOCX فقط. يتحقق المحرك من حد الحجم المعلن والحجم الفعلي، ويقارن ترويسة الملف بتوقيع PDF أو DOC/OLE أو DOCX/ZIP قبل الاستخراج. تُستخرج نصوص PDF وDOCX في الذاكرة، بينما يستخدم DOC ملفًا مؤقتًا بصلاحية المالك ويحذفه دائمًا في `finally`. لا ينفذ المحرك ما يوجد في المستند، ويعامل محتواه كسياق غير موثوق لا كتعليمات.

## التحقق والاختبارات

```bash
pnpm typecheck
pnpm test
pnpm build
```

اختبارات الوحدة لا تحتاج حسابات خارجية؛ وهي تغطي كشف اللغة، التحقق من الإعدادات، بناء السياق المقاوم لحقن التعليمات، وتطبيع payload. أما اختبار الويبهوك الكامل فيحتاج مفاتيح بيئة صحيحة وقاعدة Supabase مطبّق عليها الترحيل ورقم Wassenger تجريبي.

## التشغيل الإنتاجي

يشغّل هذا البوت مستمع webhook دائمًا، ولذلك لا يصلح عادة لنشر serverless قصير العمر أو لجلسة sandbox متوقفة. لا يحتاج هذا التصميم إلى قرص دائم لجلسة واتساب لأن Wassenger يدير اتصال الرقم؛ أما البيانات الدائمة فتسكن في Supabase.

| الخيار | الملاءمة | المزايا والتنازلات | القرار |
| --- | --- | --- | --- |
| خدمة Docker مُدارة مثل Render أو Railway | الأنسب لهذا المستودع | تنشر `Dockerfile.bot`، تعطي عنوان HTTPS، وتدعم health check وإعادة النشر من المستودع. تحافظ على تشغيل مستمر من دون إدارة نظام تشغيل. | **موصى به** كبداية إنتاجية مستقرة وبسيطة. |
| VPS صغير + Docker | مناسب عند وجود فريق بنية تحتية أو حاجة إلى تحكم أعلى | تحكم كامل في الشبكة والمراقبة والنسخ الاحتياطي، لكنه يحمّل الفريق مسؤولية TLS والتحديثات والنظام والـ process supervisor. | بديل جيد عندما تكون السيطرة التشغيلية أهم من البساطة. |

توثق Render نشر Docker من ملف `Dockerfile` ودعم health checks والنشر بلا توقف، كما تستطيع Railway بناء خدمة من Dockerfile وتحديد صحتها من health check. [6] [7] خزّن الأسرار في مدير أسرار المنصة، واضبط health check على `GET /health`، ثم لا تشغّل أكثر من نسخة من المحرك إلا بعد التأكد من استراتيجية idempotency المركزية في Supabase.

يعرض `Dockerfile.bot` صورة تشغيل لا تتضمن ملف `.env`، ويدعم الأمر التالي محليًا:

```bash
docker build -f Dockerfile.bot -t wa-engine-bot .
docker run --env-file .env -p 8080:8080 wa-engine-bot
```

راقب `/health` وسجلات JSON، ودوّر مفاتيح Gemini وSupabase وWassenger إذا تعرضت للخطر. تميّز الردود الاحتياطية بين العربية والإنجليزية ولا توقف استقبال الويبهوك عند تعطل Gemini أو قاعدة البيانات.

## المراجع

[1] [Wassenger Developers — REST API and real-time webhooks](https://wassenger.com/developers)  
[2] [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)  
[3] [Supabase — Semantic search and pgvector](https://supabase.com/docs/guides/ai/semantic-search)  
[4] [Google Gemini API — Text generation](https://ai.google.dev/gemini-api/docs/text-generation)  
[5] [Google Gemini API — Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)  
[6] [Render — Docker deployments](https://render.com/docs/docker)  
[7] [Railway — Deployments reference](https://docs.railway.com/deployments/reference)
