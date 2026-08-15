import type { EngineConfig } from './config'
import { withRetries, withTimeout } from './utils'

export class WassengerClient {
  constructor(private readonly config: EngineConfig) {}

  async sendText(input: { phoneNumber: string; message: string; deviceId?: string }): Promise<string | undefined> {
    const response = await withRetries(
      () => withTimeout(
        fetch(new URL('messages', `${this.config.wassengerApiUrl.replace(/\/$/, '')}/`), {
          method: 'POST',
          headers: {
            Token: this.config.wassengerApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            phone: input.phoneNumber,
            message: input.message,
            device: input.deviceId ?? this.config.wassengerDeviceId,
            enqueue: 'never',
          }),
        }),
        this.config.requestTimeoutMs,
        'Wassenger send message',
      ),
      this.config.maxRetries,
      'Wassenger send message',
    )

    if (!response.ok) throw new Error(`Wassenger send failed: HTTP ${response.status}`)
    const body = (await response.json().catch(() => ({}))) as { id?: string; waId?: string }
    return body.id ?? body.waId
  }

  async sendTypingState(input: { deviceId?: string; chat: string }): Promise<void> {
    const deviceId = input.deviceId ?? this.config.wassengerDeviceId
    if (!deviceId) return
    const response = await withTimeout(
      fetch(new URL(`chat/${encodeURIComponent(deviceId)}/typing`, `${this.config.wassengerApiUrl.replace(/\/$/, '')}/`), {
        method: 'POST',
        headers: {
          Token: this.config.wassengerApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'typing', duration: 10, chat: input.chat }),
      }),
      this.config.requestTimeoutMs,
      'Wassenger typing state',
    )
    if (!response.ok) throw new Error(`Wassenger typing state failed: HTTP ${response.status}`)
  }
}
