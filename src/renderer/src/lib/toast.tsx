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
}

const ToastContext = createContext<{ push: (toast: Omit<Toast, 'id'>) => void } | null>(null)

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
      setToasts((list) => [...list.slice(-2), { ...toast, id }])
      window.setTimeout(() => dismiss(id), LIFETIME_MS)
    },
    [dismiss]
  )

  const value = useMemo(() => ({ push }), [push])

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
              <div className="hairline flex items-start gap-3 rounded-box border bg-base-100 px-3.5 py-3 shadow-xl shadow-black/10">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
                  <Icon name={toast.icon ?? 'check'} size={13} strokeWidth={2.2} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{toast.title}</div>
                  {toast.detail && (
                    <div className="truncate text-[11px] text-base-content/50">{toast.detail}</div>
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

export function useToast(): (toast: Omit<Toast, 'id'>) => void {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast used outside ToastProvider')
  return value.push
}
