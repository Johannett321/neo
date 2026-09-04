import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon, type IconName } from '@/components/Icon'
import { ConfirmDialog } from '@/components/primitives'

export interface MenuAction {
  label: string
  icon?: IconName
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** When set, the action asks before running. */
  confirm?: { title: string; body?: string; confirmLabel?: string }
}

export type MenuItem = MenuAction | 'separator'

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
}

const ContextMenuContext = createContext<{
  open: (event: React.MouseEvent, items: MenuItem[]) => void
} | null>(null)

const WIDTH = 210
const ITEM_HEIGHT = 30

/**
 * One right-click menu for the whole app. Call sites describe what the menu should
 * contain and nothing else — position, flipping at the screen edge, dismissal and
 * the confirmation step for anything destructive all live here.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [confirming, setConfirming] = useState<MenuAction | null>(null)

  const open = useCallback((event: React.MouseEvent, items: MenuItem[]): void => {
    if (items.length === 0) return
    event.preventDefault()
    event.stopPropagation()

    // Keep the menu on screen when the click lands near an edge.
    const height = items.reduce((total, item) => total + (item === 'separator' ? 9 : ITEM_HEIGHT), 12)
    const x = Math.min(event.clientX, window.innerWidth - WIDTH - 8)
    const y = Math.min(event.clientY, window.innerHeight - height - 8)
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), items })
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // Scrolling under an open menu leaves it pointing at nothing.
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const value = useMemo(() => ({ open }), [open])

  const run = (action: MenuAction): void => {
    setMenu(null)
    if (action.confirm) setConfirming(action)
    else action.onSelect()
  }

  return (
    <ContextMenuContext.Provider value={value}>
      {children}

      <AnimatePresence>
        {menu && (
          <>
            <div
              className="fixed inset-0 z-[80]"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu(null)
              }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
              transition={{ duration: 0.13, ease: [0.32, 0.72, 0, 1] }}
              data-context-menu
              role="menu"
              style={{ left: menu.x, top: menu.y, width: WIDTH, transformOrigin: 'top left' }}
              className="hairline fixed z-[81] overflow-hidden rounded-box border bg-base-100 py-1 shadow-xl shadow-black/15"
            >
              {menu.items.map((item, index) =>
                item === 'separator' ? (
                  <div key={index} className="hairline my-1 border-t" />
                ) : (
                  <button
                    key={index}
                    disabled={item.disabled}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition disabled:opacity-35 ${
                      item.danger
                        ? 'text-base-content/75 hover:bg-error/10 hover:text-error'
                        : 'hover:bg-base-200'
                    }`}
                    onClick={() => run(item)}
                  >
                    {item.icon && <Icon name={item.icon} size={13} className="opacity-55" />}
                    {item.label}
                  </button>
                )
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ''}
        body={confirming?.confirm?.body}
        confirmLabel={confirming?.confirm?.confirmLabel ?? 'Delete'}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          confirming?.onSelect()
          setConfirming(null)
        }}
      />
    </ContextMenuContext.Provider>
  )
}

export function useContextMenu(): (event: React.MouseEvent, items: MenuItem[]) => void {
  const value = useContext(ContextMenuContext)
  if (!value) throw new Error('useContextMenu used outside ContextMenuProvider')
  return value.open
}
