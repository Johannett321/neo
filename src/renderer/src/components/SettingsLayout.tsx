import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { PanelTransition } from './PageTransition'
import { PageHeader } from './primitives'

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
 */
export function SettingsLayout({
  title,
  subtitle,
  actions,
  exitTo,
  panes
}: {
  /** Left out where the screen already has a heading of its own, as a project does. */
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** Where Escape puts you: the screen this one was opened on top of. */
  exitTo: string
  panes: SettingsPane[]
}): React.JSX.Element {
  const [activeId, setActiveId] = useState(panes[0]?.id ?? '')
  const active = panes.find((p) => p.id === activeId) ?? panes[0]
  const navigate = useNavigate()

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
      navigate(exitTo)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, exitTo])

  return (
    <>
      {title !== undefined && <PageHeader title={title} subtitle={subtitle} actions={actions} />}

      <div className="flex items-start gap-8">
        <nav className="sticky top-0 w-[164px] shrink-0">
          {panes.map((pane) => {
            const isActive = pane.id === active?.id
            return (
              <button
                key={pane.id}
                onClick={() => setActiveId(pane.id)}
                className={`mb-0.5 flex w-full items-center gap-2.5 rounded-field px-2.5 py-[7px] text-left text-[13px] transition ${
                  isActive
                    ? 'bg-base-200 font-medium text-base-content'
                    : `hover:bg-base-content/5 ${
                        pane.tone === 'warn' ? 'text-base-content/50' : 'text-base-content/65'
                      }`
                }`}
              >
                <Icon name={pane.icon} size={15} className="opacity-70" />
                {pane.label}
              </button>
            )
          })}
        </nav>

        <div className="min-w-0 max-w-2xl flex-1">
          {active && (
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
                  <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/50">
                    {active.description}
                  </p>
                )}
              </div>
              {active.render()}
            </PanelTransition>
          )}
        </div>
      </div>
    </>
  )
}
