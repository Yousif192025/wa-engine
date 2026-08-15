export type SupportedLanguage = 'ar' | 'en'

const arabicScript = /[\u0600-\u06FF]/
const unsafeControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function detectLanguage(text: string, fallback: SupportedLanguage): SupportedLanguage {
  return arabicScript.test(text) ? 'ar' : fallback
}

export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(unsafeControlCharacters, '').trim().slice(0, maxLength)
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !/(key|token|secret|authorization|password)/i.test(key)),
  )
  console.info(JSON.stringify({ level: 'info', event, at: new Date().toISOString(), ...safeDetails }))
}

export function logError(event: string, error: unknown, details: Record<string, unknown> = {}): void {
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !/(key|token|secret|authorization|password)/i.test(key)),
  )
  console.error(JSON.stringify({ level: 'error', event, at: new Date().toISOString(), error: toErrorMessage(error), ...safeDetails }))
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function withRetries<T>(
  operation: () => Promise<T>,
  retries: number,
  label: string,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === retries) break
      const delayMs = Math.min(1000 * 2 ** attempt, 4000)
      log('retry_scheduled', { label, attempt: attempt + 1, delayMs })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`)
}

export function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}
