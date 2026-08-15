import {
  initAuthCreds,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import { BaileysAuthCipher } from './auth-crypto'

export interface BaileysAuthRepository {
  loadAuthValues(category: 'creds' | 'keys', keyIds?: string[]): Promise<Map<string, import('./auth-crypto').EncryptedAuthValue>>
  saveAuthValue(category: 'creds' | 'keys', keyId: string, encryptedValue: import('./auth-crypto').EncryptedAuthValue): Promise<void>
  deleteAuthValue(category: 'creds' | 'keys', keyId: string): Promise<void>
  clearAuthState(): Promise<void>
}

function keyId(type: string, id: string): string {
  const value = `${type}:${id}`
  if (value.length > 500) throw new Error('Baileys auth key identifier is too long')
  return value
}

export class SupabaseAuthState {
  constructor(
    private readonly repository: BaileysAuthRepository,
    private readonly cipher: BaileysAuthCipher,
  ) {}

  async load(): Promise<AuthenticationState> {
    const savedCreds = await this.repository.loadAuthValues('creds', ['creds'])
    const encryptedCreds = savedCreds.get('creds')
    const creds = encryptedCreds
      ? this.cipher.decrypt<AuthenticationCreds>(encryptedCreds)
      : initAuthCreds()

    const keys: SignalKeyStore = {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const encryptedKeys = await this.repository.loadAuthValues('keys', ids.map((id) => keyId(type, id)))
        const result: { [id: string]: SignalDataTypeMap[T] } = {}
        for (const id of ids) {
          const encrypted = encryptedKeys.get(keyId(type, id))
          if (encrypted) result[id] = this.cipher.decrypt<SignalDataTypeMap[T]>(encrypted)
        }
        return result
      },
      set: async (data: SignalDataSet) => {
        for (const [type, entries] of Object.entries(data)) {
          if (!entries) continue
          for (const [id, value] of Object.entries(entries)) {
            const storageKey = keyId(type, id)
            if (value === null) {
              await this.repository.deleteAuthValue('keys', storageKey)
            } else {
              await this.repository.saveAuthValue('keys', storageKey, this.cipher.encrypt(value))
            }
          }
        }
      },
      clear: async () => this.repository.clearAuthState(),
    }

    return { creds, keys }
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    await this.repository.saveAuthValue('creds', 'creds', this.cipher.encrypt(creds))
  }
}
