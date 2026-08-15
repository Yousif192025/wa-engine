import type { WAMessage } from '@whiskeysockets/baileys'
import type { BaileysTransport } from './baileys-client'
import type { EngineConfig } from './config'
import { fallbackMessage } from './config'
import { DocumentProcessor } from './documents'
import type { GeminiGenerator } from './gemini'
import { BotRepository } from './repository'
import type { MessageType, NormalizedInboundMessage, ProcessResult } from './types'
import { cleanText, detectLanguage, log, logError, type SupportedLanguage } from './utils'

function messageType(message: WAMessage): MessageType {
  const content = message.message
  if (!content) return 'unsupported'
  if (content.documentMessage) return 'document'
  if (content.conversation || content.extendedTextMessage) return 'text'
  if (content.imageMessage) return 'image'
  if (content.audioMessage) return 'audio'
  return 'unsupported'
}

function messageBody(message: WAMessage): string | undefined {
  const content = message.message
  return content?.conversation
    ?? content?.extendedTextMessage?.text
    ?? content?.documentMessage?.caption
    ?? content?.imageMessage?.caption
    ?? undefined
}

function messageTimestamp(value: unknown): string {
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString()
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return new Date(value.toNumber() * 1000).toISOString()
  }
  return new Date().toISOString()
}

function userIdentifier(jid: string | undefined): string {
  return (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

export function normalizeBaileysMessage(message: WAMessage, maxCharacters: number): NormalizedInboundMessage {
  const remoteJid = message.key.remoteJid
  const messageId = message.key.id
  if (message.key.fromMe) throw new Error('Ignoring message sent by this WhatsApp account')
  if (!remoteJid || !messageId) throw new Error('Baileys message is missing remote JID or message ID')
  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) throw new Error('Unsupported broadcast message')

  const isGroup = remoteJid.endsWith('@g.us')
  const senderJid = isGroup ? message.key.participant : remoteJid
  const phoneNumber = userIdentifier(senderJid ?? undefined)
  if (!phoneNumber || phoneNumber.length < 6 || phoneNumber.length > 20) {
    throw new Error('Baileys message sender is not a supported phone identifier')
  }

  const type = messageType(message)
  const document = message.message?.documentMessage
  return {
    eventId: messageId,
    externalMessageId: messageId,
    conversationExternalId: remoteJid,
    phoneNumber,
    displayName: cleanText(message.pushName, 120) || undefined,
    isGroup,
    type,
    body: cleanText(messageBody(message), maxCharacters),
    timestamp: messageTimestamp(message.messageTimestamp),
    media: document
      ? {
          mimeType: document.mimetype,
          filename: document.fileName,
          size: document.fileLength,
        }
      : undefined,
    raw: message,
  }
}

function documentFailureMessage(language: SupportedLanguage): string {
  return language === 'ar'
    ? 'عذرًا، لم أتمكن من قراءة هذا الملف. يرجى إرسال ملف PDF أو DOC أو DOCX صالح بحجم مدعوم.'
    : 'Sorry, I could not read this file. Please send a valid PDF, DOC, or DOCX within the supported size limit.'
}

function emptyMessageReply(language: SupportedLanguage): string {
  return language === 'ar'
    ? 'يرجى إرسال سؤالك نصًا أو إرفاق ملف PDF أو DOC أو DOCX مدعوم.'
    : 'Please send your question as text or attach a supported PDF, DOC, or DOCX file.'
}

function aiDisabledReply(language: SupportedLanguage): string {
  return language === 'ar'
    ? 'خدمة الرد الذكي غير مفعلة حاليًا. يرجى التواصل مع المعهد مباشرة.'
    : 'The AI reply service is currently disabled. Please contact the institute directly.'
}

export class MessageProcessor {
  constructor(
    private readonly config: EngineConfig,
    private readonly repository: BotRepository,
    private readonly gemini: GeminiGenerator,
    private readonly whatsapp: BaileysTransport,
    private readonly documents: DocumentProcessor,
  ) {}

  async process(message: WAMessage): Promise<ProcessResult> {
    let inbound: NormalizedInboundMessage
    try {
      inbound = normalizeBaileysMessage(message, this.config.maxInputCharacters)
    } catch (error) {
      logError('whatsapp_message_rejected', error)
      return { accepted: false, reason: 'invalid_message' }
    }

    if (inbound.isGroup && !this.config.enableGroupReply) {
      return { accepted: true, reason: 'groups_disabled' }
    }
    if (inbound.type === 'unsupported') {
      return { accepted: true, reason: 'unsupported_message_type' }
    }

    let claimed = false
    let language: SupportedLanguage = detectLanguage(inbound.body, this.config.defaultLanguage)
    try {
      claimed = await this.repository.claimWebhookEvent(inbound.eventId, 'baileys_message')
      if (!claimed) return { accepted: true, duplicate: true, reason: 'duplicate_event' }

      const existingConversation = await this.repository.findConversation(inbound.conversationExternalId)
      language = detectLanguage(inbound.body, existingConversation?.language ?? this.config.defaultLanguage)
      const user = await this.repository.getOrCreateUser(inbound.phoneNumber, inbound.displayName)
      const conversation = await this.repository.getOrCreateConversation(user.id, inbound.conversationExternalId, language)

      let messageContent = inbound.body
      let documentText: string | undefined
      if (inbound.type === 'document') {
        try {
          const extracted = await this.documents.downloadAndExtract(inbound.raw, (source) => this.whatsapp.downloadMedia(source))
          documentText = extracted.text
          await this.repository.saveDocument({
            userId: user.id,
            conversationId: conversation.id,
            externalMediaId: inbound.externalMessageId,
            filename: extracted.filename,
            mimeType: extracted.mimeType,
            sizeBytes: extracted.sizeBytes,
            extractedText: documentText,
          })
          messageContent = cleanText([inbound.body, documentText].filter(Boolean).join('\n\n'), this.config.maxInputCharacters)
        } catch (error) {
          logError('document_processing_failed', error, { eventId: inbound.eventId })
          await this.repository.saveMessage({
            conversationId: conversation.id,
            externalMessageId: inbound.externalMessageId,
            direction: 'inbound',
            type: inbound.type,
            content: inbound.body || '[document could not be processed]',
            language,
            metadata: { document_processing: 'failed' },
          })
          await this.sendAndStore(conversation.id, inbound, language, documentFailureMessage(language))
          await this.repository.completeWebhookEvent(inbound.eventId, 'completed')
          return { accepted: true, reason: 'document_rejected' }
        }
      }

      await this.repository.saveMessage({
        conversationId: conversation.id,
        externalMessageId: inbound.externalMessageId,
        direction: 'inbound',
        type: inbound.type,
        content: messageContent || `[${inbound.type}]`,
        language,
        metadata: { timestamp: inbound.timestamp, has_media: Boolean(inbound.media) },
      })

      if (!messageContent) {
        await this.sendAndStore(conversation.id, inbound, language, emptyMessageReply(language))
        await this.repository.completeWebhookEvent(inbound.eventId, 'completed')
        return { accepted: true, reason: 'empty_message' }
      }

      this.whatsapp.sendTypingState(inbound.conversationExternalId)
        .catch((error) => logError('typing_state_failed', error, { eventId: inbound.eventId }))

      const answer = this.config.enableAi
        ? await this.generateReply(conversation.id, conversation.summary, language, messageContent, documentText)
        : aiDisabledReply(language)

      await this.sendAndStore(conversation.id, inbound, language, answer)
      await this.repository.completeWebhookEvent(inbound.eventId, 'completed')
      log('message_processed', { eventId: inbound.eventId, messageType: inbound.type })
      return { accepted: true }
    } catch (error) {
      logError('message_processing_failed', error, { eventId: inbound.eventId })
      try {
        await this.whatsapp.sendText(inbound.conversationExternalId, fallbackMessage(this.config, language))
      } catch (sendError) {
        logError('fallback_send_failed', sendError, { eventId: inbound.eventId })
      }
      if (claimed) {
        await this.repository.completeWebhookEvent(inbound.eventId, 'failed', error instanceof Error ? error.message : 'Unknown error')
          .catch((completionError) => logError('event_completion_failed', completionError, { eventId: inbound.eventId }))
      }
      return { accepted: false, reason: 'processing_failed' }
    }
  }

  private async generateReply(
    conversationId: string,
    summary: string | null | undefined,
    language: SupportedLanguage,
    message: string,
    documentText?: string,
  ): Promise<string> {
    const [history, knowledge] = await Promise.all([
      this.repository.recentMessages(conversationId, this.config.maxHistoryMessages),
      this.repository.searchKnowledge(message),
    ])
    return this.gemini.generate({ language, message, history, knowledge, conversationSummary: summary, documentText })
  }

  private async sendAndStore(
    conversationId: string,
    inbound: NormalizedInboundMessage,
    language: SupportedLanguage,
    message: string,
  ): Promise<void> {
    const outgoingId = await this.whatsapp.sendText(inbound.conversationExternalId, message)
    await this.repository.saveMessage({
      conversationId,
      externalMessageId: outgoingId ?? `outbound:${inbound.eventId}`,
      direction: 'outbound',
      type: 'text',
      content: message,
      language,
      metadata: { reply_to_event_id: inbound.eventId },
    })
  }
}
