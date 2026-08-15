import type { WAMessage } from '@whiskeysockets/baileys'
import type { SupportedLanguage } from './utils'

export type MessageDirection = 'inbound' | 'outbound'
export type MessageType = 'text' | 'document' | 'image' | 'audio' | 'unsupported'

export interface BaileysDocumentMedia {
  mimeType?: string | null
  filename?: string | null
  size?: unknown
}

export interface NormalizedInboundMessage {
  eventId: string
  externalMessageId: string
  conversationExternalId: string
  phoneNumber: string
  displayName?: string
  isGroup: boolean
  type: MessageType
  body: string
  timestamp: string
  media?: BaileysDocumentMedia
  raw: WAMessage
}

export interface StoredMessage {
  id: string
  direction: MessageDirection
  content: string
  language: SupportedLanguage
  message_type: string
  created_at: string
}

export interface KnowledgeContext {
  id: string
  title: string
  content: string
  category?: string | null
  score: number
}

export interface ProcessResult {
  accepted: boolean
  duplicate?: boolean
  reason?: string
}
