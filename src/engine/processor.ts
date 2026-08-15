import { createHash } from 'node:crypto'
import type { EngineConfig } from './config'
import { fallbackMessage } from './config'
import { DocumentProcessor } from './documents'
import type { GeminiGenerator } from './gemini'
import { BotRepository } from './repository'
import type { MessageType, NormalizedInboundMessage, ProcessResult, WassengerWebhook } from './types'
import { cleanText, detectLanguage, log, logError, type SupportedLanguage } from './utils'
import { WassengerClient } from './wassenger'

function stableEventId(webhook: WassengerWebhook): string {
  const directId = webhook.id ?? webhook.data?.id ?? webhook.data?.waId
  if (directId) return String(directId)
  return createHash('sha256').update(JSON.stringify(webhook)).digest('hex')
}

function normalizeType(value: string | undefined): MessageType {
  if (value === 'document') return 'document'
  if (value === 'text' || value === 'chat') return 'text'
  if (value === 'image') return 'image'
  if (value === 'audio') return 'audio'
  return 'unsupported'
}

export function normalizeWebhook(webhook: WassengerWebhook, maxCharacters: number): NormalizedInboundMessage {
  if (!webhook.data) throw new Error('Webhook payload is missing data')
  const message = webhook.data
  const chat = message.chat
  const phoneNumber = cleanText(message.fromNumber ?? chat?.contact?.phone ?? chat?.fromNumber, 40)
  if (!phoneNumber) throw new Error('Webhook message is missing the sender phone number')

  const externalMessageId = cleanText(message.id ?? message.waId ?? webhook.id, 200) || stableEventId(webhook)
  const eventId = stableEventId(webhook)
  const conversationExternalId = cleanText(chat?.id ?? phoneNumber, 200)
  const chatType = chat?.type?.toLowerCase()
  const isGroup = chatType === 'group' || chatType === 'broadcast' || /@g\.us$/i.test(conversationExternalId)
  const body = cleanText(message.body ?? message.caption, maxCharacters)

  return {
    eventId,
    externalMessageId,
    deviceId: cleanText(webhook.device?.id, 100) || undefined,
    conversationExternalId,
    phoneNumber,
    displayName: cleanText(chat?.contact?.displayName ?? chat?.contact?.name, 120) || undefined,
    isGroup,
    type: normalizeType(message.type),
    body,
    timestamp: message.createdAt ?? message.date ?? new Date().toISOString(),
    media: message.media,
    raw: webhook,
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
    private readonly wassenger: WassengerClient,
    private readonly documents: DocumentProcessor,
  ) {}

  async process(webhook: WassengerWebhook): Promise<ProcessResult> {
    let inbound: NormalizedInboundMessage
    try {
      inbound = normalizeWebhook(webhook, this.config.maxInputCharacters)
    } catch (error) {
      logError('webhook_rejected', error)
      return { accepted: false, reason: 'invalid_payload' }
    }

    if (!['message:in', 'message:in:new'].includes(webhook.event ?? '')) {
      return { accepted: true, reason: 'ignored_event' }
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
      claimed = await this.repository.claimWebhookEvent(inbound.eventId, webhook.event ?? 'message:in')
      if (!claimed) return { accepted: true, duplicate: true, reason: 'duplicate_event' }

      const existingConversation = await this.repository.findConversation(inbound.conversationExternalId)
      language = detectLanguage(inbound.body, existingConversation?.language ?? this.config.defaultLanguage)
      const user = await this.repository.getOrCreateUser(inbound.phoneNumber, inbound.displayName)
      const conversation = await this.repository.getOrCreateConversation(user.id, inbound.conversationExternalId, language)

      let messageContent = inbound.body
      let documentText: string | undefined
      if (inbound.type === 'document') {
        try {
          const extracted = await this.documents.downloadAndExtract(inbound.deviceId, inbound.media ?? {})
          documentText = extracted.text
          await this.repository.saveDocument({
            userId: user.id,
            conversationId: conversation.id,
            externalMediaId: inbound.media?.id,
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
        metadata: { timestamp: inbound.timestamp, has_media: Boolean(inbound.media?.id) },
      })

      if (!messageContent) {
        await this.sendAndStore(conversation.id, inbound, language, emptyMessageReply(language))
        await this.repository.completeWebhookEvent(inbound.eventId, 'completed')
        return { accepted: true, reason: 'empty_message' }
      }

      this.wassenger.sendTypingState({ deviceId: inbound.deviceId, chat: inbound.phoneNumber })
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
        await this.wassenger.sendText({
          phoneNumber: inbound.phoneNumber,
          message: fallbackMessage(this.config, language),
          deviceId: inbound.deviceId,
        })
      } catch (sendError) {
        logError('fallback_send_failed', sendError, { eventId: inbound.eventId })
      }
      if (claimed) {
        await this.repository.completeWebhookEvent(inbound.eventId, 'failed', error instanceof Error ? error.message : 'Unknown error')
          .catch((completionError) => logError('webhook_completion_failed', completionError, { eventId: inbound.eventId }))
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
    const outgoingId = await this.wassenger.sendText({
      phoneNumber: inbound.phoneNumber,
      message,
      deviceId: inbound.deviceId,
    })
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
