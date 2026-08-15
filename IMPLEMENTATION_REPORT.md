# تقرير تنفيذ مشروع `wa-engine`

**التاريخ:** 15 أغسطس 2026  
**المؤلف:** Manus AI

## الخلاصة التنفيذية

تم تحليل المستودع كاملًا من الكود الفعلي، ثم تطوير مسار تشغيل مستقل وآمن لبوت دعم واتساب باسم `src/engine`. حافظ التنفيذ على تطبيق Next.js ولوحة إدارة BerryLabs الحالية بدل إعادة بنائهما أو حذف أي منهما. ويستخدم المحرك الجديد **Gemini 2.5 Flash**، وSupabase للذاكرة وقاعدة المعرفة ومنع التكرار، وWassenger لاستقبال وإرسال رسائل واتساب عبر webhook.

> **قرار معماري:** المستودع كان يضم منتجين غير مربوطين تشغيليًا: لوحة Next.js لإدارة وكلاء عبر BerryLabs، وبوت JavaScript قديم يعتمد على OpenAI وذاكرة في الذاكرة. بدلاً من خلطهما أو كسر لوحة الإدارة، أُضيف محرك TypeScript مستقل موثق وقابل للتشغيل، مع ترك واجهة الإدارة القائمة دون تغيير في عقدها الخارجي.

## ما تم إنجازه

| المجال | التنفيذ |
| --- | --- |
| Gemini | إضافة `@google/genai` واستخدام `gemini-2.5-flash` على الخادم فقط، مع system instruction يحظر اختلاق المعلومات وتسريب الأسرار واتباع الحقن داخل المستخدم أو الوثائق. |
| WhatsApp | خادم webhook جديد في `src/engine/server.ts`، مع حد للطلبات، وإقرار سريع، والتحقق الاختياري من ترويسة `x-webhook-secret` الإلزامية في الإنتاج. |
| منع التكرار | جدول `webhook_events` ومفتاح `external_event_id` فريدان؛ لا يعالج الحدث الوارد مرتين. |
| الذاكرة | حفظ المستخدمين والمحادثات والرسائل الواردة والصادرة في Supabase، وإرسال نافذة محدودة من آخر الرسائل فقط. |
| اللغة | كشف النص العربي، مع الحفاظ على لغة المحادثة السابقة للرسائل التي لا تحمل دلالة لغوية واضحة. |
| قاعدة المعرفة | جدول `knowledge_base` نشط مع بحث نصي مفهرس بواسطة GIN؛ يمرر السياق الملائم فقط إلى Gemini. |
| المستندات | دعم PDF وDOC وDOCX، وفحص الحجم والتوقيع الفعلي، واستخراج النص، وتخزين metadata، وحذف ملف DOC المؤقت في جميع الحالات. |
| الاستمرارية | مهلات، وإعادة محاولة محدودة، ورسائل fallback عربية وإنجليزية، وسجل JSON لا يطبع مفاتيح أو رموز وصول. |
| إعدادات النشر | `Dockerfile.bot` متعدد المراحل، ومستخدم غير جذري، و`.dockerignore`، وفحص `/health`. |
| التوثيق | تحديث `.env.example` وREADME وإضافة دليل `BOT_ENGINE.md` مع خطوات الإعداد والترحيل والاختبار والنشر. |

## الملفات التي أُنشئت أو عُدلت

| النوع | الملفات |
| --- | --- |
| محرك البوت | `src/engine/config.ts`، `utils.ts`، `types.ts`، `repository.ts`، `documents.ts`، `gemini.ts`، `wassenger.ts`، `processor.ts`، `server.ts`، `index.ts` |
| قاعدة البيانات | `supabase/migrations/20260815_001_bot_engine.sql` |
| الاختبارات | `tests/engine.test.ts` و`src/types/vendor.d.ts` |
| التشغيل | `Dockerfile.bot`، `.dockerignore`، `tsconfig.engine.json`، `pnpm-workspace.yaml` |
| الإعداد والحزم | `package.json`، `pnpm-lock.yaml`، `.env.example`، `.gitignore` |
| التوثيق | `BOT_ENGINE.md`، `IMPLEMENTATION_REPORT.md`، وREADME المحدث |

## ما تم إصلاحه وتحسينه

| المشكلة المكتشفة | المعالجة |
| --- | --- |
| البوت القديم يستخدم OpenAI وليس Gemini | المسار التشغيلي الجديد يستخدم SDK الرسمي `@google/genai` و`gemini-2.5-flash`. |
| ذاكرة المحادثة كانت كائنًا داخل العملية وتضيع بعد restart | أصبحت الذاكرة والمحادثات والرسائل دائمة في Supabase. |
| لا توجد طبقة محلية لمعرفـة المعهد أو RAG | أُضيفت جداول المعرفة، بحث نصي مفهرس، وبناء سياق محدود. |
| لا توجد معالجة آمنة للمستندات | أُضيف فحص امتداد/حجم/توقيع وتقييد الأنواع ثم الاستخراج والتنظيف. |
| لا توجد حماية فعلية من تكرار الويبهوك | أصبح event ID مسجلًا بشكل فريد في قاعدة البيانات. |
| نقطة الإرسال القديمة كانت عامة | خادم المحرك الجديد لا يعرض نقطة إرسال رسائل عامة. |
| أسرار ومتغيرات المحرك غير موثقة | أُضيفت قائمة بيئة منفصلة مع تحذير صريح من وضع الأسرار في `NEXT_PUBLIC_*`. |
| اعتماديات إطار العمل متقادمة أمنيًا | رُقيت Next.js إلى `15.5.21`، وReact إلى `19.1.7`، وClerk إلى `6.39.3`، وAxios إلى `1.18.0`، وPrisma إلى `6.19.3`، مع تجاوزات آمنة لـ PostCSS وSharp. |

## قاعدة البيانات وSupabase

يشغّل الترحيل `supabase/migrations/20260815_001_bot_engine.sql` الجداول التالية: `bot_users`، و`conversations`، و`messages`، و`documents`، و`knowledge_base`، و`bot_settings`، و`webhook_events`.

ترتبط المحادثة بمستخدم واحد، وترتبط الرسائل والوثائق بمحادثة. تحتوي الجداول على مفاتيح خارجية وفهارس مناسبة للقراءة الشائعة، وفهرس GIN للبحث في المعرفة. فُعّل RLS على جميع جداول المحرك، ولا توجد سياسة عامة لعملاء المتصفح؛ يستخدم المحرك مفتاح Supabase الخدمي على الخادم فقط. هذا يتوافق مع توجيه Supabase بإلزام RLS للجداول في المخطط المكشوف وبإبقاء service-role key خارج المتصفح. [2]

ابدأ بإدخال حقائق مؤكدة فقط حول القبول، الرسوم، البرامج، الجداول، الاختبارات، التعليمات وبيانات التواصل في `knowledge_base`. لا تضف embeddings في البداية؛ أصبح التوسع إلى `pgvector` خيارًا موثقًا في الترحيل عندما تكبر المعرفة ويُختار نموذج embeddings ثابت الأبعاد. [3]

## إعدادات البيئة المطلوبة

| المتغير | الغرض |
| --- | --- |
| `NODE_ENV` | `development` أو `production`؛ يلزم `production` في النشر الحقيقي. |
| `PORT` | منفذ خادم المحرك؛ الافتراضي `8080`. |
| `BOT_NAME` | اسم مساعد المعهد. |
| `DEFAULT_LANGUAGE` | `ar` أو `en`. |
| `ENABLE_AI` | تفعيل Gemini. |
| `ENABLE_GROUP_REPLY` | يبقى `false` افتراضيًا لمنع ردود المجموعات. |
| `MAX_HISTORY_MESSAGES` | عدد الرسائل الحديثة للسياق؛ الافتراضي 12. |
| `MAX_FILE_SIZE` | الحد بالبايت؛ الافتراضي 8 MiB. |
| `GEMINI_API_KEY` | مفتاح Gemini الخادمي. |
| `GEMINI_MODEL` | القيمة الافتراضية `gemini-2.5-flash`. |
| `SUPABASE_URL` | عنوان مشروع Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | مفتاح خادمي فقط؛ لا يرسل للمتصفح. |
| `WASSENGER_API_URL` | الافتراضي `https://api.wassenger.com/v1`. |
| `WASSENGER_API_KEY` | مفتاح Wassenger. |
| `WASSENGER_DEVICE_ID` | معرف رقم واتساب المقصود. |
| `WEBHOOK_SHARED_SECRET` | سر طويل لترويسة `x-webhook-secret`، وهو إلزامي في الإنتاج. |
| `FALLBACK_MESSAGE_AR` و`FALLBACK_MESSAGE_EN` | نص الرد الاحتياطي القابل للتعديل. |

لا يتضمن المستودع أي مفاتيح حقيقية.

## Gemini وWhatsApp

المحرك يستعمل مكتبة Google Gen AI الحالية من جانب الخادم. يدعم نموذج `gemini-2.5-flash` الاستدلال والنصوص ومدخلات المستندات؛ وضع هذا المشروع حدودًا عملية للسياق والرد، بدلاً من إرسال تاريخ المحادثة كاملاً. [4] [5]

تدعم Wassenger API رسائل واتساب الواردة والصادرة وwebhooks الوقت الحقيقي، كما تسمح بترويسات webhook مخصصة. اربط الرقم من لوحة Wassenger، وانشر المحرك على HTTPS، واضبط endpoint إلى `POST /webhooks/wassenger` مع سر `x-webhook-secret`. [1]

## نتائج التحقق والاختبارات

| الأمر أو الاختبار | النتيجة |
| --- | --- |
| `npm install` | **نجح** في شجرة تثبيت نظيفة، وشغّل `prisma generate`. تعطل أولًا فقط لأن npm حاول قراءة شجرة `node_modules` منشأة بواسطة pnpm؛ لا تخلط مديري الحزم في البيئة نفسها. |
| `pnpm install --frozen-lockfile --ignore-scripts` | **نجح**؛ ملف القفل متسق. |
| `pnpm bot:typecheck` | **نجح**. |
| `pnpm test` و`npm test` | **نجحا**؛ 5 اختبارات وحدة نجحت. |
| `pnpm build` | **نجح** مع مفتاح Clerk تجريبي شكلي في بيئة الفحص؛ يحتاج النشر الفعلي مفتاح Clerk حقيقيًا. |
| `pnpm lint` | **نجح**. |
| فحص `/health` للمحرك | **نجح**؛ أعاد `{ "ok": true, "service": "wa-engine" }`. |
| Webhook invalid payload | **نجح**؛ أعاد HTTP 400 من دون استدعاء خدمات خارجية. |
| `pnpm audit --prod --json` | **نجح**؛ نتيجة الخروج `0` بعد تحديث الاعتماديات. |
| Docker build | **لم يُنفذ** لأن Docker غير مثبت في بيئة التحقق، لكن Dockerfile موثق وجاهز للتشغيل. |

## التشغيل من الصفر

```bash
cp .env.example .env
# املأ المتغيرات الحقيقية، ولا ترفع ملف .env إلى Git.
pnpm install
# نفذ محتوى supabase/migrations/20260815_001_bot_engine.sql في Supabase مرة واحدة.
pnpm bot:start
```

في التطوير استخدم `pnpm bot:dev`. للتحقق من الواجهة أيضًا استخدم `pnpm dev`. لا تبدأ المحرك في الإنتاج قبل ضبط `WEBHOOK_SHARED_SECRET`، ومفتاح Gemini، ومفتاح Supabase الخدمي، ومفتاح Wassenger.

## النشر الإنتاجي

| النهج | المقايضات | الإعداد | التوصية |
| --- | --- | --- | --- |
| خدمة Docker مُدارة مثل Render أو Railway | أبسط تشغيل مستمر مع HTTPS وhealth check وإعادة نشر من Git؛ أقل تحكمًا في النظام. | انشر `Dockerfile.bot`، أضف الأسرار كـ environment variables، واضبط `/health`. | **الخيار الموصى به** لهذا المحرك. |
| VPS صغير مع Docker | تحكم كامل في الشبكة والنظام، مقابل مسؤولية التحديثات وTLS والمراقبة واستعادة الأعطال. | شغّل الصورة مع process supervisor أو Compose وreverse proxy. | مناسب عند وجود فريق بنية تحتية أو متطلبات تحكم خاصة. |

تدعم Render البناء من Dockerfile وhealth checks والنشر بلا توقف، كما تبني Railway الخدمات من Dockerfile وتستطيع انتظار health check قبل اعتبار النشر فعالًا. [6] [7]

## المتبقي قبل الإطلاق الفعلي

يتطلب الإطلاق إعدادات خارجية لا يمكن تنفيذها دون حساباتك: إنشاء مشروع Supabase وتطبيق الترحيل، إضافة معرفة المعهد المؤكدة، إنشاء مفاتيح Gemini وWassenger، ربط رقم واتساب في Wassenger، ضبط webhook السرّي، ثم نشر صورة Docker على خدمة مستمرة. لم يُجر اختبار طرفي مباشر مع حساب واتساب أو Gemini أو Supabase حقيقي؛ يجب إجراء اختبار رسائل نصية ووثيقة PDF برقم تجريبي قبل توجيه المستخدمين الفعليين.

يبقى مسار البوت الجذري القديم (`bot.js` و`actions.js` و`main.js`) موجودًا للمحافظة على المحتوى، لكنه ليس مسار التشغيل الجديد ولا ينبغي نشره إلى جانب المحرك الجديد. يُستحسن التخطيط لإزالته أو أرشفته بعد تأكيد نجاح عملية الانتقال على بيئة الاختبار.

## المراجع

[1] [Wassenger Developers — REST API and real-time webhooks](https://wassenger.com/developers)  
[2] [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)  
[3] [Supabase — Semantic search and pgvector](https://supabase.com/docs/guides/ai/semantic-search)  
[4] [Google Gemini API — Text generation](https://ai.google.dev/gemini-api/docs/text-generation)  
[5] [Google Gemini API — Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)  
[6] [Render — Docker deployments](https://render.com/docs/docker)  
[7] [Railway — Deployments reference](https://docs.railway.com/deployments/reference)
