import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { EngineConfig } from './config'
import type { EncryptedAuthValue } from './auth-crypto'

export type WhatsAppConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'connected'
  | 'logged_out'
  | 'error'

interface AuthStateRow {
  auth_key_id: string
  encrypted_value: EncryptedAuthValue
}

interface ConnectionStateRow {
  status: WhatsAppConnectionStatus
  connected_jid: string | null
  last_qr_at: string | null
  last_connected_at: string | null
  last_disconnect_at: string | null
  last_error: string | null
  updated_at: string
}

export class BaileysSessionRepository {
  private readonly client: SupabaseClient
  private readonly accountId: string

  constructor(config: EngineConfig, client?: SupabaseClient) {
    this.client = client ?? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    this.accountId = config.baileysAccountId
  }

  async loadAuthValues(category: 'creds' | 'keys', keyIds?: string[]): Promise<Map<string, EncryptedAuthValue>> {
    let query = this.client
      .from('whatsapp_auth_state')
      .select('auth_key_id, encrypted_value')
      .eq('account_id', this.accountId)
      .eq('auth_category', category)

    if (keyIds?.length) query = query.in('auth_key_id', keyIds)
    const { data, error } = await query
    if (error) throw new Error(`Unable to load Baileys auth state: ${error.message}`)

    return new Map((data ?? []).map((row) => {
      const typed = row as AuthStateRow
      return [typed.auth_key_id, typed.encrypted_value]
    }))
  }

  async saveAuthValue(category: 'creds' | 'keys', keyId: string, encryptedValue: EncryptedAuthValue): Promise<void> {
    const { error } = await this.client.from('whatsapp_auth_state').upsert(
      {
        account_id: this.accountId,
        auth_category: category,
        auth_key_id: keyId,
        encrypted_value: encryptedValue,
      },
      { onConflict: 'account_id,auth_category,auth_key_id' },
    )
    if (error) throw new Error(`Unable to save Baileys auth state: ${error.message}`)
  }

  async deleteAuthValue(category: 'creds' | 'keys', keyId: string): Promise<void> {
    const { error } = await this.client
      .from('whatsapp_auth_state')
      .delete()
      .eq('account_id', this.accountId)
      .eq('auth_category', category)
      .eq('auth_key_id', keyId)
    if (error) throw new Error(`Unable to remove Baileys auth state: ${error.message}`)
  }

  async clearAuthState(): Promise<void> {
    const { error } = await this.client
      .from('whatsapp_auth_state')
      .delete()
      .eq('account_id', this.accountId)
    if (error) throw new Error(`Unable to clear Baileys auth state: ${error.message}`)
  }

  async saveConnectionState(input: {
    status: WhatsAppConnectionStatus
    connectedJid?: string
    lastError?: string
    qrGenerated?: boolean
    connected?: boolean
    disconnected?: boolean
  }): Promise<void> {
    const now = new Date().toISOString()
    const previous = await this.loadConnectionState()
    const { error } = await this.client.from('whatsapp_connection_state').upsert(
      {
        account_id: this.accountId,
        status: input.status,
        connected_jid: input.connectedJid ?? previous?.connected_jid ?? null,
        last_error: input.status === 'connected' ? null : input.lastError?.slice(0, 500) ?? previous?.last_error ?? null,
        last_qr_at: input.qrGenerated ? now : previous?.last_qr_at ?? null,
        last_connected_at: input.connected ? now : previous?.last_connected_at ?? null,
        last_disconnect_at: input.disconnected ? now : previous?.last_disconnect_at ?? null,
      },
      { onConflict: 'account_id' },
    )
    if (error) throw new Error(`Unable to save WhatsApp connection state: ${error.message}`)
  }

  async loadConnectionState(): Promise<ConnectionStateRow | null> {
    const { data, error } = await this.client
      .from('whatsapp_connection_state')
      .select('status, connected_jid, last_qr_at, last_connected_at, last_disconnect_at, last_error, updated_at')
      .eq('account_id', this.accountId)
      .maybeSingle()
    if (error) throw new Error(`Unable to load WhatsApp connection state: ${error.message}`)
    return (data as ConnectionStateRow | null) ?? null
  }
}
