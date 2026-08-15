import type { SupportedLanguage } from './utils'

export type MessageDirection = 'inbound' | 'outbound'
export type MessageType = 'text' | 'document' | 'image' | 'audio' | 'unsupported'

export interface WassengerMedia {
  id?: string
  mime?: string
  mimetype?: string
  type?: string
  filename?: string
  name?: string
  size?: number
  links?: { download?: string }
}

export interface WassengerInboundMessage {
  id?: string
  waId?: string
  type?: string
  body?: string
  caption?: string
  fromNumber?: string
  date?: string
  createdAt?: string
  media?: WassengerMedia
  chat?: {
    id?: string
    type?: string
    fromNumber?: string
    contact?: {
      name?: string
      displayName?: string
      phone?: string
    }
  }
}

export interface WassengerWebhook {
  id?: string
  event?: string
  device?: { id?: string; phone?: string }
  data?: WassengerInboundMessage
}

export interface NormalizedInboundMessage {
  eventId: string
  externalMessageId: string
  deviceId?: string
  conversationExternalId: string
  phoneNumber: string
  displayName?: string
  isGroup: boolean
  type: MessageType
  body: string
  timestamp: string
  media?: WassengerMedia
  raw: WassengerWebhook
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
