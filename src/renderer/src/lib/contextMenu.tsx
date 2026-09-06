import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode
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

/**
 * A row that opens another menu beside it rather than doing anything itself.
 *
 * One level deep and no further, deliberately. A submenu is worth it when several
 * items are obviously one question — *New* is a question with three answers — and
 * stops being worth it the moment you have to hunt through a tree for the thing you
 * came for.
 */
export interface MenuSubmenu {
  label: string
  icon?: IconName
  items: MenuAction[]
}

export type MenuItem = MenuAction | MenuSubmenu | 'separator'

const isSubmenu = (item: MenuItem): item is MenuSubmenu => item !== 'separator' && 'items' in item

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
  /** Which submenu row is showing its own menu, by index. */
  const [expanded, setExpanded] = useState<number | null>(null)

  /*
   * The panels overlap by a few pixels but the pointer still has to travel from a row
   * to the panel beside it, and on the way it passes over the rows below. Closing on
   * the first row it touches would make the submenu impossible to reach diagonally, so
   * leaving a row only *schedules* the close and arriving anywhere in the submenu
   * calls it off.
   */
  const closing = useRef<number | undefined>(undefined)
  const expand = (index: number | null): void => {
    window.clearTimeout(closing.current)
    setExpanded(index)
  }
  const collapseSoon = (): void => {
    window.clearTimeout(closing.current)
    closing.current = window.setTimeout(() => setExpanded(null), 140)
  }

  const open = useCallback((event: React.MouseEvent, items: MenuItem[]): void => {
    if (items.length === 0) return
    event.preventDefault()
    event.stopPropagation()

    // Keep the menu on screen when the click lands near an edge.
    const height = items.reduce((total, item) => total + (item === 'separator' ? 9 : ITEM_HEIGHT), 12)
    const x = Math.min(event.clientX, window.innerWidth - WIDTH - 8)
    const y = Math.min(event.clientY, window.innerHeight - height - 8)
    setExpanded(null)
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), items })
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (): void => {
      setMenu(null)
      setExpanded(null)
    }
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

  useEffect(() => () => window.clearTimeout(closing.current), [])

  const value = useMemo(() => ({ open }), [open])

  const run = (action: MenuAction): void => {
    setMenu(null)
    setExpanded(null)
    if (action.confirm) setConfirming(action)
    else action.onSelect()
  }

  /** How far down the panel a row sits, measured the same way its height is. */
  const offsetOf = (items: MenuItem[], index: number): number =>
    4 + items.slice(0, index).reduce((t, i) => t + (i === 'separator' ? 9 : ITEM_HEIGHT), 0)

  /**
   * The row itself, whether it does something or opens more. One element for both so a
   * submenu row looks and highlights exactly like every other row — only its chevron
   * and what hovering it does are different.
   */
  const row = (
    item: MenuAction | MenuSubmenu,
    index: number,
    /** The submenu this row is in, or null when it is in the menu itself. */
    parent: number | null = null
  ): React.JSX.Element => {
    const submenu = isSubmenu(item)
    const danger = !submenu && item.danger
    return (
      <button
        key={index}
        disabled={!submenu && item.disabled}
        aria-haspopup={submenu || undefined}
        aria-expanded={submenu ? expanded === index : undefined}
        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition disabled:opacity-35 ${
          danger
            ? 'text-base-content/75 hover:bg-error/10 hover:text-error'
            : submenu && expanded === index
              ? 'bg-base-200'
              : 'hover:bg-base-200'
        }`}
        /* Travelling down the rows closes an open submenu; travelling *through* one
           must not, which is the whole difference between the two cases. */
        onMouseEnter={() => (submenu ? expand(index) : parent !== null ? expand(parent) : collapseSoon())}
        onClick={() => (submenu ? expand(index) : run(item))}
      >
        {item.icon && <Icon name={item.icon} size={13} className="opacity-55" />}
        <span className="flex-1">{item.label}</span>
        {submenu && <Icon name="chevronRight" size={12} className="opacity-40" />}
      </button>
    )
  }

  const panel = (
    id: string,
    x: number,
    y: number,
    children: ReactNode,
    extra: Record<string, unknown> = {}
  ): React.JSX.Element => (
    <motion.div
      key={id}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
      transition={{ duration: 0.13, ease: [0.32, 0.72, 0, 1] }}
      data-context-menu
      role="menu"
      style={{ left: x, top: y, width: WIDTH, transformOrigin: 'top left' }}
      className="glass-raised hairline fixed z-[81] overflow-hidden rounded-box border bg-base-100 py-1 shadow-xl shadow-black/15"
      {...extra}
    >
      {children}
    </motion.div>
  )

  /*
   * The open submenu, worked out from where its row is rather than from the DOM: the
   * panel is a sibling of the menu and not a child of it, because the menu clips what
   * overflows it and a submenu is nothing but overflow.
   */
  const child = ((): React.JSX.Element | null => {
    if (!menu || expanded === null) return null
    const item = menu.items[expanded]
    if (!item || !isSubmenu(item)) return null
    const height = item.items.length * ITEM_HEIGHT + 12
    // Beside the row by preference, back over the parent when there is no room to the
    // right — the same rule the menu itself follows at the edge of the window.
    const right = menu.x + WIDTH - 4
    const x = right + WIDTH > window.innerWidth - 8 ? menu.x - WIDTH + 4 : right
    const y = Math.min(menu.y + offsetOf(menu.items, expanded) - 4, window.innerHeight - height - 8)
    return panel(
      'submenu',
      Math.max(8, x),
      Math.max(8, y),
      item.items.map((action, i) => row(action, i, expanded)),
      {
        className:
          'glass-raised hairline fixed z-[82] overflow-hidden rounded-box border bg-base-100 py-1 shadow-xl shadow-black/15',
        onMouseEnter: () => expand(expanded),
        onMouseLeave: collapseSoon
      }
    )
  })()

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
            {panel(
              'menu',
              menu.x,
              menu.y,
              menu.items.map((item, index) =>
                item === 'separator' ? (
                  <div key={index} className="hairline my-1 border-t" />
                ) : (
                  row(item, index)
                )
              ),
              { onMouseLeave: collapseSoon }
            )}
            {/* Its own presence, so opening and closing a submenu animates rather than
                blinking — the menu around it is not coming or going. */}
            <AnimatePresence>{child}</AnimatePresence>
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
