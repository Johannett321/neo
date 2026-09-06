import { BrowserWindow } from 'electron'

/**
 * The Liquid Glass theme's other half.
 *
 * A page cannot see past its own window. `backdrop-filter` blurs what is painted
 * behind an element *inside the document*, and the desktop is not in the document —
 * so the frosting that makes glass glass has to come from the operating system, and
 * this is the only place that can ask for it. macOS puts an `NSVisualEffectView`
 * under the web contents; Windows 11 has an acrylic backdrop; everywhere else the
 * answer is no, and the renderer is told so rather than left to draw a transparent
 * window over a black hole.
 */
export type GlassMaterial = 'window' | 'paint'

/**
 * The macOS material, chosen once and never changed, and both halves of that are
 * load-bearing.
 *
 * *Which* one: `hud` is the thinnest of the fourteen, settled by putting all of them
 * side by side over a real desktop and looking, because there is no other way to
 * know. It is the floor the amount is measured down from — the renderer's own paint
 * is what thickens it back up towards frosted, and that is a continuum where this is
 * a list of fourteen fixed points.
 *
 * *Never changed*: `visualEffectState: 'active'` is what stops macOS turning the
 * glass to flat grey the moment the window is not the one you are typing in, and
 * Electron reads that option **only when the window is constructed**. Calling
 * `setVibrancy()` afterwards builds a fresh effect view and does not carry the state
 * across, so a material that follows the slider would cost the theme its whole
 * appearance in every window but the front one. Verified by building three windows
 * with three histories and looking at them from another app; do not reintroduce a
 * runtime `setVibrancy` on this platform without checking that again.
 */
const MATERIAL = 'hud'

/** Transparent, so whatever the operating system put underneath is what you see. */
const CLEAR = '#00000000'

let wanted = false

/** Is there anything on this machine that can blur the desktop behind a window? */
export function glassAvailable(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Apply the standing choice to one window. Called by `createWindow` as well as by
 * the channel, so a window opened later starts out the way the app already looks.
 *
 * There is nothing to do on macOS: the effect view is there in every theme, and what
 * decides whether you can see it is the paint the renderer puts over it. That is not
 * a saving, it is the requirement — see the note on `MATERIAL`. Windows has no such
 * constraint and no such state, so there the backdrop really is switched.
 */
export function applyGlassTo(window: BrowserWindow): GlassMaterial {
  if (!window.isDestroyed() && process.platform === 'win32') {
    window.setBackgroundMaterial(wanted ? 'acrylic' : 'auto')
  }
  return wanted && glassAvailable() ? 'window' : 'paint'
}

/** Turn every open window to glass, or back. Returns what was actually got. */
export function setGlass(on: boolean): GlassMaterial {
  wanted = on
  let material: GlassMaterial = on && glassAvailable() ? 'window' : 'paint'
  for (const window of BrowserWindow.getAllWindows()) material = applyGlassTo(window)
  return material
}

/** The background every window is created with, so the material below it can show. */
export function initialBackground(): string {
  return CLEAR
}

/**
 * The vibrancy every macOS window is created with — in every theme, not only this
 * one, because it can never be set again afterwards. The other three themes paint
 * `html` solid and cover it completely.
 */
export function initialVibrancy(): typeof MATERIAL | undefined {
  return process.platform === 'darwin' ? MATERIAL : undefined
}

/**
 * What the stored theme implies, read once at startup. It no longer decides anything
 * about the window itself on macOS; it is what `applyGlassTo` and the channel report,
 * and on Windows it is the backdrop.
 */
export function presetGlass(theme: string): void {
  wanted = theme === 'glass'
}
