import { z } from 'zod'

const booleanFromEnvironment = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const positiveInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(defaultValue)

const e164PhoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{1,14}$/, 'Must be a valid E.164 phone number')
  .optional()

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
  baileysAccountId: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('default'),
  baileysAuthEncryptionKey: z.string().trim().min(1, 'BAILEYS_AUTH_ENCRYPTION_KEY is required'),
  baileysReconnectDelayMs: positiveInteger(5000, 60000),
  baileysProxyAddress: z.string().trim().optional(),
  baileysForceRefreshQr: booleanFromEnvironment.default(false),
  baileysUsePairingCode: booleanFromEnvironment.default(false),
  baileysPhoneNumber: e164PhoneNumber,
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
    baileysAccountId: environment.BAILEYS_ACCOUNT_ID,
    baileysAuthEncryptionKey: environment.BAILEYS_AUTH_ENCRYPTION_KEY,
    baileysReconnectDelayMs: environment.BAILEYS_RECONNECT_DELAY_MS,
    baileysProxyAddress: environment.BAILEYS_PROXY_ADDRESS,
    baileysForceRefreshQr: environment.BAILEYS_FORCE_REFRESH_QR,
    baileysUsePairingCode: environment.BAILEYS_USE_PAIRING_CODE,
    baileysPhoneNumber: environment.BAILEYS_PHONE_NUMBER,
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
