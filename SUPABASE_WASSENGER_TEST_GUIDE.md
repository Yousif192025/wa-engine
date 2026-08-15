# دليل اختبار تكامل Wassenger وVercel و`wa-engine` وSupabase وGemini

## الهدف

يتحقق هذا الدليل من المسار التالي بالتدريج، بحيث يثبت كل اختبار وصلة واحدة قبل الانتقال إلى الوصلة التالية:

```text
Wassenger
  -> Vercel Webhook Function
  -> wa-engine
  -> Supabase
  -> Gemini 2.5 Flash
  -> Wassenger
```

> **قاعدة الاختبار:** لا تختبر المسار كله للمرة الأولى. ابدأ بالصحة وقاعدة البيانات، ثم اختبر ترحيل Vercel، ثم رسالة نصية حقيقية، ثم منع التكرار وحالات العطل. بهذه الطريقة ستعرف بدقة أين توجد المشكلة عند الفشل.

## 1. ثبّت عقد المسؤوليات أولًا

يجب أن يكون Vercel طبقة ترحيل خفيفة فقط: يتحقق من سر Wassenger، ينشئ `requestId`، يرسل payload كما هو إلى `wa-engine`، ثم يعيد استجابة سريعة. يجب أن يبقى `wa-engine` مسؤولًا عن حفظ Supabase، واستدعاء Gemini، وإرسال الرد؛ فلا تكرر هذه العمليات في Vercel.

| المكوّن | المسؤولية في الاختبار | ما يجب تسجيله |
| --- | --- | --- |
| Wassenger | إرسال event واستلام الرد | `eventId` و`messageId` ووقت الإرسال. |
| Vercel Function | التحقق والترحيل | `requestId` و`eventId` وHTTP status للـ engine. |
| `wa-engine` | idempotency، Supabase، Gemini والإرسال | `eventId` و`messageId` ونتيجة كل مرحلة من دون أسرار. |
| Supabase | الحقيقة الدائمة للرسائل وحالة الحدث | صفوف `webhook_events` و`messages` و`conversations`. |
| Gemini | إنتاج النص فقط | زمن الاستجابة وحالة الخطأ، لا prompt أو أسرار كاملة في السجل. |

يعالج Vercel كل طلب كـ Function invocation مستقلة، ويمكنه التوسع تلقائيًا. لهذا السبب لا تحفظ deduplication أو حالة المحادثة داخل ذاكرة Vercel؛ أبقها في Supabase. [1]

## 2. أنشئ بيئة اختبار معزولة

أنشئ مشروع Supabase منفصلًا للاختبار، ورقم Wassenger تجريبيًا إن أمكن، وبيئة **Preview** في Vercel. لا تستخدم جداول أو رقم الإنتاج أثناء أول اختبار. تدعم Vercel متغيرات مختلفة لكل من Development وPreview وProduction؛ أي تغيير في المتغيرات يحتاج نشرًا جديدًا لتطبيقه. [2]

### متغيرات Vercel

ضع هذه المتغيرات في بيئة Preview فقط:

| المتغير | القيمة |
| --- | --- |
| `WA_ENGINE_URL` | مثل `https://bot-staging.example.com/webhooks/wassenger` |
| `WASSENGER_WEBHOOK_SECRET` | السر الذي يضعه Wassenger في الطلب إلى Vercel. |
| `ENGINE_WEBHOOK_SECRET` | السر الذي سترسله Vercel في ترويسة `x-webhook-secret` إلى المحرك. |
| `RELAY_TIMEOUT_MS` | `8000` كبداية. |

ضع هذه المتغيرات في بيئة تشغيل `wa-engine`، وليس في Vercel إلا إذا كان Vercel ينفذها فعلًا:

| المتغير | القيمة |
| --- | --- |
| `GEMINI_API_KEY` و`GEMINI_MODEL` | مفتاح Gemini و`gemini-2.5-flash`. |
| `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` | مشروع Supabase التجريبي؛ مفتاح الخادم لا يوضع في المتصفح. |
| `WASSENGER_API_KEY` و`WASSENGER_DEVICE_ID` | جهاز Wassenger التجريبي. |
| `WEBHOOK_SHARED_SECRET` | يساوي `ENGINE_WEBHOOK_SECRET`. |
| `ENABLE_GROUP_REPLY` | `false`. |
| `NODE_ENV` | `production` على المضيف الخارجي للمحرك، حتى في staging. |

لا تستخدم أسماء تبدأ بـ `NEXT_PUBLIC_` لأي سر. تحفظ Vercel المتغيرات خارج الكود وتطبقها لكل بيئة تختارها. [2]

## 3. نفذ Vercel Function كمرحل محدود

في تطبيق Next.js، أنشئ Route Handler على المسار `app/api/wassenger/route.ts`. لا تضع مفاتيح Gemini أو Supabase أو Wassenger في الكود. المثال التالي يوضح الترحيل فقط؛ عدّل التحقق من التوقيع/السر ليتوافق مع إعداد Wassenger في حسابك.

```ts
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(request: NextRequest) {
  const suppliedSecret = request.headers.get('x-webhook-secret')
  if (suppliedSecret !== process.env.WASSENGER_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawBody = await request.text()
  const requestId = crypto.randomUUID()

  const response = await fetch(process.env.WA_ENGINE_URL!, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-webhook-secret': process.env.ENGINE_WEBHOOK_SECRET!,
      'x-request-id': requestId,
    },
    body: rawBody,
    signal: AbortSignal.timeout(Number(process.env.RELAY_TIMEOUT_MS ?? 8000)),
  })

  console.info(JSON.stringify({
    event: 'wassenger_relay',
    requestId,
    engineStatus: response.status,
  }))

  // أعد 2xx فقط بعد أن يقبل المحرك الحدث.
  if (!response.ok) {
    return NextResponse.json({ error: 'Engine rejected webhook', requestId }, { status: 502 })
  }

  return NextResponse.json({ accepted: true, requestId }, { status: 202 })
}
```

استخدم `request.text()` بدل `request.json()` في طبقة الترحيل حتى لا تغيّر جسم الطلب قبل إرساله. إذا كان حساب Wassenger يدعم توقيع HMAC بدل السر المخصص، تحقق من HMAC باستخدام **الجسم الخام** قبل التحليل. احتفظ بالـ function قصيرة؛ حجم جسم الطلب إلى Vercel Function محدود بـ 4.5 MB، لذلك لا تمرر محتوى المستند نفسه عبر Vercel. مرّر metadata ورابط الوسيط فقط، ودع `wa-engine` ينزّل الملف بعد التحقق. [3]

## 4. طبّق ترحيل Supabase ثم اختبره مباشرة

نفّذ محتوى الملف التالي في محرر SQL لمشروع Supabase التجريبي مرة واحدة:

```text
supabase/migrations/20260815_001_bot_engine.sql
```

بعد التنفيذ، شغّل الاستعلامات التالية. يجب أن تعيد الصفوف صفرًا في مشروع جديد لا أن تفشل:

```sql
select count(*) as webhook_events from public.webhook_events;
select count(*) as messages from public.messages;
select count(*) as conversations from public.conversations;
select count(*) as knowledge_items from public.knowledge_base;
```

ثم أضف معرفة تجريبية مؤكدة لتتحقق من الاسترجاع:

```sql
insert into public.knowledge_base (title, category, content)
values (
  'اختبار الدعم',
  'testing',
  'هذه معلومة اختبارية: مكتب الدعم متاح من الأحد إلى الخميس، 09:00 إلى 16:00.'
);
```

تحقق من RLS من لوحة Supabase. لا تنشئ سياسة `anon` عامة على جداول البوت. يستخدم `wa-engine` مفتاح الخدمة على الخادم فقط، بينما تمنع RLS القراءة العامة من المتصفح. [4]

## 5. اختبر `wa-engine` منفردًا قبل توصيل Wassenger

ابدأ المحرك بالبيئة التجريبية، ثم اختبر health endpoint:

```bash
pnpm bot:build
pnpm bot:start
curl -i https://bot-staging.example.com/health
```

**المتوقع:** `HTTP 200` وجسم قريب من التالي:

```json
{ "ok": true, "service": "wa-engine", "environment": "production" }
```

بعدها أرسل payload تجريبيًا صحيح البنية إلى المحرك مباشرة باستخدام السر بين Vercel والمحرك. لا تستخدم هذا الـ payload كبديل نهائي لـ Wassenger؛ غيّر الحقول لتطابق payload الفعلي الذي تراه في سجلات Wassenger.

```bash
curl -i -X POST 'https://bot-staging.example.com/webhooks/wassenger' \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: YOUR_ENGINE_WEBHOOK_SECRET' \
  -H 'x-request-id: manual-test-001' \
  --data '{
    "id": "staging-event-001",
    "event": "message:in:new",
    "device": { "id": "YOUR_WASSENGER_DEVICE_ID" },
    "data": {
      "id": "staging-message-001",
      "type": "text",
      "body": "ما هي أوقات مكتب الدعم؟",
      "fromNumber": "+15550001111",
      "chat": { "id": "15550001111@c.us", "type": "chat", "contact": { "name": "QA Test" } }
    }
  }'
```

**المتوقع فورًا:** قبول `202`. لا تنتظر رد Gemini في نفس طلب webhook؛ الإقرار المبكر يمنع فشل الإرسال عند تأخر خدمة خارجية.

## 6. تحقق من Supabase بعد الرسالة المباشرة

انتظر حتى 15 ثانية، ثم شغّل الاستعلام التالي في Supabase. غيّر `staging-event-001` عند كل اختبار جديد:

```sql
select id, external_event_id, event_type, status, error_message, received_at, processed_at
from public.webhook_events
where external_event_id = 'staging-event-001';

select
  c.external_chat_id,
  c.language,
  m.direction,
  m.message_type,
  m.content,
  m.created_at
from public.messages m
join public.conversations c on c.id = m.conversation_id
where c.external_chat_id = '15550001111@c.us'
order by m.created_at desc;
```

| النتيجة | التفسير | الإجراء إذا فشلت |
| --- | --- | --- |
| حدث `completed` ورسالتان (inbound/outbound) | Supabase وGemini والإرسال نجحت. | انتقل إلى اختبار Vercel ثم Wassenger. |
| حدث `processing` طويلًا | توقف العامل أو فشل قبل تحديث الحالة. | افحص سجلات `wa-engine` باستخدام `eventId`. |
| حدث `failed` مع `error_message` | وصل المحرك لكن فشلت مرحلة داخلية. | اعزل المشكلة وفق الرسالة: Supabase أو Gemini أو Wassenger. |
| لا يوجد حدث | الطلب لم يصل إلى المحرك أو رُفض بالسر. | افحص عنوان endpoint وترويسة `x-webhook-secret`. |

## 7. اختبر Vercel -> `wa-engine`

انشر فرع Preview في Vercel ثم اختبر Function مباشرة، مع body تجريبي جديد (`staging-event-002`).

```bash
curl -i -X POST 'https://YOUR_PREVIEW.vercel.app/api/wassenger' \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: YOUR_WASSENGER_WEBHOOK_SECRET' \
  --data @payload.json
```

**النجاح المتوقع:**

1. Vercel يعيد `202` مع `requestId`.
2. سجل Vercel يحتوي `wassenger_relay` و`engineStatus: 202`.
3. يظهر `staging-event-002` في `webhook_events` بحالة `completed`.
4. تظهر الرسالة الواردة ثم الصادرة في `messages`.

إذا أعاد Vercel `401`، فالسر بين Wassenger وVercel خطأ. وإذا أعاد `502`، فسجل Vercel يحدد أن المحرك رفض أو لم يستجب؛ انتقل إلى سجلات المحرك. إذا انتهت مدة Function، فراجع `RELAY_TIMEOUT_MS` ووقت استجابة المحرك، ولا تجعل Vercel ينتظر Gemini. تنهي Vercel Function الطلب إذا تجاوزت الحد الزمني، وتعيد `504` في هذه الحالة. [3]

## 8. وصّل Wassenger وأنفذ اختبارًا حقيقيًا

1. في إعدادات Wassenger، اجعل webhook URL يساوي `https://YOUR_PRODUCTION_DOMAIN/api/wassenger` بعد نجاح Preview.
2. أضف ترويسة `x-webhook-secret` بالقيمة المطابقة لـ `WASSENGER_WEBHOOK_SECRET`، أو اضبط التحقق الموثق الذي يدعمه حسابك.
3. أرسل من رقم اختبار رسالة: `ما هي أوقات مكتب الدعم؟`.
4. ابحث عن `eventId` أو `messageId` في سجلات Wassenger، ثم في Vercel، ثم في سجلات المحرك، ثم في Supabase.
5. يجب أن يسترجع Gemini معلومة مكتب الدعم من صف `knowledge_base`، وأن تصل الرسالة الصادرة إلى رقم الاختبار عبر Wassenger.

تدعم Wassenger webhooks وقتية وإضافة ترويسات مخصصة؛ احتفظ بسر مختلف لكل بيئة ودوّره عند الاشتباه في انكشافه. [5]

## 9. اختبارات لا يجوز تجاوزها

نفّذ الحالات التالية بعد نجاح الرسالة الأولى:

| الاختبار | الإجراء | النتيجة الصحيحة |
| --- | --- | --- |
| منع التكرار | أرسل payload نفسه مرتين بالـ `external_event_id` نفسه. | صف واحد فقط في `webhook_events`؛ لا يُرسل رد ثانٍ. |
| سر محرك خاطئ | استدعِ `wa-engine` بسر مختلف. | `401`، ولا يُنشأ أي صف رسالة أو حدث. |
| سر Vercel خاطئ | استدعِ `/api/wassenger` بسر مختلف. | `401` ولا يمرر الطلب إلى المحرك. |
| Gemini غير متاح | بدّل المفتاح مؤقتًا في بيئة اختبار أو اختبر mock failure. | يسجل المحرك الخطأ ويرسل fallback عربيًا/إنجليزيًا آمنًا؛ لا يسرّب السبب الداخلي للمستخدم. |
| معرفة غير موجودة | اسأل سؤالًا غير موجود في `knowledge_base`. | يوضح البوت أنه لا يملك معلومة مؤكدة ويقترح التواصل مع المعهد؛ لا يخترع جوابًا. |
| مجموعة WhatsApp | أرسل رسالة من مجموعة مع `ENABLE_GROUP_REPLY=false`. | لا يرسل البوت ردًا. |
| PDF صالح | أرسل PDF صغيرًا دون بيانات حساسة. | يوجد صف `documents` بحالة `processed`، ويمكن استخدام النص كسياق. |
| امتداد غير مدعوم أو ملف كبير | أرسل PNG أو ملفًا فوق `MAX_FILE_SIZE`. | رد مفهوم للمستخدم، ولا يحتفظ المحرك بملف غير مقبول. |

## 10. مراقبة وتفسير العطل

أضف `eventId` إلى كل سجل معرّف، واستعمله كمعرّف ترابط بين الأنظمة. لا تطبع `GEMINI_API_KEY` أو `SUPABASE_SERVICE_ROLE_KEY` أو `WASSENGER_API_KEY` أو body كاملًا يحتوي أرقامًا أو مستندات حساسة.

| أول مكان يتوقف فيه الأثر | التشخيص المرجح |
| --- | --- |
| لا يوجد event في Wassenger | إعداد الربط أو الرقم نفسه. |
| يوجد في Wassenger ولا يوجد سجل Vercel | webhook URL أو سر Wassenger -> Vercel. |
| يوجد في Vercel و`engineStatus` ليس 2xx | DNS/TLS أو secret أو صحة `wa-engine`. |
| يوجد في `webhook_events` فقط | خطأ بعد قبول event؛ راجع سجل المحرك. |
| توجد رسالة inbound ولا توجد outbound | Gemini أو Wassenger send API؛ افحص سجل الخطأ وخط حالة Wassenger. |
| توجد outbound في Supabase ولا تصل للهاتف | مشكلة جهاز Wassenger أو حالة الرقم أو API الإرسال. |

## 11. معيار الإطلاق

لا تنقل webhook إلى Production إلا إذا نجحت رسالة نصية ورسالة عربية ورسالة إنجليزية ووثيقة PDF، واختبار منع التكرار، واختبار السر الخاطئ، في Preview مع مشروع Supabase تجريبي. بعد ذلك بدّل قيم Vercel و`wa-engine` إلى أسرار Production، أعد النشر في الطرفين، ثم اختبر برسالة واحدة مراقبة قبل فتح الخدمة للمستخدمين.

## المراجع

[1] [Vercel — Functions](https://vercel.com/docs/functions)  
[2] [Vercel — Environment variables](https://vercel.com/docs/environment-variables)  
[3] [Vercel — Function limits](https://vercel.com/docs/functions/limitations)  
[4] [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)  
[5] [Wassenger Developers — REST API and webhooks](https://wassenger.com/developers)
