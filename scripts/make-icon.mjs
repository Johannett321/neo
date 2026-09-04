#!/usr/bin/env node
/**
 * Draws the Neo app icon and every size macOS asks for.
 *
 * There is no SVG rasteriser on a stock macOS, so the shapes are rendered here from
 * signed distance fields. Each size is drawn natively rather than downscaled from one
 * master, which is what keeps the 16px version crisp.
 */
import { execFileSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------------------------------------------------------------- png output */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ geometry */
const roundedRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp01 = (v) => Math.max(0, Math.min(1, v))

/* -------------------------------------------------------------------- design */
// Two adjacent hues. Complements grey out where they meet; neighbours stay saturated,
// which is why this blend is vivid all the way across.
const FROM = hex('#e11d48')
const TO = hex('#f59e0b')

// Three steps on a diagonal: separate things, held in one line of sight.
const MARK = (px, py) =>
  Math.min(
    roundedRect(px, py, 372, 652, 78, 78, 26),
    roundedRect(px, py, 512, 512, 78, 78, 26),
    roundedRect(px, py, 652, 372, 78, 78, 26)
  )

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = 1024 / size     // design units per output pixel
  const SS = 3                  // supersampling per axis

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, covered = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * scale
          const py = (y + (sy + 0.5) / SS) * scale

          // Outside the squircle the icon is transparent, as macOS expects.
          if (roundedRect(px, py, 512, 512, 412, 412, 185) > 0) continue

          const u = (px - 100) / 824
          const v = (py - 100) / 824
          let colour = mix(FROM, TO, clamp01(u * 0.5 + v * 0.5))
          // A little light at the top-left keeps a two-stop blend from looking like vinyl.
          colour = mix(colour, [255, 255, 255], clamp01(1 - Math.hypot(u - 0.18, v - 0.1) / 0.8) ** 2 * 0.16)

          // The same shape, nudged down and softened, lifts the mark off the face.
          const shadow = clamp01((24 - MARK(px, py - 11)) / 24) * 0.16
          if (shadow > 0) colour = mix(colour, [60, 10, 10], shadow)
          if (MARK(px, py) < 0) colour = [255, 255, 255]

          r += colour[0]
          g += colour[1]
          b += colour[2]
          covered++
        }
      }
      const i = (y * size + x) * 4
      if (covered > 0) {
        rgba[i] = Math.round(r / covered)
        rgba[i + 1] = Math.round(g / covered)
        rgba[i + 2] = Math.round(b / covered)
      }
      rgba[i + 3] = Math.round((covered / (SS * SS)) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

/* --------------------------------------------------------------------- write */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const iconset = join(OUT, 'icon.iconset')
mkdirSync(iconset, { recursive: true })

for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png']
]) {
  writeFileSync(join(iconset, name), render(size))
}
writeFileSync(join(OUT, 'icon.png'), render(1024))

// The .icns is what a packaged build and the development bundle both use.
try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')])
} catch (error) {
  console.warn('Could not build icon.icns:', error.message)
}

console.log('Rendered the icon into build/.')
