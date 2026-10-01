import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Routes, useLocation, useNavigate, type Location } from 'react-router-dom'
import { ENTER, EXIT } from '@/lib/motion'

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

/**
 * The layer itself. Its content is the settings routes, drawn against the location
 * they were opened at and held there while the layer leaves — otherwise the closing
 * frames would draw the page's address through the settings routes, which is nothing.
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-layer"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className="settings-sheet fixed inset-0 z-40 flex flex-col text-base-content"
          initial={{ opacity: 0, y: still ? 0 : 10, scale: still ? 1 : 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: ENTER }}
          exit={{ opacity: 0, y: still ? 0 : 6, transition: EXIT }}
        >
          <CloseContext.Provider value={close}>
            <Routes location={held.current}>{children}</Routes>
          </CloseContext.Provider>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
