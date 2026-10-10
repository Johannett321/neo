import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Routes, useLocation, useNavigate, type Location } from 'react-router-dom'
import { EASE } from '@/lib/motion'

/**
 * The app's settings and a workspace's are a layer over the app rather than a screen in
 * it — Shopify's arrangement. They used to be a page like any other: the sidebar stayed
 * beside them and said you were somewhere in your workspace, and leaving meant Escape
 * or the sidebar, which took you to Today rather than back to the board you had been
 * on. Now they cover the whole window, sidebar included, with a ✕ at the top right, and
 * closing them puts you back exactly where you were — the screen underneath was never
 * unmounted, so its scroll, its open folder and its half-typed search are all still
 * there.
 *
 * They are still routes, `/settings` and `/workspace`, so every link, the menu and the
 * `?pane=` deep links work unchanged. What changes is what draws them: while one is
 * open, the shell keeps drawing the *last page* underneath (`usePageLocation`), and this
 * draws the settings on top. A project's settings stay where they are — inside a project
 * the sidebar *is* the project, and its settings are one of its places.
 *
 * The layer is a sheet that rises from the bottom of the window: the page stays on
 * screen above and around it, dimmed, so it reads as something put down over where you
 * were rather than somewhere else you went. It reaches the bottom edge, stops just
 * short of the top, and is as wide as the window up to a measure past which a settings
 * pane only gets emptier.
 */
const OVERLAY_PATHS = ['/settings', '/workspace']

export const isOverlayPath = (pathname: string): boolean => OVERLAY_PATHS.includes(pathname)

const ROOT: Location = { pathname: '/', search: '', hash: '', state: null, key: 'default' }

interface Page {
  location: Location
  /** React Router's own index for that history entry, so closing can go back to it. */
  index: number | null
}

const historyIndex = (): number | null => {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof idx === 'number' ? idx : null
}

/**
 * The location the shell should draw its page for: the real one, or — while a settings
 * layer is open — the page that was on screen before it. Opened cold (a reload, the
 * first launch landing on `/settings`) there was no page, so it is Today.
 *
 * Remembered in a ref during render rather than in an effect, because the page
 * underneath has to be the same on the very frame the layer opens; an effect would draw
 * one frame of the settings route through the page's routes first.
 */
export function usePageLocation(): { page: Location; overlay: boolean; close: () => void } {
  const location = useLocation()
  const navigate = useNavigate()
  const last = useRef<Page | null>(null)
  const overlay = isOverlayPath(location.pathname)
  if (!overlay) last.current = { location, index: historyIndex() }

  /*
   * Back through history when the page is behind us in it — pane changes replace
   * rather than push, but following the link from app settings to workspace settings
   * pushes, and either way Back is what returns the page as it was. With nothing to go
   * back to, the page is put in place of the settings entry instead, so Back from it
   * does not reopen them.
   */
  const close = useCallback(() => {
    const page = last.current
    const here = historyIndex()
    if (page && page.index !== null && here !== null && here > page.index) navigate(page.index - here)
    else navigate(page ? page.location : '/', { replace: true })
  }, [navigate])

  return { page: overlay ? (last.current?.location ?? ROOT) : location, overlay, close }
}

const CloseContext = createContext<(() => void) | null>(null)

/** How a settings screen drawn in the layer closes it; null when it is not in one. */
export const useOverlayClose = (): (() => void) | null => useContext(CloseContext)

/** Wider than this and a pane is mostly air; the sheet stops and centres instead. */
const SHEET_MAX_WIDTH = 1100

/**
 * How much of the page shows above the sheet. On macOS the window has no title bar of
 * its own and the traffic lights sit in this strip, so it is tall enough to clear them.
 */
const SHEET_TOP = window.api.platform === 'darwin' ? 44 : 28

/** Rising is a little slower than anything else that arrives: it travels the window. */
const RISE = { duration: 0.34, ease: EASE } as const
const FALL = { duration: 0.2, ease: [0.4, 0, 1, 1] } as const

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab goes round the sheet rather than out into the page under it, focus starts in the
 * sheet when it opens, and goes back to whatever had it when it closes.
 */
function useFocusTrap(open: boolean): React.RefObject<HTMLDivElement | null> {
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A pane that focuses a field of its own has already done better than this.
    if (!sheet.current?.contains(document.activeElement)) sheet.current?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent): void => {
      const root = sheet.current
      // A dialog opened from a pane is portalled outside the sheet and traps its own.
      if (e.key !== 'Tab' || !root || document.querySelector('[data-modal-backdrop]')) return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (!root.contains(at)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (at === first || at === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [open])

  return sheet
}

/**
 * The layer itself: a dimmed field over the page, and the sheet on it. Its content is
 * the settings routes, drawn against the location they were opened at and held there
 * while the sheet goes back down — otherwise the closing frames would draw the page's
 * address through the settings routes, which is nothing.
 *
 * Clicking the field closes it, as Escape and the ✕ in the sheet's bar do. Escape
 * itself is `SettingsLayout`'s, because it has to give a dialog or a field inside the
 * pane first refusal on the press.
 */
export function SettingsOverlay({
  open,
  close,
  children
}: {
  open: boolean
  close: () => void
  /** `<Route>` elements for the screens drawn in the layer. */
  children: ReactNode
}): React.JSX.Element {
  const location = useLocation()
  const held = useRef<Location>(location)
  if (open) held.current = location
  const still = useReducedMotion() ?? false
  const sheet = useFocusTrap(open)

  return (
    <AnimatePresence>
      {open && (
        <div
          key="settings-layer"
          className="fixed inset-0 z-40 flex flex-col items-center"
          style={{ paddingTop: SHEET_TOP }}
        >
          <motion.div
            className="settings-backdrop absolute inset-0"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: still ? 0.12 : 0.24 } }}
            exit={{ opacity: 0, transition: { duration: still ? 0.08 : 0.2 } }}
            onMouseDown={close}
          />
          <motion.div
            ref={sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            tabIndex={-1}
            className="settings-sheet relative flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-t-[14px] text-base-content shadow-[0_-12px_48px_-12px_rgba(0,0,0,0.3)] outline-none"
            style={{ maxWidth: SHEET_MAX_WIDTH }}
            initial={still ? { opacity: 0 } : { y: '100%' }}
            animate={still ? { opacity: 1, transition: { duration: 0.12 } } : { y: 0, transition: RISE }}
            exit={still ? { opacity: 0, transition: { duration: 0.08 } } : { y: '100%', transition: FALL }}
          >
            <CloseContext.Provider value={close}>
              <Routes location={held.current}>{children}</Routes>
            </CloseContext.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
