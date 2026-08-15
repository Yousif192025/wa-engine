import 'dotenv/config'
import { BaileysAuthCipher } from './auth-crypto'
import { BaileysClient } from './baileys-client'
import { BaileysSessionRepository } from './baileys-session-repository'
import { readEngineConfig } from './config'
import { DocumentProcessor } from './documents'
import { GeminiSupportService } from './gemini'
import { MessageProcessor } from './processor'
import { BotRepository } from './repository'
import { createEngineServer } from './server'
import { SupabaseAuthState } from './supabase-auth-state'
import { log, logError } from './utils'

async function main(): Promise<void> {
  const config = readEngineConfig()
  const repository = new BotRepository(config)
  const sessionRepository = new BaileysSessionRepository(config)
  const authState = new SupabaseAuthState(
    sessionRepository,
    new BaileysAuthCipher(config.baileysAuthEncryptionKey),
  )
  const whatsapp = new BaileysClient(config, authState, sessionRepository)
  const processor = new MessageProcessor(
    config,
    repository,
    new GeminiSupportService(config),
    whatsapp,
    new DocumentProcessor(config),
  )
  whatsapp.onMessage(async (message) => {
    await processor.process(message)
  })

  const app = createEngineServer(config, whatsapp)
  const server = app.listen(config.port, () => {
    log('engine_started', { port: config.port, environment: config.nodeEnv, model: config.geminiModel })
  })

  whatsapp.start().catch((error) => {
    logError('whatsapp_initial_connection_failed', error)
  })

  const shutdown = (signal: string) => {
    log('engine_shutdown_started', { signal })
    void whatsapp.stop()
      .catch((error) => logError('whatsapp_shutdown_failed', error))
      .finally(() => {
        server.close((error) => {
          if (error) {
            logError('engine_shutdown_failed', error)
            process.exitCode = 1
          }
          process.exit()
        })
      })
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  logError('engine_startup_failed', error)
  process.exitCode = 1
})
