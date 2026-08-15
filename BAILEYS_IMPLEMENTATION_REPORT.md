# تقرير تحويل `wa-engine` إلى Baileys

**الفرع:** `baileys-supabase-session`  
**الأساس:** `origin/main` عند الالتزام `47781f4`  
**نطاق التحويل:** استبدال مسار Wassenger وVercel Relay بمحرك WhatsApp مباشر يعتمد `@whiskeysockets/baileys@6.7.24`، مع الحفاظ على Gemini وذاكرة Supabase وقاعدة المعرفة ومعالجة المستندات.

## النتيجة

اكتمل التحويل البرمجي على فرع مستقل ولم يُدمج في `main`. يفتح المحرك الآن اتصال Baileys طويل التشغيل، ويطبع QR محليًا عند غياب جلسة، ويحفظ الاعتماد وSignal keys في Supabase بعد تشفير AES-256-GCM محلي. بقيت طبقات Gemini، والذاكرة، والبحث النصي في المعرفة، ومنع التكرار، والتحقق من المستندات مدمجة في المسار نفسه.

| المجال | النتيجة |
| --- | --- |
| WhatsApp transport | Baileys 6.7.24 مباشر، ولا يبقى مسار تشغيل يعتمد Wassenger. |
| جلسة WhatsApp | تخزين مشفر في Supabase عبر `whatsapp_auth_state`. |
| حالة الاتصال | تخزين غير حساس في `whatsapp_connection_state` وقراءتها من `/health`. |
| الذكاء والذاكرة | Gemini 2.5 Flash والذاكرة وقاعدة المعرفة الحالية محفوظة. |
| الرسائل والملفات | رسائل نصية مباشرة وPDF/DOC/DOCX عبر تنزيل Baileys مع فحوص الحجم والتوقيع. |
| Redis أو Vercel Relay | غير مستخدمين؛ حُذفت طبقة Relay الخاصة بالويبهوك. |

## الملفات المعدلة والمضافة والمحذوفة

| التصنيف | العناصر | الغرض |
| --- | --- | --- |
| معدلة | `src/engine/config.ts`, `index.ts`, `processor.ts`, `documents.ts`, `server.ts`, `types.ts`, `package.json`, `pnpm-workspace.yaml`, `.env.example`, `README.md`, `BOT_ENGINE.md`, `eslint.config.mjs` | إعادة توصيل المحرك إلى Baileys وتحديث البناء والإعدادات والتوثيق. |
| مضافة | `auth-crypto.ts`, `baileys-client.ts`, `baileys-session-repository.ts`, `supabase-auth-state.ts` | التشفير، الاتصال، تخزين الجلسة، واستعادة Signal auth state. |
| مضافة | `20260815_002_baileys_session_state.sql`, ملف rollback، `render.yaml`, `SUPABASE_BAILEYS_MIGRATION_PREVIEW.md` | الترحيل المعتمد، التراجع اليدوي، والنشر. |
| محدثة | `tests/engine.test.ts` | اختبارات Baileys والتشفير وحفظ creds وSignal keys. |
| محذوفة | `src/engine/wassenger.ts`, `src/vercel-relay.ts`, `app/api/wassenger/route.ts`, اختبار Relay، والملفات التراثية غير المستدعاة | إزالة كود Wassenger وVercel Relay القديم من المسار الحالي. |
| محذوفة | تقارير وأدلة Wassenger القديمة | منع بقاء تعليمات تشغيل متقادمة أو مضللة. |

## الاعتماديات

أضيفت التبعية المباشرة المقيدة التالية:

```text
@whiskeysockets/baileys@6.7.24
```

احتاج الإصدار المستقر إلى تبعية Git رسمية واحدة فقط هي `WhiskeySockets/libsignal-node`. استُخدم استثناء لمرة واحدة أثناء التثبيت، ثم روجع ملف القفل. المرجع الوحيد من Git في `pnpm-lock.yaml` يثبت `libsignal` إلى commit محدد. لم تُضف أي تبعية Git أخرى. وحُظر نص `prepare` الخاص بالحزمة صراحةً في `pnpm-workspace.yaml` لأن النشر يتضمن ملفات `lib` المترجمة؛ لم يُشغّل نص مصدر Baileys.

| العنصر | القرار |
| --- | --- |
| نسخة Baileys | `6.7.24` مثبتة حرفيًا، وليست `latest` أو إصدار RC. |
| Node.js | النطاق `>=20 <23` في `package.json`، وصورة Docker تستخدم Node 22. |
| Wasenger dependencies | لا توجد متغيرات تشغيل أو طبقات نقل Wassenger في المصدر أو الوثائق الحالية. |
| أسرار | لا توجد قيم حقيقية في الملفات أو الحزمة. |

## الترحيل المعتمد

يضيف `supabase/migrations/20260815_002_baileys_session_state.sql` **جدولين فقط**، ولا يغير أو يحذف أي جدول موجود.

| الجدول | الغرض | الحماية |
| --- | --- | --- |
| `whatsapp_auth_state` | `creds` وSignal keys بعد تشفير AES-256-GCM داخل المحرك. | RLS مفعّل بلا سياسات عامة؛ قيمة مفتاح التشفير خارج Supabase وGit. |
| `whatsapp_connection_state` | حالة غير حساسة مثل الاتصال أو انتظار QR ووقت آخر اتصال. | RLS مفعّل بلا سياسات عامة؛ لا QR ولا مفتاح جلسة ولا access token. |

طبّق الترحيلين بالترتيب التالي في Supabase، ولا تشغّل ملف rollback إلا عند الحاجة إلى إزالة الجداول الجديدة وحالة المصادقة المرتبطة بها:

```text
supabase/migrations/20260815_001_bot_engine.sql
supabase/migrations/20260815_002_baileys_session_state.sql
supabase/rollbacks/20260815_002_baileys_session_state.down.sql
```

## متغيرات البيئة ونقاط API

يتطلب المسار الجديد المتغيرات الأساسية التالية فقط: `NODE_ENV`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, و`BAILEYS_AUTH_ENCRYPTION_KEY`. يعرض `.env.example` جميع الحدود الاختيارية. يجب أن تكون قيمة `BAILEYS_AUTH_ENCRYPTION_KEY` base64 بطول 32 بايت وتبقى في مدير أسرار بيئة التشغيل فقط.

لا توجد نقطة webhook بعد التحويل. نقاط HTTP المتبقية هي:

| endpoint | الغرض | البيانات المعروضة |
| --- | --- | --- |
| `GET /health` | صحة العملية لخدمة الاستضافة | صحة HTTP وحالة اتصال WhatsApp فقط. |
| `GET /whatsapp/status` | فحص اتصال تشغيلي بسيط | `status` و`connected` فقط. |

## التشغيل محليًا وRender

```bash
pnpm install
pnpm run bot:build
pnpm run bot:start
curl -i http://127.0.0.1:8080/health
```

في أول تشغيل فعلي يظهر QR في طرفية المحرك. امسحه من **WhatsApp > الأجهزة المرتبطة > ربط جهاز**. تحفظ Baileys التغييرات اللاحقة في الجلسة بشكل مشفر، لذلك يجب أن تستعيد الخدمة نفس الجلسة بعد إعادة التشغيل ما لم يسجل الحساب خروجًا أو يتغير مفتاح التشفير.

| إعداد Render | القيمة |
| --- | --- |
| Build Command | `pnpm install --frozen-lockfile && pnpm run bot:build` |
| Start Command | `pnpm run bot:start` |
| Health Check | `/health` |
| الملف | `render.yaml` |

> **قيد مهم:** Render Free يصلح لاختبار QR والبناء والاستعادة، لكنه ليس بيئة إنتاجية موثوقة لاتصال Baileys مباشر؛ توقف الخدمة بعد الخمول يقطع WebSocket. احتفظ بحالة الجلسة في Supabase، لكن استخدم عملية Node.js دائمة للإنتاج. [2]

## نتائج الاختبارات

| الاختبار | النتيجة | الملاحظة |
| --- | --- | --- |
| تثبيت مقفل `pnpm install --frozen-lockfile` | PASS | انتهى بنجاح مع ملف القفل الحالي. |
| فحص TypeScript للمحرك | PASS | `pnpm run bot:typecheck`. |
| اختبارات الوحدة | PASS | 7/7؛ التشفير، فك التشفير، creds، Signal key، التطبيع، اللغة، وسياق Gemini. |
| بناء المحرك | PASS | `pnpm run bot:build`. |
| بناء Next.js | PASS | بمتغيري Clerk شكليين فقط؛ توجد تحذيرات واجهة قديمة غير حاجبة. |
| lint | PASS مع تحذيرات | صفر أخطاء؛ 63 تحذيرًا قائمًا مسبقًا في واجهة Next.js. |
| تدقيق إنتاجي للاعتماديات | PASS | `pnpm audit --prod --json` انتهى برمز نجاح. |
| `GET /health` | PASS | استجاب المحرك في بيئة تجريبية بلا أسرار حقيقية. |
| Docker image | NOT TESTED | Docker غير متوفر في بيئة التحقق. |
| تطبيق ترحيل Supabase فعليًا | NOT TESTED | لم تتوفر بيانات مشروع Supabase حقيقي؛ أُضيف ملف الترحيل المعتمد ولم يُنفذ عن بعد. |
| حفظ واسترجاع Supabase فعليًا | NOT TESTED | اختُبرت عقدة المخزن محليًا؛ الاختبار الحي يحتاج الترحيل ومفتاح خدمة حقيقي. |
| QR وربط WhatsApp | NOT TESTED | يتطلب مسح QR من حساب WhatsApp يملكه المستخدم. |
| استلام رسالة وإرسال رد | NOT TESTED | يتطلب حساب WhatsApp متصلًا ومفاتيح Supabase وGemini حقيقية. |
| Gemini حي | NOT TESTED | يتطلب مفتاح Gemini حقيقيًا. |
| PDF/DOCX حي | NOT TESTED | يتطلب إرسال ملف عبر حساب WhatsApp المتصل. |
| استعادة session بعد restart | NOT TESTED | يتطلب اكتمال اختبار Supabase وQR الحقيقيين. |

لا توجد نتيجة PASS مصطنعة لأي خدمة خارجية. استخدم قائمة الاختبار في `BOT_ENGINE.md` بعد ضبط البيئة الحقيقية؛ عندها يجب التحقق من الرسالة العربية والإنجليزية والذاكرة والملفات ثم إعادة تشغيل الخدمة لتأكيد استعادة الجلسة دون QR جديد.

## المراجع

[1] [Baileys — الحزمة الرسمية المجتمعية](https://www.npmjs.com/package/@whiskeysockets/baileys)
[2] [Render — الخدمات المجانية والخمول](https://render.com/docs/free)
[3] [Render — Health Checks](https://render.com/docs/health-checks)
[4] [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
