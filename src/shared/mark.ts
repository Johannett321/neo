/**
 * The app's own mark, as numbers rather than as a drawing.
 *
 * Three squares on a diagonal inside a squircle — separate things, held in one line
 * of sight. It is drawn in three places that cannot share code: `Logo.tsx` as SVG in
 * the renderer, `splash.ts` as SVG in a document the main process builds before the
 * renderer exists, and `scripts/make-icon.mjs` natively from signed distance fields,
 * because there is no SVG rasteriser on a stock macOS. The first two read the
 * geometry from here so the thing in the sidebar and the thing on the splash are the
 * same drawing; the icon script is a plain `.mjs` and carries its own copy, which is
 * the one place the numbers appear twice.
 *
 * Everything is on the 1024 grid the icon is designed on.
 */
export const MARK = {
  /** The squircle. */
  face: { x: 100, y: 100, size: 824, r: 185 },
  /** The three squares, bottom-left first, reading up the diagonal. */
  steps: [
    { x: 294, y: 574 },
    { x: 434, y: 434 },
    { x: 574, y: 294 }
  ],
  step: { size: 156, r: 26 }
} as const

/**
 * The two ends of the gradient, as the sRGB the icon generator draws. `styles.css`
 * carries the same two colours as `--color-brand-from` / `--color-brand-to`, written
 * in oklch, and the renderer uses those; this spelling is for the main process, which
 * has no stylesheet to read a token out of.
 */
export const MARK_FROM = '#e11d48'
export const MARK_TO = '#f59e0b'
