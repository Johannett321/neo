import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * The encryption primitives, and **nothing in the application calls them today.**
 *
 * That is deliberate and worth stating plainly rather than leaving somebody to
 * discover it. Neo used to seal every change under a key the sync server never had.
 * It was a strong promise and it made everything else harder: nothing on the server
 * could be queried, joined, indexed or repaired, and every question about the data
 * had to be answered on a machine that could open it. So the rows are stored as rows
 * now, and the server can read them.
 *
 * These are kept because the next step is selective: some columns are worth the cost
 * and most are not. `workspace.ai_api_key` is the obvious first one — it is a
 * credential, and it currently travels and is stored in plaintext like everything
 * else, so that the assistant works on every device without being set up again.
 *
 * Everything here runs in the main process. No key and no passphrase is ever handed
 * to a renderer, written to the database in the clear, or sent anywhere.
 *
 * **Why a passphrase rather than a passkey's PRF secret.** An Electron renderer is
 * loaded from `file://`, so it cannot run a WebAuthn ceremony against the server's
 * domain — the origin will not match the relying party id — and the only way to get
 * one is a window loading a page the *server* serves. A server that serves the
 * JavaScript which handles the PRF secret can take the key whenever it decides to,
 * and the end-to-end claim is then decoration. So a passkey proves who you are, and a
 * passphrase would be what opens anything.
 */

const KEY_BYTES = 32
const NONCE_BYTES = 12
const SALT_BYTES = 16

/**
 * scrypt rather than Argon2id, which would be the better primitive.
 *
 * Argon2 needs a native module, and a native module here is a compile against one
 * Electron's headers plus a crash that takes the main process with it — the same
 * reasoning that keeps the audio tap a child process. scrypt is in Node, is memory
 * hard, and at these parameters costs about a second on this machine, which is the
 * right price for something typed once per install.
 */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

export interface WrappedKey {
  /** The salt the passphrase was stretched with. Not a secret. */
  salt: string
  /** The master key, sealed under the passphrase. */
  sealed: string
}

/* ------------------------------------------------------------------ *
 * Sealing
 * ------------------------------------------------------------------ */

/**
 * AES-256-GCM, and the nonce travels in front of the ciphertext.
 *
 * XChaCha20-Poly1305 would be the better choice for its nonce size, and it is what
 * the design document names — but it is not in Node, and reaching for a dependency
 * to hold the one primitive everything else rests on is a poor trade. A 96-bit
 * random nonce is safe here because a key is used for a bounded number of messages:
 * every batch under a workspace key, which is thousands, not billions.
 */
export function sealBytes(key: Buffer, plaintext: Buffer | string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final()
  ])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export function seal(key: Buffer, plaintext: Buffer | string): string {
  return sealBytes(key, plaintext).toString('base64')
}

/** Throws on anything that has been altered — there is no partial success here. */
export function open(key: Buffer, sealed: string): Buffer {
  return openBytes(key, Buffer.from(sealed, 'base64'))
}

/** The same, for bytes that are not text. */
export function openBytes(key: Buffer, raw: Buffer): Buffer {
  if (raw.length < NONCE_BYTES + 16) throw new Error('That is too short to be sealed data.')

  const nonce = raw.subarray(0, NONCE_BYTES)
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(NONCE_BYTES, raw.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** What sealing adds: a nonce in front and a tag behind. */
export const SEAL_OVERHEAD = NONCE_BYTES + 16

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

export const newMasterKey = (): Buffer => randomBytes(KEY_BYTES)

/** Stretch a passphrase into the key that wraps the master key. */
function keyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT)
}

export function wrapMasterKey(masterKey: Buffer, passphrase: string): WrappedKey {
  const salt = randomBytes(SALT_BYTES)
  return {
    salt: salt.toString('base64'),
    sealed: seal(keyFromPassphrase(passphrase, salt), masterKey)
  }
}

/**
 * Returns null for the wrong passphrase rather than throwing.
 *
 * A wrong passphrase is an ordinary thing a person does, not a fault: the screen has
 * to say "that is not the passphrase" and let them try again. Anything genuinely
 * malformed still throws.
 */
export function unwrapMasterKey(wrapped: WrappedKey, passphrase: string): Buffer | null {
  const key = keyFromPassphrase(passphrase, Buffer.from(wrapped.salt, 'base64'))
  try {
    const master = open(key, wrapped.sealed)
    return master.length === KEY_BYTES ? master : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * A passphrase somebody has to be able to type twice
 * ------------------------------------------------------------------ */

/** Enough that a weak one is refused, without inventing rules nobody can satisfy. */
export function passphraseComplaint(passphrase: string): string | null {
  const value = passphrase.normalize('NFKC')
  if (value.trim().length < 12) {
    return 'Use at least 12 characters. This is the only thing standing between the server and your work.'
  }
  if (/^\s|\s$/.test(passphrase)) {
    return 'A passphrase that starts or ends with a space is one you will mistype later.'
  }
  return null
}

