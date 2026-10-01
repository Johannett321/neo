import { useEffect, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { PanelTransition } from './PageTransition'
import { PageHeader } from './primitives'
import { useOverlayClose } from './SettingsOverlay'

export interface SettingsPane {
  id: string
  label: string
  icon: IconName
  /** One line under the pane's heading, saying what this pane is for. */
  description?: string
  /** Panes that can lose you something are marked, so they never get clicked idly. */
  tone?: 'default' | 'warn'
  render: () => ReactNode
}

/**
 * Every settings screen in the app is this shape: a short list of panes down the left,
 * one pane at a time on the right. Settings used to be one long scroll of sections,
 * which meant the thing you came to change was never where you left it. A pane is a
 * place — you learn where "Data" is once and it stays there.
 *
 * The list is deliberately short. If a screen needs more than about five entries, the
 * screen is doing too much rather than the list being too small.
 *
 * Which pane is open lives in the URL rather than in this component, so anything that
 * knows what it wants changed can send you straight to it — the assistant's "you have
 * no key" panel sends you to the pane that holds the key, not to the front of the
 * screen with an instruction to go and find it.
 *
 * The app's settings and a workspace's are drawn in the layer over the whole window
 * (`SettingsOverlay`), and there the same panes take the window's shape instead: a bar
 * across the top with the title and the ✕, the list as a column down the left edge, and
 * the pane scrolling on its own on the right. A project's settings stay a page.
 */
export function SettingsLayout({
  title,
  mark,
  subtitle,
  actions,
  exitTo,
  panes
}: {
  /** Left out where the screen already has a heading of its own, as a project does. */
  title?: ReactNode
  /** Drawn before the title in the layer's bar: the workspace's own mark, say. */
  mark?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** Where Escape puts you when the screen is a page: the one it was opened on top of. */
  exitTo: string
  panes: SettingsPane[]
}): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  // An unknown pane — a stale link, another screen's pane name — is not an error
  // worth showing anyone; it just opens on the first one.
  const active = panes.find((p) => p.id === params.get('pane')) ?? panes[0]
  const navigate = useNavigate()
  const closeLayer = useOverlayClose()

  /** Replaces rather than pushes: the panes are one screen, not a trail through it. */
  const select = (id: string): void => {
    if (id === panes[0]?.id) setParams({}, { replace: true })
    else setParams({ pane: id }, { replace: true })
  }

  /**
   * Settings is somewhere you go and come back from, so Escape leaves it — the same
   * key that closes a dialog. Anything sitting on top gets first refusal on the press:
   * a dialog, the palette or a menu closing itself with this very keystroke, and a
   * field you are typing in, which blurs (and so saves) instead. Leaving then takes a
   * second press. The menus that already stop the event in the capture phase never
   * reach this listener at all.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-modal-backdrop], [data-overlay], [role="alertdialog"]')) return

      const focused = document.activeElement
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
        focused.blur()
        return
      }
      if (closeLayer) closeLayer()
      else navigate(exitTo)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, exitTo, closeLayer])

  const list = panes.map((pane) => {
    const isActive = pane.id === active?.id
    return (
      <button
        key={pane.id}
        onClick={() => select(pane.id)}
        aria-current={isActive ? 'page' : undefined}
        className={`mb-0.5 flex w-full items-center gap-2.5 rounded-field px-2.5 py-[7px] text-left text-[13px] transition ${
          isActive
            ? closeLayer
              ? 'glass-lift bg-base-100 font-medium text-base-content shadow-sm'
              : 'bg-base-200 font-medium text-base-content'
            : `hover:bg-base-content/5 ${
                pane.tone === 'warn' ? 'text-base-content/50' : 'text-base-content/65'
              }`
        }`}
      >
        <Icon name={pane.icon} size={15} className="opacity-70" />
        {pane.label}
      </button>
    )
  })

  const body = active && (
    <PanelTransition id={active.id}>
      <div className="mb-4">
        <h2
          className={`text-[15px] font-semibold tracking-[-0.01em] ${
            active.tone === 'warn' ? 'text-warning' : ''
          }`}
        >
          {active.label}
        </h2>
        {active.description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/50">{active.description}</p>
        )}
      </div>
      {active.render()}
    </PanelTransition>
  )

  if (closeLayer) {
    return (
      <>
        {/*
          The layer's title bar is the window's, so it is the strip you drag and it
          starts past the traffic lights on macOS, exactly as the sidebar's does.
        */}
        <header
          className="glass-chrome drag-region hairline flex h-[52px] shrink-0 items-center gap-3 border-b pr-3"
          style={{ paddingLeft: window.api.platform === 'darwin' ? 94 : 16 }}
        >
          {mark}
          <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em]">{title}</h1>
          {actions}
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={closeLayer}
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="glass-chrome hairline scroll-area bg-base-200/60 flex w-[220px] shrink-0 flex-col border-r px-3 py-4">
            {list}
            {/* What this screen is *not* about goes at the foot of the list, out of the way. */}
            {subtitle && (
              <div className="mt-auto px-2.5 pt-6 text-[11.5px] leading-relaxed text-base-content/45">
                {subtitle}
              </div>
            )}
          </nav>

          <div className="glass-page scroll-area min-w-0 flex-1">
            <div className="max-w-2xl px-10 py-8">{body}</div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {title !== undefined && <PageHeader title={title} subtitle={subtitle} actions={actions} />}

      <div className="flex items-start gap-8">
        <nav className="sticky top-0 w-[164px] shrink-0">{list}</nav>
        <div className="min-w-0 max-w-2xl flex-1">{body}</div>
      </div>
    </>
  )
}
