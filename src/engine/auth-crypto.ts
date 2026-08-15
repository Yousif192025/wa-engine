import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { BufferJSON } from '@whiskeysockets/baileys'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const AUTH_VERSION = 1

export interface EncryptedAuthValue {
  version: number
  iv: string
  tag: string
  ciphertext: string
}

function decodeBase64Key(value: string): Buffer {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('BAILEYS_AUTH_ENCRYPTION_KEY must be base64 encoded')
  }

  const key = Buffer.from(normalized, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error('BAILEYS_AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes')
  }
  return key
}

function parseEnvelope(value: unknown): EncryptedAuthValue {
  if (!value || typeof value !== 'object') throw new Error('Encrypted Baileys auth state is invalid')
  const envelope = value as Partial<EncryptedAuthValue>
  if (envelope.version !== AUTH_VERSION || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new Error('Encrypted Baileys auth state has an unsupported format')
  }
  return {
    version: envelope.version,
    iv: envelope.iv,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext,
  }
}

export class BaileysAuthCipher {
  private readonly key: Buffer

  constructor(base64Key: string) {
    this.key = decodeBase64Key(base64Key)
  }

  encrypt(value: unknown): EncryptedAuthValue {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    return {
      version: AUTH_VERSION,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  decrypt<T>(value: unknown): T {
    const envelope = parseEnvelope(value)
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext, BufferJSON.reviver) as T
    } catch {
      throw new Error('Unable to decrypt Baileys auth state')
    }
  }
}

export function validateBaileysAuthEncryptionKey(value: string): boolean {
  try {
    decodeBase64Key(value)
    return true
  } catch {
    return false
  }
}
