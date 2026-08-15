import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractMessageContent, type WAMessage } from '@whiskeysockets/baileys'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import type { EngineConfig } from './config'
import { supportedDocumentMimeTypes } from './config'
import { cleanText, withTimeout } from './utils'

const PDF_SIGNATURE = Buffer.from('%PDF')
const DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export interface ExtractedDocument {
  filename: string
  mimeType: string
  sizeBytes: number
  text: string
}

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)
}

function inferMimeType(buffer: Buffer, claimedMimeType?: string | null): string | undefined {
  if (startsWith(buffer, PDF_SIGNATURE)) return 'application/pdf'
  if (startsWith(buffer, DOC_SIGNATURE)) return 'application/msword'
  if (startsWith(buffer, ZIP_SIGNATURE)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return claimedMimeType?.toLowerCase()
}

function safeFilename(value: string | null | undefined, fallbackExtension: string): string {
  const basename = (value ?? `document-${Date.now()}${fallbackExtension}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
  return basename || `document-${Date.now()}${fallbackExtension}`
}

function documentFromMessage(message: WAMessage) {
  return extractMessageContent(message.message)?.documentMessage
}

function fileLength(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return value.toNumber()
  }
  return undefined
}

export class DocumentProcessor {
  constructor(private readonly config: EngineConfig) {}

  async downloadAndExtract(message: WAMessage, downloader: (message: WAMessage) => Promise<Buffer>): Promise<ExtractedDocument> {
    const document = documentFromMessage(message)
    if (!document) throw new Error('Incoming Baileys message does not contain a document')

    const declaredSize = fileLength(document.fileLength)
    if (declaredSize && declaredSize > this.config.maxFileSizeBytes) throw new Error('Document exceeds MAX_FILE_SIZE')

    const buffer = await withTimeout(downloader(message), this.config.requestTimeoutMs, 'Document download')
    if (!buffer.length) throw new Error('Document is empty')
    if (buffer.length > this.config.maxFileSizeBytes) throw new Error('Document exceeds MAX_FILE_SIZE')

    const mimeType = inferMimeType(buffer, document.mimetype)
    if (!mimeType || !supportedDocumentMimeTypes.has(mimeType)) {
      throw new Error('Only PDF, DOC, and DOCX documents are supported')
    }

    const extension = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'application/msword' ? '.doc' : '.docx'
    const filename = safeFilename(document.fileName, extension)
    const text = await this.extractText(buffer, mimeType, extension)
    return { filename, mimeType, sizeBytes: buffer.length, text: cleanText(text, this.config.maxInputCharacters) }
  }

  private async extractText(buffer: Buffer, mimeType: string, extension: string): Promise<string> {
    if (mimeType === 'application/pdf') {
      const parser = new PDFParse({ data: buffer })
      try {
        const result = await withTimeout(parser.getText(), this.config.requestTimeoutMs, 'PDF text extraction')
        return result.text
      } finally {
        await parser.destroy()
      }
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await withTimeout(mammoth.extractRawText({ buffer }), this.config.requestTimeoutMs, 'DOCX text extraction')
      return result.value
    }

    const temporaryPath = join(tmpdir(), `wa-engine-${randomUUID()}${extension}`)
    try {
      await writeFile(temporaryPath, buffer, { mode: 0o600 })
      const extractor = new WordExtractor()
      const document = await withTimeout(extractor.open(temporaryPath), this.config.requestTimeoutMs, 'DOC text extraction')
      return document.getBody()
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}
