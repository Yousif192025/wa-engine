import 'dotenv/config'
import { readEngineConfig } from './config'
import { DocumentProcessor } from './documents'
import { GeminiSupportService } from './gemini'
import { MessageProcessor } from './processor'
import { BotRepository } from './repository'
import { createEngineServer } from './server'
import { log, logError } from './utils'
import { WassengerClient } from './wassenger'

async function main(): Promise<void> {
  const config = readEngineConfig()
  if (config.nodeEnv === 'production' && !config.webhookSharedSecret) {
    throw new Error('WEBHOOK_SHARED_SECRET is required in production')
  }

  const repository = new BotRepository(config)
  const processor = new MessageProcessor(
    config,
    repository,
    new GeminiSupportService(config),
    new WassengerClient(config),
    new DocumentProcessor(config),
  )
  const app = createEngineServer(config, processor)
  const server = app.listen(config.port, () => {
    log('engine_started', { port: config.port, environment: config.nodeEnv, model: config.geminiModel })
  })

  const shutdown = (signal: string) => {
    log('engine_shutdown_started', { signal })
    server.close((error) => {
      if (error) {
        logError('engine_shutdown_failed', error)
        process.exitCode = 1
      }
      process.exit()
    })
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  logError('engine_startup_failed', error)
  process.exitCode = 1
})
