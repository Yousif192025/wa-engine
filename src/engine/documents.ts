import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import type { EngineConfig } from './config'
import { supportedDocumentMimeTypes } from './config'
import type { WassengerMedia } from './types'
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

function inferMimeType(buffer: Buffer, claimedMimeType?: string): string | undefined {
  if (startsWith(buffer, PDF_SIGNATURE)) return 'application/pdf'
  if (startsWith(buffer, DOC_SIGNATURE)) return 'application/msword'
  if (startsWith(buffer, ZIP_SIGNATURE)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return claimedMimeType?.toLowerCase()
}

function safeFilename(value: string | undefined, fallbackExtension: string): string {
  const basename = (value ?? `document-${Date.now()}${fallbackExtension}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
  return basename || `document-${Date.now()}${fallbackExtension}`
}

export class DocumentProcessor {
  constructor(private readonly config: EngineConfig) {}

  async downloadAndExtract(deviceId: string | undefined, media: WassengerMedia): Promise<ExtractedDocument> {
    if (!deviceId || !media.id) throw new Error('Document device or media identifier is missing')
    if (media.size && media.size > this.config.maxFileSizeBytes) throw new Error('Document exceeds MAX_FILE_SIZE')

    const url = new URL(
      `chat/${encodeURIComponent(deviceId)}/files/${encodeURIComponent(media.id)}/download`,
      `${this.config.wassengerApiUrl.replace(/\/$/, '')}/`,
    )
    const response = await withTimeout(
      fetch(url, { headers: { Token: this.config.wassengerApiKey } }),
      this.config.requestTimeoutMs,
      'Document download',
    )
    if (!response.ok) throw new Error(`Unable to download document: HTTP ${response.status}`)

    const advertisedSize = Number(response.headers.get('content-length') ?? media.size ?? 0)
    if (advertisedSize && advertisedSize > this.config.maxFileSizeBytes) {
      throw new Error('Document exceeds MAX_FILE_SIZE')
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error('Document is empty')
    if (buffer.length > this.config.maxFileSizeBytes) throw new Error('Document exceeds MAX_FILE_SIZE')

    const claimedMimeType = response.headers.get('content-type')?.split(';')[0] ?? media.mime ?? media.mimetype ?? media.type
    const mimeType = inferMimeType(buffer, claimedMimeType)
    if (!mimeType || !supportedDocumentMimeTypes.has(mimeType)) {
      throw new Error('Only PDF, DOC, and DOCX documents are supported')
    }

    const extension = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'application/msword' ? '.doc' : '.docx'
    const filename = safeFilename(media.filename ?? media.name, extension)
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
