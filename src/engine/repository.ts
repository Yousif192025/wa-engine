import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { EngineConfig } from './config'
import type { KnowledgeContext, MessageDirection, SenderIdentity, StoredMessage } from './types'
import { log, type SupportedLanguage } from './utils'

interface UserRecord {
  id: string
  phone_number: string | null
  whatsapp_identity: string
  display_name?: string | null
  metadata?: Record<string, unknown> | null
}

interface ConversationRecord {
  id: string
  external_chat_id: string
  language?: SupportedLanguage | null
  summary?: string | null
}

export class BotRepository {
  private readonly client: SupabaseClient

  constructor(config: EngineConfig, client?: SupabaseClient) {
    this.client = client ?? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }

  async claimWebhookEvent(eventId: string, eventType: string): Promise<boolean> {
    const { error } = await this.client
      .from('webhook_events')
      .insert({ external_event_id: eventId, event_type: eventType, status: 'processing' })

    if (!error) return true
    if (error.code === '23505') return false
    throw new Error(`Unable to claim webhook event: ${error.message}`)
  }

  async completeWebhookEvent(eventId: string, status: 'completed' | 'failed', errorMessage?: string): Promise<void> {
    const { error } = await this.client
      .from('webhook_events')
      .update({ status, error_message: errorMessage?.slice(0, 500) ?? null, processed_at: new Date().toISOString() })
      .eq('external_event_id', eventId)
    if (error) throw new Error(`Unable to complete webhook event: ${error.message}`)
  }

  async getOrCreateUser(sender: SenderIdentity, displayName?: string): Promise<UserRecord> {
    const metadata = {
      whatsapp_identity: {
        kind: sender.kind,
        jid: sender.jid,
        lid: sender.lid ?? null,
        phone_number: sender.phoneNumber ?? null,
      },
    }
    let existing = await this.findUserBy('whatsapp_identity', sender.whatsappIdentity)
    if (!existing && sender.phoneNumber) existing = await this.findUserBy('phone_number', sender.phoneNumber)

    if (existing) {
      const existingMetadata = existing.metadata && typeof existing.metadata === 'object'
        ? existing.metadata as Record<string, unknown>
        : {}
      const updates: Record<string, unknown> = {
        metadata: { ...existingMetadata, ...metadata },
        updated_at: new Date().toISOString(),
      }
      if (displayName && displayName !== existing.display_name) updates.display_name = displayName
      if (sender.phoneNumber && sender.phoneNumber !== existing.phone_number) updates.phone_number = sender.phoneNumber
      if (sender.kind === 'lid' && sender.whatsappIdentity !== existing.whatsapp_identity) {
        updates.whatsapp_identity = sender.whatsappIdentity
      }
      const { error } = await this.client
        .from('bot_users')
        .update(updates)
        .eq('id', existing.id)
      if (error) throw new Error(`Unable to update user: ${error.message}`)
      return { ...existing, ...updates } as UserRecord
    }

    const insertPayload = {
      whatsapp_identity: sender.whatsappIdentity,
      phone_number: sender.phoneNumber ?? null,
      display_name: displayName ?? null,
      metadata,
    }
    log('bot_user_insert_payload_debug', {
      whatsappIdentity: sender.whatsappIdentity ?? null,
      senderKind: sender.kind,
      senderJid: sender.jid,
      senderLid: sender.lid ?? null,
      phoneNumber: sender.phoneNumber ?? null,
      insertPayload: {
        whatsapp_identity: insertPayload.whatsapp_identity ?? null,
        phone_number: insertPayload.phone_number,
        display_name: insertPayload.display_name ? '[present]' : null,
        metadata: '[omitted]',
      },
    })
    const { data, error } = await this.client
      .from('bot_users')
      .insert(insertPayload)
      .select('id, phone_number, whatsapp_identity, display_name, metadata')
      .single()
    if (error) throw new Error(`Unable to create user: ${error.message}`)
    return data as UserRecord
  }

  private async findUserBy(column: 'whatsapp_identity' | 'phone_number', value: string): Promise<UserRecord | null> {
    const { data, error } = await this.client
      .from('bot_users')
      .select('id, phone_number, whatsapp_identity, display_name, metadata')
      .eq(column, value)
      .maybeSingle()
    if (error) throw new Error(`Unable to find user: ${error.message}`)
    return (data as UserRecord | null) ?? null
  }

  async findConversation(externalChatId: string): Promise<ConversationRecord | null> {
    const { data, error } = await this.client
      .from('conversations')
      .select('id, external_chat_id, language, summary')
      .eq('external_chat_id', externalChatId)
      .maybeSingle()
    if (error) throw new Error(`Unable to find conversation: ${error.message}`)
    return (data as ConversationRecord | null) ?? null
  }

  async getOrCreateConversation(
    userId: string,
    externalChatId: string,
    language: SupportedLanguage,
  ): Promise<ConversationRecord> {
    const existing = await this.findConversation(externalChatId)
    if (existing) {
      if (existing.language !== language) {
        const { error } = await this.client
          .from('conversations')
          .update({ language, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        if (error) throw new Error(`Unable to update conversation language: ${error.message}`)
      }
      return { ...existing, language } as ConversationRecord
    }

    const { data, error } = await this.client
      .from('conversations')
      .insert({ user_id: userId, external_chat_id: externalChatId, language, status: 'active' })
      .select('id, external_chat_id, language, summary')
      .single()
    if (error) throw new Error(`Unable to create conversation: ${error.message}`)
    return data as ConversationRecord
  }

  async saveMessage(input: {
    conversationId: string
    externalMessageId: string
    direction: MessageDirection
    type: string
    content: string
    language: SupportedLanguage
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const { error } = await this.client.from('messages').upsert(
      {
        conversation_id: input.conversationId,
        external_message_id: input.externalMessageId,
        direction: input.direction,
        message_type: input.type,
        content: input.content,
        language: input.language,
        metadata: input.metadata ?? {},
      },
      { onConflict: 'external_message_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(`Unable to save message: ${error.message}`)
  }

  async recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('id, direction, content, language, message_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`Unable to load message history: ${error.message}`)
    return ((data ?? []) as StoredMessage[]).reverse()
  }

  async saveDocument(input: {
    userId: string
    conversationId: string
    externalMediaId?: string
    filename?: string
    mimeType: string
    sizeBytes?: number
    extractedText: string
  }): Promise<void> {
    const { error } = await this.client.from('documents').upsert(
      {
        user_id: input.userId,
        conversation_id: input.conversationId,
        external_media_id: input.externalMediaId ?? null,
        filename: input.filename ?? 'document',
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes ?? null,
        extracted_text: input.extractedText,
        processing_status: 'processed',
      },
      { onConflict: 'external_media_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(`Unable to save document metadata: ${error.message}`)
  }

  async searchKnowledge(query: string, limit = 5): Promise<KnowledgeContext[]> {
    const safeQuery = query.trim().slice(0, 500)
    if (!safeQuery) return []

    const { data, error } = await this.client
      .from('knowledge_base')
      .select('id, title, content, category')
      .eq('is_active', true)
      .textSearch('search_vector', safeQuery, { config: 'simple', type: 'websearch' })
      .limit(limit)
    if (error) throw new Error(`Unable to search knowledge base: ${error.message}`)
    return ((data ?? []) as KnowledgeContext[]).map((item, index) => ({ ...item, score: limit - index }))
  }
}
