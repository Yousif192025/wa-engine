import express, { type Request, type Response } from 'express'
import type { EngineConfig } from './config'
import type { MessageProcessor } from './processor'
import type { WassengerWebhook } from './types'
import { constantTimeEqual, log, logError } from './utils'

function createRateLimiter(limit: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (request: Request, response: Response, next: () => void) => {
    const key = request.ip || 'unknown'
    const now = Date.now()
    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }
    bucket.count += 1
    if (bucket.count > limit) {
      response.status(429).json({ error: 'Too many requests' })
      return
    }
    next()
  }
}

export function createEngineServer(config: EngineConfig, processor: MessageProcessor) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '1mb', strict: true }))

  app.get('/health', (_request, response) => {
    response.status(200).json({ ok: true, service: 'wa-engine', environment: config.nodeEnv })
  })

  app.post('/webhooks/wassenger', createRateLimiter(120, 60_000), (request, response) => {
    if (config.webhookSharedSecret) {
      const providedSecret = request.header('x-webhook-secret')
      if (!constantTimeEqual(providedSecret, config.webhookSharedSecret)) {
        log('webhook_auth_rejected', { ip: request.ip })
        response.status(401).json({ error: 'Unauthorized webhook' })
        return
      }
    }

    const webhook = request.body as WassengerWebhook
    if (!webhook || typeof webhook !== 'object' || !webhook.event || !webhook.data) {
      response.status(400).json({ error: 'Invalid webhook payload' })
      return
    }

    response.status(202).json({ accepted: true })
    processor.process(webhook).catch((error) => {
      logError('unhandled_webhook_processing_error', error, { event: webhook.event })
    })
  })

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' })
  })

  app.use((error: unknown, _request: Request, response: Response, next: () => void) => {
    void next
    logError('http_error', error)
    response.status(500).json({ error: 'Internal server error' })
  })

  return app
}
