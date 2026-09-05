import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { attachmentDir } from '../db/client'

/**
 * Files put into a conversation.
 *
 * They are written into the data folder beside the icons rather than into the
 * database, for the same reason: a backup of `~/Documents/Neo` is then a backup of
 * everything, and a 4 MB screenshot does not have to be read out of a row every time
 * the panel repaints. The renderer never learns a path it could open — it hands over
 * bytes on the way in and receives a data URL on the way out.
 */

/** What the model can actually be shown. Anything else is refused rather than sent. */
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOCUMENT = new Set(['application/pdf'])

/**
 * Text is not sent as a file at all — it goes into the prompt as text, which costs
 * nothing to render and is what the model reads best. Extensions rather than MIME
 * types, because a `.ts` or a `.md` dropped from Finder arrives as an empty string
 * or `application/octet-stream` about as often as not.
 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.sql', '.sh', '.css', '.log', '.toml', '.ini', '.env'
])

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export type AttachmentShape = 'image' | 'document' | 'text'

/** How a file will be shown to the model, or null if it cannot be. */
export function shapeOf(name: string, mime: string): AttachmentShape | null {
  if (IMAGE.has(mime)) return 'image'
  if (DOCUMENT.has(mime) || extname(name).toLowerCase() === '.pdf') return 'document'
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extname(name).toLowerCase())) return 'text'
  return null
}

/** Write bytes into attachments/ and return the stored filename. */
export async function storeAttachment(name: string, base64: string): Promise<{ path: string; bytes: number }> {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than 20 MB.`)
  }
  await mkdir(attachmentDir(), { recursive: true })
  const path = `${randomUUID()}${extname(name).toLowerCase()}`
  await writeFile(join(attachmentDir(), path), buffer)
  return { path, bytes: buffer.byteLength }
}

export async function readAttachment(path: string): Promise<Buffer | null> {
  if (!path) return null
  try {
    return await readFile(join(attachmentDir(), path))
  } catch {
    // A file removed from under us must not take the conversation down with it.
    return null
  }
}

export async function deleteAttachment(path: string): Promise<void> {
  if (!path) return
  await rm(join(attachmentDir(), path), { force: true })
}
