import { createHash } from 'node:crypto'
import { jidDecode, jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys'
import type { SenderIdentity } from './types'

function phoneNumberFromJid(jid: string | undefined): string | undefined {
  const decoded = jidDecode(jid)
  if (decoded?.server !== 's.whatsapp.net' || !/^\d{6,20}$/.test(decoded.user)) return undefined
  return decoded.user
}

function lidFromJid(jid: string | undefined): string | undefined {
  const decoded = jidDecode(jid)
  if (decoded?.server !== 'lid' || !/^\d{6,20}$/.test(decoded.user)) return undefined
  return jidNormalizedUser(jid)
}

function lidStorageIdentifier(lid: string): string {
  // A leading zero makes this a reserved internal token rather than a valid E.164-style number.
  // It preserves the existing numeric check without treating the opaque LID as a phone number.
  const digest = createHash('sha256').update(lid).digest('hex')
  const numeric = BigInt(`0x${digest}`).toString(10).padStart(19, '0').slice(0, 19)
  return `0${numeric}`
}

export function resolveSenderIdentity(message: WAMessage): SenderIdentity {
  const remoteJid = message.key.remoteJid
  if (!remoteJid) throw new Error('Baileys message is missing remote JID')

  const isGroup = remoteJid.endsWith('@g.us')
  const primaryJid = isGroup ? message.key.participant : remoteJid
  if (!primaryJid) throw new Error('Baileys group message is missing participant JID')

  const phoneCandidates = isGroup
    ? [message.key.participantPn, message.key.senderPn, primaryJid]
    : [message.key.senderPn, message.key.participantPn, primaryJid]
  const phoneNumber = phoneCandidates.map(phoneNumberFromJid).find(Boolean)

  const lidCandidates = isGroup
    ? [message.key.participantLid, message.key.senderLid, primaryJid]
    : [message.key.senderLid, message.key.participantLid, primaryJid]
  const lid = lidCandidates.map(lidFromJid).find(Boolean)

  const jid = jidNormalizedUser(primaryJid)
  if (phoneNumber) {
    return {
      kind: 'phone',
      jid,
      lid,
      phoneNumber,
      storageIdentifier: phoneNumber,
    }
  }

  if (lid) {
    return {
      kind: 'lid',
      jid,
      lid,
      storageIdentifier: lidStorageIdentifier(lid),
    }
  }

  throw new Error('Baileys message sender has neither a supported phone JID nor a LID')
}
