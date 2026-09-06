/**
 * The side panels, and how wide each one is allowed to be.
 *
 * Every panel in the app is draggable at its outer edge, and every one of them
 * remembers where you left it. The numbers live here rather than in the components
 * so that "how wide may a panel be" is one question with one answer, the way the
 * attention thresholds are: a panel is a panel, whichever side of the window it is
 * on, and a minimum that only half the app agrees with is not a minimum.
 *
 * A width is a preference like the theme, so it is persisted like the theme — in the
 * settings table, not in browser storage, because everything this app remembers
 * lives in the folder you can back up.
 */

/** The panels you can drag. `side` is the edge the panel is anchored to; the handle
 *  is on the other one. */
export type PanelId = 'sidebar' | 'assistant' | 'meeting'

export type PanelSpec = {
  /** The settings key that remembers this panel's width. */
  setting: 'sidebarWidth' | 'assistantWidth' | 'meetingWidth'
  side: 'left' | 'right'
  default: number
  min: number
  max: number
  /**
   * How much of the window has to be left for the page itself. The maximum is a
   * function of the window rather than a constant: a panel may take a lot of room,
   * but never so much that what is behind it stops being usable.
   */
  keepFree: number
}

export const PANELS: Record<PanelId, PanelSpec> = {
  // The navigation is a list of short labels. It grows for long project names rather
  // than for its own sake, so it is the narrowest of the three.
  sidebar: { setting: 'sidebarWidth', side: 'left', default: 228, min: 180, max: 380, keepFree: 560 },
  assistant: { setting: 'assistantWidth', side: 'right', default: 420, min: 340, max: 760, keepFree: 620 },
  // The meeting's details column sits inside a page that may already have both of the
  // others open, so it asks for the least room back.
  meeting: { setting: 'meetingWidth', side: 'right', default: 312, min: 250, max: 560, keepFree: 500 }
}

export function clampPanelWidth(panel: PanelId, width: number, windowWidth: number): number {
  const spec = PANELS[panel]
  return Math.max(
    spec.min,
    Math.min(width, spec.max, Math.max(spec.min, windowWidth - spec.keepFree))
  )
}
