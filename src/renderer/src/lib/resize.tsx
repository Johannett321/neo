import { useCallback, useEffect, useRef, useState } from 'react'
import { PANELS, clampPanelWidth, type PanelId } from '@shared/panels'
import type { Settings } from '@shared/types'
import { call, useApi } from './api'

/**
 * Drag a panel's edge to resize it — one implementation for every side panel.
 *
 * The width is held locally while you are dragging and written to settings once you
 * let go: a preference is worth remembering, but not worth a database write per pixel
 * of mouse movement. The listeners go on the window rather than on the handle,
 * because a pointer moving faster than the layout follows leaves a 6px strip behind
 * immediately, and a drag that stops the moment you move quickly is worse than none.
 *
 * The panel's own edge is the anchor, read once when you grab it, rather than the
 * window's — a panel is not always against the side of the screen. The meeting page's
 * details column has the assistant to the right of it whenever the assistant is open,
 * and measuring from the window would make it jump by the assistant's width.
 */
export function useResizablePanel<T extends HTMLElement>(
  panel: PanelId
): {
  width: number
  dragging: boolean
  /** Put this on the panel element itself; it is what the drag measures from. */
  ref: React.RefObject<T | null>
  onGrab: (event: React.PointerEvent) => void
  /** Double-clicking the handle puts the panel back where it started. */
  onReset: () => void
} {
  const spec = PANELS[panel]
  const settings = useApi('settings:get')
  const stored = settings.data?.[spec.setting] ?? spec.default
  const [width, setWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<T>(null)

  // Until you drag it, the panel is whatever was saved — including after a reload.
  const current = width ?? stored

  const remember = useCallback(
    (value: number): void => {
      void call('settings:save', { [spec.setting]: Math.round(value) } as Partial<Settings>)
    },
    [spec.setting]
  )

  const onGrab = useCallback(
    (event: React.PointerEvent): void => {
      event.preventDefault()
      setDragging(true)
      let latest = current

      const box = ref.current?.getBoundingClientRect()
      const anchor =
        spec.side === 'right' ? (box?.right ?? window.innerWidth) : (box?.left ?? 0)

      const onMove = (move: PointerEvent): void => {
        const raw = spec.side === 'right' ? anchor - move.clientX : move.clientX - anchor
        latest = clampPanelWidth(panel, raw, window.innerWidth)
        setWidth(latest)
      }
      const onUp = (): void => {
        setDragging(false)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        remember(latest)
      }

      // Dragging across a page of text selects all of it otherwise, and the cursor
      // has to keep saying "resize" even once the pointer is off the handle.
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [current, panel, remember, spec.side]
  )

  const onReset = useCallback((): void => {
    setWidth(spec.default)
    remember(spec.default)
  }, [remember, spec.default])

  // A window narrowed after the fact must not leave the panel wider than it can be.
  useEffect(() => {
    const onResize = (): void =>
      setWidth((w) => clampPanelWidth(panel, w ?? stored, window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [panel, stored])

  return {
    width: clampPanelWidth(panel, current, window.innerWidth),
    dragging,
    ref,
    onGrab,
    onReset
  }
}

/**
 * The panel's outer edge, which is also the handle: 6px of grab area with a hairline
 * that shows itself on approach and stays lit while you are using it, so a panel does
 * not look decorated when nobody is touching it. The panel it sits in must be
 * positioned (`relative`).
 */
export function PanelResizeHandle({
  side,
  dragging,
  onGrab,
  onReset,
  label
}: {
  /** The side of the *window* the panel is anchored to; the handle goes opposite. */
  side: 'left' | 'right'
  dragging: boolean
  onGrab: (event: React.PointerEvent) => void
  onReset: () => void
  label: string
}): React.JSX.Element {
  const edge = side === 'right' ? 'left-0' : 'right-0'
  return (
    <div
      className={`group absolute inset-y-0 ${edge} z-20 w-1.5 cursor-col-resize`}
      onPointerDown={onGrab}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize, double-click to reset"
    >
      <span
        className={`absolute inset-y-0 ${edge} w-0.5 bg-primary transition-opacity group-hover:opacity-100 ${
          dragging ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  )
}
