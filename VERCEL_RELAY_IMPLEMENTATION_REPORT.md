# تقرير تنفيذ Vercel Wassenger Relay

**الفرع:** `vercel-wassenger-relay`  
**تنفيذ Git:** `73b24d6`  
**التاريخ:** 15 أغسطس 2026

## التنفيذ المنجز

تمت إضافة طبقة Vercel Relay في `app/api/wassenger/route.ts`، مع فصل منطقها القابل للاختبار في `src/vercel-relay.ts`. تبقى وظيفتها محدودة في التحقق من سر Wassenger، وقراءة الجسم الخام، وإنشاء `requestId`، ثم تمرير الجسم كما هو إلى `wa-engine` مع `x-request-id` وسر محرك مستقل. لا يحتوي هذا المسار على Gemini أو Supabase أو ذاكرة محادثات أو قاعدة معرفة أو منطق إرسال رسائل.

يتحقق Relay من `WASSENGER_WEBHOOK_SECRET` قبل الاتصال بالمحرك، ويستخدم `ENGINE_WEBHOOK_SECRET` مختلفًا عند الاتصال بـ `wa-engine`. تعيد الأخطاء استجابات عامة فقط، وتسجل معلومات تشخيصية آمنة مثل `requestId` و`eventId` وstatus، من دون مفاتيح أو نصوص الوثائق أو payload كامل.

تم تحديث `.env.example` لتوضيح متغيرات Vercel ومتغيرات المحرك وتأكيد أن `WEBHOOK_SHARED_SECRET` في المحرك يساوي `ENGINE_WEBHOOK_SECRET` في Vercel، لكنه يختلف عن `WASSENGER_WEBHOOK_SECRET`.

## نتائج التحقق

| البند المطلوب | الحالة | الدليل أو الملاحظة |
| --- | --- | --- |
| Vercel Relay | **PASS — local** | Route Handler بني بنجاح، واختبار local أعاد `401` للسر الخاطئ و`202` للترحيل السليم إلى المحرك. |
| wa-engine | **PASS — local** | `GET /health` أعاد `{ "ok": true, "service": "wa-engine", "environment": "production" }`. كما قبل المحرك طلب relay الصحيح وأعاد `202`. |
| Supabase | **NOT TESTED — requires external credentials** | يوجد الترحيل المطلوب في `supabase/migrations/20260815_001_bot_engine.sql`، لكن لم يُطبق على مشروع Supabase حقيقي. |
| Gemini | **NOT TESTED — requires external credentials** | لم يُستخدم مفتاح Gemini حقيقي، ولم يُجرَ استدعاء نموذج خارجي. |
| Wassenger | **NOT TESTED — requires external credentials** | لم يُضبط جهاز Wassenger أو webhook حقيقي ولم تُرسل رسالة واتساب. |
| Arabic | **NOT TESTED — requires external credentials** | يلزم رسالة عربية حقيقية بعد ربط الخدمات. |
| English | **NOT TESTED — requires external credentials** | يلزم رسالة إنجليزية حقيقية بعد ربط الخدمات. |
| PDF | **NOT TESTED — requires external credentials** | يلزم إرسال PDF صغير من Wassenger مع Supabase/Gemini صالحين. |
| DOC | **NOT TESTED — requires external credentials** | يلزم إرسال DOC صالح من Wassenger مع البيئة الخارجية. |
| DOCX | **NOT TESTED — requires external credentials** | يلزم إرسال DOCX صالح من Wassenger مع البيئة الخارجية. |
| Idempotency | **PASS — unit coverage** | منطق المحرك موجود في Supabase عبر `external_event_id` الفريد؛ يلزم اختبار تكامل حقيقي بعد تطبيق الترحيل. |
| Security | **PASS — local** | اختبارات وحدة للسر الخاطئ، وعدم تمرير الأسرار في السجل، والمهلة، وفحص local مستقل لسر المحرك أعاد `401`. |
| Docker | **NOT TESTED — Docker unavailable** | `Dockerfile.bot` بقي دون تغيير، لكن Docker غير مثبت في بيئة التحقق. |
| Production | **NOT READY** | لا يمكن اعتباره جاهزًا قبل تهيئة Vercel وSupabase وGemini وWassenger الحقيقية وتنفيذ اختبارات الطرف إلى الطرف. |

## اختبارات محلية نجحت

| الأمر أو الاختبار | النتيجة |
| --- | --- |
| `pnpm test` | نجح: **10/10** اختبارات وحدة. |
| `pnpm build` | نجح: بنى المسار الديناميكي `/api/wassenger`. |
| `pnpm bot:build` | نجح: ترجم محرك TypeScript المستقل. |
| `pnpm audit --prod --json` | نجح: رمز الخروج `0`. |
| `Vercel Relay -> wa-engine` محليًا | نجح: السر الخاطئ `401`، والترحيل الصحيح `202`. |
| `wa-engine /health` | نجح في بيئة `production` بأسرار تجريبية. |
| `Vercel -> wa-engine` secret خاطئ | نجح: المحرك أعاد `401` قبل معالجة الطلب. |

## خطوات الاختبار الخارجي المطلوبة

1. أنشئ مشروع Supabase منفصلًا لـ staging، ثم نفّذ `supabase/migrations/20260815_001_bot_engine.sql` وأضف معلومة اختبارية مؤكدة بعنوان **اختبار الدعم**.
2. انشر `wa-engine` على مضيف HTTPS مستمر واضبط متغيراته الحقيقية، بما فيها `WEBHOOK_SHARED_SECRET`.
3. انشر هذا الفرع على Preview في Vercel، واضبط `WA_ENGINE_URL` و`WASSENGER_WEBHOOK_SECRET` و`ENGINE_WEBHOOK_SECRET` و`RELAY_TIMEOUT_MS=8000`.
4. اجعل `ENGINE_WEBHOOK_SECRET` مساويًا لـ `WEBHOOK_SHARED_SECRET`، واجعل `WASSENGER_WEBHOOK_SECRET` مختلفًا عنه.
5. اختبر Vercel مباشرةً بـ `curl` من دليل `SUPABASE_WASSENGER_TEST_GUIDE.md`، ثم تحقق من `webhook_events` و`messages` في Supabase.
6. أضف webhook Wassenger إلى `https://YOUR_VERCEL_DOMAIN/api/wassenger`، ثم اختبر رسالة عربية ورسالة إنجليزية وسؤالًا غير موجود، وبعدها PDF وDOC وDOCX.
7. أرسل نفس `external_event_id` مرتين وتحقق من بقاء صف `webhook_events` واحدًا وعدم وصول رد ثانٍ.

> لا تدمج هذا الفرع في `main` قبل اكتمال الاختبارات الخارجية السابقة ونجاح قائمة الأمن والملفات والمجموعات الفعلية.

## المراجع

[1] [Vercel Functions](https://vercel.com/docs/functions)  
[2] [Vercel Environment Variables](https://vercel.com/docs/environment-variables)  
[3] [Vercel Function Limits](https://vercel.com/docs/functions/limitations)  
[4] [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)  
[5] [Wassenger Developers](https://wassenger.com/developers)
