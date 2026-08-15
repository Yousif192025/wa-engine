import express from 'express'
import type { BaileysTransport } from './baileys-client'
import type { EngineConfig } from './config'
import { logError } from './utils'

export function createEngineServer(config: EngineConfig, whatsapp: BaileysTransport) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.get('/health', (_request, response) => {
    const status = whatsapp.status()
    response.status(200).json({
      ok: true,
      service: 'wa-engine',
      environment: config.nodeEnv,
      whatsapp: { status: status.status, connected: status.connected },
    })
  })

  app.get('/whatsapp/status', (_request, response) => {
    const status = whatsapp.status()
    response.status(200).json({ status: status.status, connected: status.connected })
  })

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' })
  })

  app.use((error: unknown, _request: express.Request, response: express.Response, next: () => void) => {
    void next
    logError('http_error', error)
    response.status(500).json({ error: 'Internal server error' })
  })

  return app
}
