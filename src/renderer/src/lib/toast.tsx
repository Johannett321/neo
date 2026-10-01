import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Icon, type IconName } from '@/components/Icon'

interface Toast {
  id: number
  title: string
  detail?: string
  icon?: IconName
  /** Where clicking the toast takes you. */
  to?: string
  /**
   * `error` is a write that did not happen — said in the warm colour and kept until
   * dismissed, because a thing you believed was saved and was not must not slip away
   * on a timer while you are looking at something else.
   */
  tone?: 'success' | 'error' | 'info'
  /** Buttons, for the one or two things worth doing about it right here. */
  actions?: { label: string; onClick: () => void }[]
  /** Stays until dismissed or replaced — set for anything that needs an answer. */
  sticky?: boolean
  /** A toast with a key replaces the one already showing under it, rather than stacking. */
  key?: string
}

const ToastContext = createContext<{ push: (toast: Omit<Toast, 'id'>) => void; dismissKey: (key: string) => void } | null>(null)

const LIFETIME_MS = 6000

/**
 * Things created from the New dialog land somewhere you are not looking — a board
 * column, a decision log, a meeting list. The toast says what was made, where it went,
 * and takes you there, so a quick capture does not feel like it vanished.
 */
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const navigate = useNavigate()

  const dismiss = useCallback((id: number): void => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (toast: Omit<Toast, 'id'>): void => {
      const id = nextId.current++
      setToasts((list) => [...list.filter((t) => !toast.key || t.key !== toast.key).slice(-2), { ...toast, id }])
      if (!toast.sticky && toast.tone !== 'error') window.setTimeout(() => dismiss(id), LIFETIME_MS)
    },
    [dismiss]
  )

  const dismissKey = useCallback((key: string): void => {
    setToasts((list) => list.filter((t) => t.key !== key))
  }, [])

  const value = useMemo(() => ({ push, dismissKey }), [push, dismissKey])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              className="pointer-events-auto"
            >
              <div className="glass-raised hairline flex items-start gap-3 rounded-box border bg-base-100 px-3.5 py-3 shadow-xl shadow-black/10">
                <span
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                    toast.tone === 'error'
                      ? 'bg-warning/15 text-warning'
                      : toast.tone === 'info'
                        ? 'bg-base-content/8 text-base-content/60'
                        : 'bg-success/12 text-success'
                  }`}
                >
                  <Icon name={toast.icon ?? 'check'} size={13} strokeWidth={2.2} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{toast.title}</div>
                  {toast.detail && (
                    <div
                      className={`text-[11px] text-base-content/50 ${toast.tone === 'error' ? 'line-clamp-3' : 'truncate'}`}
                    >
                      {toast.detail}
                    </div>
                  )}
                  {toast.actions && toast.actions.length > 0 && (
                    <div className="mt-1.5 flex gap-3">
                      {toast.actions.map((action) => (
                        <button
                          key={action.label}
                          className="text-[11px] font-medium text-primary hover:underline"
                          onClick={() => {
                            action.onClick()
                            dismiss(toast.id)
                          }}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {toast.to && (
                    <button
                      className="mt-1 text-[11px] font-medium text-primary hover:underline"
                      onClick={() => {
                        navigate(toast.to as string)
                        dismiss(toast.id)
                      }}
                    >
                      Take me there
                    </button>
                  )}
                </div>

                <button
                  className="-mr-1 -mt-1 rounded p-1 text-base-content/30 transition hover:text-base-content"
                  onClick={() => dismiss(toast.id)}
                  aria-label="Dismiss"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

/** For code that may run above the provider — a mutation's refusal says so if it can. */
export function useToastIfAny(): ((toast: Omit<Toast, 'id'>) => void) | null {
  return useContext(ToastContext)?.push ?? null
}

export function useDismissToast(): (key: string) => void {
  return useContext(ToastContext)?.dismissKey ?? (() => {})
}

export function useToast(): (toast: Omit<Toast, 'id'>) => void {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast used outside ToastProvider')
  return value.push
}
