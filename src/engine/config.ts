import { z } from 'zod'

const booleanFromEnvironment = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const positiveInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(defaultValue)

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  botName: z.string().trim().min(1).max(120).default('مساعد المعهد'),
  defaultLanguage: z.enum(['ar', 'en']).default('ar'),
  enableAi: booleanFromEnvironment.default(true),
  enableGroupReply: booleanFromEnvironment.default(false),
  maxHistoryMessages: positiveInteger(12, 50),
  maxInputCharacters: positiveInteger(5000, 20000),
  maxOutputCharacters: positiveInteger(3000, 8000),
  maxFileSizeBytes: positiveInteger(8 * 1024 * 1024, 25 * 1024 * 1024),
  requestTimeoutMs: positiveInteger(20000, 120000),
  maxRetries: z.coerce.number().int().min(0).max(5).default(2),
  geminiApiKey: z.string().trim().min(1, 'GEMINI_API_KEY is required'),
  geminiModel: z.string().trim().min(1).default('gemini-2.5-flash'),
  supabaseUrl: z.string().url('SUPABASE_URL must be a valid URL'),
  supabaseServiceRoleKey: z.string().trim().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  wassengerApiUrl: z.string().url().default('https://api.wassenger.com/v1'),
  wassengerApiKey: z.string().trim().min(1, 'WASSENGER_API_KEY is required'),
  wassengerDeviceId: z.string().trim().min(1).optional(),
  webhookSharedSecret: z.string().trim().min(16).optional(),
  fallbackMessageAr: z.string().trim().min(1).default('عذرًا، أواجه مشكلة مؤقتة في خدمة الرد الذكي. يرجى المحاولة مرة أخرى لاحقًا.'),
  fallbackMessageEn: z.string().trim().min(1).default('Sorry, I am having a temporary issue with the support service. Please try again later.'),
})

export type EngineConfig = z.infer<typeof configSchema>

export function readEngineConfig(environment: NodeJS.ProcessEnv = process.env): EngineConfig {
  return configSchema.parse({
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    botName: environment.BOT_NAME,
    defaultLanguage: environment.DEFAULT_LANGUAGE,
    enableAi: environment.ENABLE_AI,
    enableGroupReply: environment.ENABLE_GROUP_REPLY,
    maxHistoryMessages: environment.MAX_HISTORY_MESSAGES,
    maxInputCharacters: environment.MAX_INPUT_CHARACTERS,
    maxOutputCharacters: environment.MAX_OUTPUT_CHARACTERS,
    maxFileSizeBytes: environment.MAX_FILE_SIZE,
    requestTimeoutMs: environment.REQUEST_TIMEOUT_MS,
    maxRetries: environment.MAX_RETRIES,
    geminiApiKey: environment.GEMINI_API_KEY,
    geminiModel: environment.GEMINI_MODEL,
    supabaseUrl: environment.SUPABASE_URL,
    supabaseServiceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
    wassengerApiUrl: environment.WASSENGER_API_URL,
    wassengerApiKey: environment.WASSENGER_API_KEY,
    wassengerDeviceId: environment.WASSENGER_DEVICE_ID,
    webhookSharedSecret: environment.WEBHOOK_SHARED_SECRET,
    fallbackMessageAr: environment.FALLBACK_MESSAGE_AR,
    fallbackMessageEn: environment.FALLBACK_MESSAGE_EN,
  })
}

export const supportedDocumentMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

export function fallbackMessage(config: EngineConfig, language: 'ar' | 'en'): string {
  return language === 'ar' ? config.fallbackMessageAr : config.fallbackMessageEn
}
