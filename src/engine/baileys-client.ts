import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeWASocket,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import type { EngineConfig } from './config'
import { BaileysSessionRepository, type WhatsAppConnectionStatus } from './baileys-session-repository'
import { SupabaseAuthState } from './supabase-auth-state'
import { log, logError } from './utils'

interface MinimalBaileysLogger {
  level: string
  child(bindings: Record<string, unknown>): MinimalBaileysLogger
  trace(details: unknown, message?: string): void
  debug(details: unknown, message?: string): void
  info(details: unknown, message?: string): void
  warn(details: unknown, message?: string): void
  error(details: unknown, message?: string): void
}

function createSilentBaileysLogger(): MinimalBaileysLogger {
  const logger: MinimalBaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }

  return logger
}

const silentBaileysLogger = createSilentBaileysLogger()

export interface BaileysTransport {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (message: WAMessage) => Promise<void>): void
  sendText(jid: string, message: string): Promise<string | undefined>
  sendTypingState(jid: string): Promise<void>
  downloadMedia(message: WAMessage): Promise<Buffer>
  status(): {
    status: WhatsAppConnectionStatus
    connected: boolean
    jid?: string
  }
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined

  const output = (error as { output?: { statusCode?: unknown } }).output

  return typeof output?.statusCode === 'number'
    ? output.statusCode
    : undefined
}

function safeDisconnectMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500)

  return 'WhatsApp connection closed'
}

export class BaileysClient implements BaileysTransport {
  private socket: WASocket | undefined
  private messageHandler:
    | ((message: WAMessage) => Promise<void>)
    | undefined

  private reconnectTimer: NodeJS.Timeout | undefined
  private connectingPromise: Promise<void> | undefined

  private credentialsPersistQueue: Promise<void> = Promise.resolve()

  private stopped = false
  private connectionStatus: WhatsAppConnectionStatus = 'disconnected'
  private connectedJid: string | undefined

  private pairingCodeRequested = false

  constructor(
    private readonly config: EngineConfig,
    private readonly authState: SupabaseAuthState,
    private readonly sessionRepository: BaileysSessionRepository,
  ) {}

  onMessage(handler: (message: WAMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    this.stopped = false

    try {
      await this.connect()
    } catch (error) {
      this.connectionStatus = 'error'

      logError('whatsapp_initial_connection_failed', error)

      this.scheduleReconnect()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = undefined

    this.socket?.end(new Error('wa-engine shutdown'))
    this.socket = undefined

    this.connectionStatus = 'disconnected'

    this.sessionRepository
      .saveConnectionState({
        status: 'disconnected',
        disconnected: true,
      })
      .catch((error) => {
        logError('whatsapp_connection_state_save_failed', error)
      })
  }

  status(): {
    status: WhatsAppConnectionStatus
    connected: boolean
    jid?: string
  } {
    return {
      status: this.connectionStatus,
      connected: this.connectionStatus === 'connected',
      jid: this.connectedJid,
    }
  }

  async sendText(
    jid: string,
    message: string,
  ): Promise<string | undefined> {
    const socket = this.requireConnectedSocket()

    const result = await socket.sendMessage(jid, {
      text: message,
    })

    return result?.key.id ?? undefined
  }

  async sendTypingState(jid: string): Promise<void> {
    const socket = this.requireConnectedSocket()

    await socket.sendPresenceUpdate('composing', jid)

    setTimeout(() => {
      socket
        .sendPresenceUpdate('paused', jid)
        .catch((error) => {
          logError('whatsapp_typing_state_failed', error, { jid })
        })
    }, 2_000).unref()
  }

  async downloadMedia(message: WAMessage): Promise<Buffer> {
    const socket = this.requireConnectedSocket()

    return downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        reuploadRequest: socket.updateMediaMessage,
        logger: silentBaileysLogger,
      },
    ) as Promise<Buffer>
  }

  private async connect(): Promise<void> {
    if (this.stopped) return

    if (this.connectingPromise) {
      return this.connectingPromise
    }

    const pending = this.connectInternal()

    this.connectingPromise = pending

    try {
      await pending
    } finally {
      if (this.connectingPromise === pending) {
        this.connectingPromise = undefined
      }
    }
  }

  private async connectInternal(): Promise<void> {
    if (this.stopped) return

    await this.credentialsPersistQueue

    this.connectionStatus = 'connecting'

    await this.sessionRepository.saveConnectionState({
      status: 'connecting',
    })

    log('whatsapp_connecting')

    let auth

    try {
      auth = await this.authState.load()
    } catch (error) {
      logError('whatsapp_auth_state_load_failed', error)

      throw new Error(
        `Failed to load WhatsApp auth state: ${
          error instanceof Error
            ? error.message
            : 'Unknown error'
        }`,
      )
    }

    const hasExistingCreds =
      auth.creds.me?.id !== undefined

    /*
     * Always resolve this expression to a real boolean.
     *
     * This avoids TypeScript inferring:
     * string | boolean | undefined
     *
     * Pairing Code is used only when:
     * 1. BAILEYS_USE_PAIRING_CODE is enabled
     * 2. A phone number is configured
     * 3. There are no existing WhatsApp credentials
     */
    const shouldUsePairingCode: boolean =
      this.config.baileysUsePairingCode === true &&
      typeof this.config.baileysPhoneNumber === 'string' &&
      this.config.baileysPhoneNumber.length > 0 &&
      !hasExistingCreds

    const socket = makeWASocket({
      auth,
      browser: Browsers.ubuntu('wa-engine'),
      logger: silentBaileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    })

    this.socket = socket

    socket.ev.on('creds.update', () => {
      this.queueCredentialsSave(socket)
    })

    socket.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(
        socket,
        update,
        shouldUsePairingCode,
      )
    })

    socket.ev.on(
      'messages.upsert',
      ({ type, messages }) => {
        log('whatsapp_messages_upsert', {
          type,
          count: messages.length,
          isCurrentSocket: socket === this.socket,
        })

        if (
          socket !== this.socket ||
          type !== 'notify'
        ) {
          return
        }

        for (const message of messages) {
          if (
            message.key.fromMe ||
            !message.key.remoteJid ||
            message.key.remoteJid === 'status@broadcast'
          ) {
            continue
          }

          this.handleInboundMessage(message)
        }
      },
    )
  }

  private async handleConnectionUpdate(
    socket: WASocket,
    update: {
      connection?: 'connecting' | 'open' | 'close'
      lastDisconnect?: {
        error?: Error
      }
      qr?: string
    },
    shouldUsePairingCode: boolean,
  ): Promise<void> {
    if (socket !== this.socket) {
      log(
        'whatsapp_stale_connection_update_ignored',
        {
          connection:
            update.connection ?? 'unknown',
        },
      )

      return
    }

    /*
     * Request WhatsApp Pairing Code for a fresh session.
     */
    if (
      shouldUsePairingCode &&
      !this.pairingCodeRequested
    ) {
      this.pairingCodeRequested = true

      try {
        log(
          'whatsapp_pairing_code_requested',
          {
            phoneNumber: '[redacted]',
          },
        )

        const pairingCode =
          await socket.requestPairingCode(
            this.config.baileysPhoneNumber!,
          )

        log('whatsapp_pairing_code_generated')

        process.stdout.write('\n')
        process.stdout.write(
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
        )
        process.stdout.write(
          'WhatsApp Pairing Code\n',
        )
        process.stdout.write(
          `${pairingCode}\n`,
        )
        process.stdout.write(
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n',
        )
        process.stdout.write('\n')

        process.stdout.write(
          'Open WhatsApp on your phone:\n',
        )

        process.stdout.write(
          '  Linked Devices → Link a Device → Link with phone number instead\n',
        )

        process.stdout.write(
          'Enter the code above on your phone.\n',
        )

        process.stdout.write('\n')
      } catch (error) {
        logError(
          'whatsapp_pairing_code_failed',
          error,
        )

        this.pairingCodeRequested = false
      }
    }

    /*
     * QR fallback.
     *
     * QR is displayed only when Pairing Code mode
     * is not enabled.
     */
    if (
      update.qr &&
      !shouldUsePairingCode
    ) {
      this.connectionStatus = 'qr_pending'

      await this.sessionRepository.saveConnectionState(
        {
          status: 'qr_pending',
          qrGenerated: true,
        },
      )

      log('whatsapp_qr_generated')

      try {
        const terminalQr =
          await QRCode.toString(
            update.qr,
            {
              type: 'terminal',
              small: true,
            },
          )

        process.stdout.write(
          `${terminalQr}\n`,
        )
      } catch (error) {
        logError(
          'whatsapp_qr_render_failed',
          error,
        )
      }
    }

    if (update.connection === 'open') {
      this.connectionStatus = 'connected'

      this.connectedJid = socket.user?.id

      await this.sessionRepository.saveConnectionState(
        {
          status: 'connected',
          connected: true,
          connectedJid: this.connectedJid,
        },
      )

      log(
        'whatsapp_authenticated',
        {
          jid: this.connectedJid,
        },
      )

      return
    }

    if (update.connection !== 'close') {
      return
    }

    const statusCode =
      disconnectStatusCode(
        update.lastDisconnect?.error,
      )

    const loggedOut =
      statusCode === DisconnectReason.loggedOut

    const errorMessage =
      safeDisconnectMessage(
        update.lastDisconnect?.error,
      )

    this.socket = undefined
    this.connectedJid = undefined

    this.pairingCodeRequested = false

    if (loggedOut) {
      this.connectionStatus = 'logged_out'

      await this.sessionRepository.clearAuthState()

      await this.sessionRepository.saveConnectionState(
        {
          status: 'logged_out',
          disconnected: true,
          lastError:
            'WhatsApp logged out; scan a new QR code to reconnect.',
        },
      )

      log('whatsapp_logged_out')

      return
    }

    this.connectionStatus = 'disconnected'

    await this.sessionRepository.saveConnectionState(
      {
        status: 'disconnected',
        disconnected: true,
        lastError: errorMessage,
      },
    )

    log(
      'whatsapp_disconnected',
      {
        statusCode,
      },
    )

    this.scheduleReconnect()
  }

  private queueCredentialsSave(
    socket: WASocket,
  ): void {
    this.credentialsPersistQueue =
      this.credentialsPersistQueue
        .catch(() => undefined)
        .then(async () => {
          if (this.socket !== socket) {
            return
          }

          await this.authState.saveCreds(
            socket.authState.creds,
          )
        })

    this.credentialsPersistQueue.catch(
      (error) => {
        logError(
          'whatsapp_auth_state_save_failed',
          error,
        )
      },
    )
  }

  private handleInboundMessage(
    message: WAMessage,
  ): void {
    if (!this.messageHandler) {
      return
    }

    log(
      'whatsapp_message_received',
      {
        messageId: message.key.id,
        chat: message.key.remoteJid,
      },
    )

    this.messageHandler(message).catch(
      (error) => {
        logError(
          'whatsapp_message_processing_failed',
          error,
          {
            messageId: message.key.id,
          },
        )
      },
    )
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.reconnectTimer
    ) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined

      this.connect().catch((error) => {
        logError(
          'whatsapp_reconnect_failed',
          error,
        )

        this.scheduleReconnect()
      })
    }, this.config.baileysReconnectDelayMs)

    this.reconnectTimer.unref()
  }

  private requireConnectedSocket(): WASocket {
    if (
      !this.socket ||
      this.connectionStatus !== 'connected'
    ) {
      throw new Error(
        'WhatsApp is not connected',
      )
    }

    return this.socket
  }
}
