import { extname } from 'node:path'

/**
 * Files put into a conversation: which ones the model can read, and how.
 *
 * The files themselves are kept in Neo Cloud. This is only the question of shape, asked
 * before a file is sent anywhere — the server asks it again on the way in.
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

/** Whether a file is a picture a note can carry. */
export const isImageMime = (mime: string): boolean => IMAGE.has(mime)

export type AttachmentShape = 'image' | 'document' | 'text'

/** How a file will be shown to the model, or null if it cannot be. */
export function shapeOf(name: string, mime: string): AttachmentShape | null {
  if (IMAGE.has(mime)) return 'image'
  if (DOCUMENT.has(mime) || extname(name).toLowerCase() === '.pdf') return 'document'
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extname(name).toLowerCase())) return 'text'
  return null
}
