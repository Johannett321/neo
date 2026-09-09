import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { CanvasEdge, CanvasNode, CanvasSide, Canvas as CanvasType, JSONCanvas } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { differs, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { useContextMenu, type MenuItem, type MenuSubmenu } from '@/lib/contextMenu'
import { EmptyState } from '@/components/primitives'

const NODE_WIDTH = 250
const NODE_HEIGHT = 60
const NODE_MIN_WIDTH = 120
const NODE_MIN_HEIGHT = 40
const GROUP_MIN_WIDTH = 300
const GROUP_MIN_HEIGHT = 160
const HANDLE_SIZE = 8
const RESIZE_HANDLE_SIZE = 7
const GRID_SIZE = 20
const CONNECT_SNAP = 40

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

function nearestSide(node: CanvasNode, x: number, y: number): { side: CanvasSide; distance: number } {
  const sides: CanvasSide[] = ['top', 'right', 'bottom', 'left']
  let best: { side: CanvasSide; distance: number } | null = null
  for (const side of sides) {
    const p = sidePoint(node, side)
    const d = Math.hypot(p.x - x, p.y - y)
    if (!best || d < best.distance) best = { side, distance: d }
  }
  return best!
}

function findConnectTarget(
  nodes: CanvasNode[],
  excludeId: string,
  x: number,
  y: number
): { node: CanvasNode; side: CanvasSide } | null {
  let best: { node: CanvasNode; side: CanvasSide; distance: number } | null = null
  for (const node of nodes) {
    if (node.id === excludeId) continue
    const { side, distance } = nearestSide(node, x, y)
    if (distance > CONNECT_SNAP) continue
    if (!best || distance < best.distance) best = { node, side, distance }
  }
  return best ? { node: best.node, side: best.side } : null
}
const CANVAS_COLORS: Record<string, string> = {
  '1': '#ef4444',
  '2': '#f97316',
  '3': '#eab308',
  '4': '#22c55e',
  '5': '#06b6d4',
  '6': '#a855f7'
}

/** The same six, said rather than shown: a menu row has no room for a swatch. */
const CANVAS_COLOR_NAMES: Record<string, string> = {
  '1': 'Red',
  '2': 'Orange',
  '3': 'Yellow',
  '4': 'Green',
  '5': 'Cyan',
  '6': 'Purple'
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function sidePoint(node: CanvasNode, side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y }
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 }
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height }
    case 'left':
    default:
      return { x: node.x, y: node.y + node.height / 2 }
  }
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

function nodeColorClass(color?: string): string {
  if (!color) return 'border-base-content/10 bg-base-100'
  return `border-[${CANVAS_COLORS[color] ?? color}] bg-base-100`
}

function nodeStyle(color?: string): React.CSSProperties {
  const c = color ? (CANVAS_COLORS[color] ?? color) : undefined
  return c ? { borderColor: c, '--node-accent': c } as React.CSSProperties : {}
}

/**
 * A visual canvas editor: an infinite board of text cards, groups and the lines between
 * them, saved in the open JSON Canvas format so the file can be opened in Obsidian.
 */
export function CanvasEditor(): React.JSX.Element {
  const { id: projectId = '', canvasId = '' } = useParams()
  const { data } = useApi('project:get', { id: projectId })
  const [params] = useSearchParams()
  const startIn = params.get('in')
  const navigate = useNavigate()
  const save = useApiMutation('canvas:save')
  const remove = useApiMutation('canvas:delete')

  const [title, setTitle] = useState('')
  const [canvas, setCanvas] = useState<JSONCanvas>({ nodes: [], edges: [] })
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const idRef = useRef<string | null>(null)
  const draft = useRef({ title, canvas })
  const saved = useRef({ title: '', data: { nodes: [] as CanvasNode[], edges: [] as CanvasType['data']['edges'] } })
  const deleted = useRef(false)
  const touched = useRef(false)
  draft.current = { title, canvas }

  const openMenu = useContextMenu()

  const canvasRef = useRef<HTMLDivElement>(null)
  const boxSelectRef = useRef<HTMLDivElement>(null)
  /** An edge whose label was just asked for, so the input it grows takes the caret. */
  const labelFocusRef = useRef<string | null>(null)
  /** Whether the right button has panned since it went down, so a pan does not end in a menu. */
  const pannedRef = useRef(false)
  const connectingLineRef = useRef<SVGLineElement>(null)
  const connectingRef = useRef<{ nodeId: string; side: CanvasSide } | null>(null)
  const boxSelectStateRef = useRef<{ startX: number; startY: number } | null>(null)
  const bootstrappedRef = useRef(false)
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<{ nodeId: string; side: CanvasSide } | null>(null)
  const dragRef = useRef<{
    ids: string[]
    startX: number
    startY: number
    positions: Map<string, { x: number; y: number }>
  } | null>(null)
  const resizeRef = useRef<{
    id: string
    corner: ResizeCorner
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    startNodeX: number
    startNodeY: number
  } | null>(null)
  const [panning, setPanning] = useState<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null
  )
  const [spaceHeld, setSpaceHeld] = useState(false)

  const canvasItem = data?.canvases.find((c) => c.id === canvasId) ?? null
  const missing = Boolean(data) && canvasId !== 'new' && !canvasItem && idRef.current !== canvasId

  useEffect(() => {
    if (canvasId === 'new' || canvasId === idRef.current || !canvasItem) return
    idRef.current = canvasItem.id
    touched.current = false
    saved.current = { title: canvasItem.title, data: canvasItem.data }
    setTitle(canvasItem.title)
    setCanvas(canvasItem.data)
    setSavedAt(canvasItem.updatedAt)
    setSelectedIds(new Set())
  }, [canvasId, canvasItem])

  /**
   * Deleting anything takes the lines with it: an edge whose card has gone describes a
   * relationship between something and nothing. The keyboard and the menu share this
   * so the two can never disagree about what a delete takes.
   */
  const deleteIds = useCallback((ids: Set<string>) => {
    if (ids.size === 0) return
    setCanvas((prev) => ({
      nodes: prev.nodes.filter((n) => !ids.has(n.id)),
      edges: prev.edges.filter((e) => !(ids.has(e.id) || ids.has(e.fromNode) || ids.has(e.toNode)))
    }))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
    touched.current = true
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (deleted.current || !touched.current) return
    const next = { title: draft.current.title.trim(), data: draft.current.canvas }
    if (!differs(next, saved.current)) return
    if (!next.title && next.data.nodes.length === 0 && !idRef.current) return
    const result = await save.mutateAsync({
      id: idRef.current ?? undefined,
      projectId,
      ...(idRef.current ? {} : { folderId: startIn }),
      ...next
    })
    if (deleted.current) return
    saved.current = next
    idRef.current = result.id
    setSavedAt(result.updatedAt)
    if (canvasId === 'new') {
      navigate(`/projects/${projectId}/canvas/${result.id}${startIn ? `?in=${startIn}` : ''}`, { replace: true })
    }
  }, [navigate, canvasId, projectId, save, startIn])

  const flushRef = useRef(flush)
  flushRef.current = flush

  const dirty = differs({ title: title.trim(), data: canvas }, saved.current)

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => void flushRef.current(), 800)
    return () => clearTimeout(timer)
  }, [title, canvas, dirty])

  useEffect(() => () => void flushRef.current(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flushRef.current()
      }
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editingNodeId) return
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        deleteIds(selectedIds)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [deleteIds, editingNodeId, selectedIds])

  const screenToCanvas = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const cx = rect ? sx - rect.left : sx
      const cy = rect ? sy - rect.top : sy
      return { x: (cx - viewport.x) / viewport.zoom, y: (cy - viewport.y) / viewport.zoom }
    },
    [viewport]
  )

  const addTextNode = useCallback(
    (at?: { x: number; y: number }) => {
      const center = screenToCanvas(
        (canvasRef.current?.clientWidth ?? 800) / 2,
        (canvasRef.current?.clientHeight ?? 500) / 2
      )
      const node: CanvasNode = {
        id: uid(),
        type: 'text',
        text: '',
        x: snapToGrid((at?.x ?? center.x) - NODE_WIDTH / 2),
        y: snapToGrid((at?.y ?? center.y) - NODE_HEIGHT / 2),
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      }
      setCanvas((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
      setSelectedIds(new Set([node.id]))
      setEditingNodeId(node.id)
      touched.current = true
    },
    [screenToCanvas]
  )

  const addGroup = useCallback(
    (at?: { x: number; y: number }) => {
    const center = screenToCanvas(
      (canvasRef.current?.clientWidth ?? 800) / 2,
      (canvasRef.current?.clientHeight ?? 500) / 2
    )
    const node: CanvasNode = {
      id: uid(),
      type: 'group',
      label: '',
      x: snapToGrid((at?.x ?? center.x) - GROUP_MIN_WIDTH / 2),
      y: snapToGrid((at?.y ?? center.y) - GROUP_MIN_HEIGHT / 2),
      width: GROUP_MIN_WIDTH,
      height: GROUP_MIN_HEIGHT
    }
    setCanvas((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    setSelectedIds(new Set([node.id]))
    touched.current = true
    },
    [screenToCanvas]
  )

  const fitAll = useCallback(() => {
    if (canvas.nodes.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 })
      return
    }
    const xs = canvas.nodes.map((n) => n.x)
    const ys = canvas.nodes.map((n) => n.y)
    const rights = canvas.nodes.map((n) => n.x + n.width)
    const bottoms = canvas.nodes.map((n) => n.y + n.height)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...rights)
    const maxY = Math.max(...bottoms)
    const pad = 80
    const w = (canvasRef.current?.clientWidth ?? 800) - pad * 2
    const h = (canvasRef.current?.clientHeight ?? 500) - pad * 2
    const zoom = Math.min(w / (maxX - minX || 1), h / (maxY - minY || 1), 1.5)
    setViewport({
      x: pad - minX * zoom,
      y: pad - minY * zoom,
      zoom
    })
  }, [canvas.nodes])

  useEffect(() => {
    if (canvasId === 'new' && !bootstrappedRef.current) {
      bootstrappedRef.current = true
      addTextNode()
    }
  }, [canvasId, addTextNode])

  useEffect(() => {
    if (canvasId !== 'new' || canvas.nodes.length === 0) return
    fitAll()
  }, [canvasId, canvas.nodes.length, fitAll])

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        const point = screenToCanvas(e.clientX, e.clientY)
        const factor = e.deltaY > 0 ? 0.9 : 1.1
        setViewport((v) => {
          const zoom = Math.max(0.1, Math.min(3, v.zoom * factor))
          return {
            x: e.clientX - (e.clientX - v.x) * (zoom / v.zoom) - point.x * zoom + point.x * v.zoom,
            y: e.clientY - (e.clientY - v.y) * (zoom / v.zoom) - point.y * zoom + point.y * v.zoom,
            zoom
          }
        })
      } else {
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    },
    [screenToCanvas]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || e.button === 2 || spaceHeld) {
        e.preventDefault()
        pannedRef.current = false
        canvasRef.current?.setPointerCapture(e.pointerId)
        setPanning({ startX: e.clientX, startY: e.clientY, originX: viewport.x, originY: viewport.y })
        return
      }
      if (e.button !== 0) return
      if (e.target === canvasRef.current || (e.target as HTMLElement).dataset?.role === 'canvas-surface') {
        canvasRef.current?.setPointerCapture(e.pointerId)
        if (!e.shiftKey) setSelectedIds(new Set())
        const rect = canvasRef.current?.getBoundingClientRect()
        const localX = e.clientX - (rect?.left ?? 0)
        const localY = e.clientY - (rect?.top ?? 0)
        boxSelectStateRef.current = { startX: localX, startY: localY }
        const el = boxSelectRef.current
        if (el) {
          el.style.display = 'block'
          el.style.left = `${localX}px`
          el.style.top = `${localY}px`
          el.style.width = '0px'
          el.style.height = '0px'
        }
      }
    },
    [screenToCanvas, spaceHeld, viewport.x, viewport.y]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (panning) {
        if (Math.abs(e.clientX - panning.startX) > 3 || Math.abs(e.clientY - panning.startY) > 3) {
          pannedRef.current = true
        }
        setViewport((v) => ({
          ...v,
          x: panning.originX + (e.clientX - panning.startX),
          y: panning.originY + (e.clientY - panning.startY)
        }))
        return
      }
      if (boxSelectStateRef.current) {
        const rect = canvasRef.current?.getBoundingClientRect()
        const localX = e.clientX - (rect?.left ?? 0)
        const localY = e.clientY - (rect?.top ?? 0)
        const { startX, startY } = boxSelectStateRef.current
        const el = boxSelectRef.current
        if (el) {
          const minX = Math.min(startX, localX)
          const minY = Math.min(startY, localY)
          const w = Math.abs(localX - startX)
          const h = Math.abs(localY - startY)
          el.style.left = `${minX}px`
          el.style.top = `${minY}px`
          el.style.width = `${w}px`
          el.style.height = `${h}px`
        }
      }
    },
    [panning]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (panning) {
        setPanning(null)
        return
      }
      if (boxSelectStateRef.current) {
        const rect = canvasRef.current?.getBoundingClientRect()
        const localX = e.clientX - (rect?.left ?? 0)
        const localY = e.clientY - (rect?.top ?? 0)
        const start = boxSelectStateRef.current
        const p = screenToCanvas(localX + (rect?.left ?? 0), localY + (rect?.top ?? 0))
        const startCanvas = screenToCanvas(start.startX + (rect?.left ?? 0), start.startY + (rect?.top ?? 0))
        const minX = Math.min(startCanvas.x, p.x)
        const maxX = Math.max(startCanvas.x, p.x)
        const minY = Math.min(startCanvas.y, p.y)
        const maxY = Math.max(startCanvas.y, p.y)
        const inside = new Set(
          canvas.nodes.filter((n) => n.x >= minX && n.x + n.width <= maxX && n.y >= minY && n.y + n.height <= maxY).map((n) => n.id)
        )
        if (e.shiftKey) {
          const next = new Set(selectedIds)
          inside.forEach((id) => next.add(id))
          setSelectedIds(next)
        } else {
          setSelectedIds(inside)
        }
        boxSelectStateRef.current = null
        const el = boxSelectRef.current
        if (el) el.style.display = 'none'
      }
    },
    [panning, canvas.nodes, selectedIds, screenToCanvas]
  )

  const startDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0 || spaceHeld || connectingRef.current || dragRef.current) return
      e.stopPropagation()
      if (e.shiftKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else if (!selectedIds.has(id)) {
        setSelectedIds(new Set([id]))
      }
      const ids = e.shiftKey ? Array.from(selectedIds) : selectedIds.has(id) ? Array.from(selectedIds) : [id]
      const p = screenToCanvas(e.clientX, e.clientY)
      const positions = new Map<string, { x: number; y: number }>()
      for (const node of canvas.nodes) {
        if (ids.includes(node.id)) positions.set(node.id, { x: node.x, y: node.y })
      }
      dragRef.current = { ids, startX: p.x, startY: p.y, positions }

      const target = e.currentTarget
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      const move = (ev: PointerEvent): void => {
        if (!dragRef.current) return
        const p2 = screenToCanvas(ev.clientX, ev.clientY)
        const dx = p2.x - dragRef.current.startX
        const dy = p2.y - dragRef.current.startY
        setCanvas((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => {
            const start = dragRef.current!.positions.get(n.id)
            if (!start) return n
            return { ...n, x: snapToGrid(start.x + dx), y: snapToGrid(start.y + dy) }
          })
        }))
      }
      const up = (ev: PointerEvent): void => {
        if (dragRef.current) touched.current = true
        dragRef.current = null
        try {
          target.releasePointerCapture(ev.pointerId)
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [canvas.nodes, screenToCanvas, selectedIds, spaceHeld]
  )

  const startResize = useCallback(
    (e: React.PointerEvent, id: string, corner: ResizeCorner) => {
      e.stopPropagation()
      e.preventDefault()
      if (dragRef.current || connectingRef.current || resizeRef.current) return
      const node = canvas.nodes.find((n) => n.id === id)
      if (!node) return
      resizeRef.current = {
        id,
        corner,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: node.width,
        startHeight: node.height,
        startNodeX: node.x,
        startNodeY: node.y
      }

      const target = e.currentTarget
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      const minW = node.type === 'group' ? GROUP_MIN_WIDTH : NODE_MIN_WIDTH
      const minH = node.type === 'group' ? GROUP_MIN_HEIGHT : NODE_MIN_HEIGHT

      const move = (ev: PointerEvent): void => {
        if (!resizeRef.current) return
        const dxScreen = ev.clientX - resizeRef.current.startX
        const dyScreen = ev.clientY - resizeRef.current.startY
        const dx = dxScreen / viewport.zoom
        const dy = dyScreen / viewport.zoom
        const { corner, startWidth, startHeight, startNodeX, startNodeY } = resizeRef.current
        let nextW = startWidth
        let nextH = startHeight
        let nextX = startNodeX
        let nextY = startNodeY
        if (corner.includes('e')) {
          const right = snapToGrid(startNodeX + startWidth + dx)
          nextW = Math.max(minW, right - startNodeX)
        }
        if (corner.includes('s')) {
          const bottom = snapToGrid(startNodeY + startHeight + dy)
          nextH = Math.max(minH, bottom - startNodeY)
        }
        if (corner.includes('w')) {
          const left = snapToGrid(startNodeX + dx)
          nextW = Math.max(minW, startNodeX + startWidth - left)
          nextX = startNodeX + startWidth - nextW
        }
        if (corner.includes('n')) {
          const top = snapToGrid(startNodeY + dy)
          nextH = Math.max(minH, startNodeY + startHeight - top)
          nextY = startNodeY + startHeight - nextH
        }
        setCanvas((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === id ? { ...n, x: nextX, y: nextY, width: nextW, height: nextH } : n
          )
        }))
      }
      const up = (ev: PointerEvent): void => {
        if (resizeRef.current) touched.current = true
        resizeRef.current = null
        try {
          target.releasePointerCapture(ev.pointerId)
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [canvas.nodes, viewport.zoom]
  )

  const startConnect = useCallback(
    (e: React.PointerEvent, nodeId: string, side: CanvasSide) => {
      e.stopPropagation()
      e.preventDefault()
      if (connectingRef.current || dragRef.current) return
      connectingRef.current = { nodeId, side }
      setSelectedIds(new Set([nodeId]))

      const surface = canvasRef.current
      try {
        surface?.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }

      const rect = surface?.getBoundingClientRect()
      const line = connectingLineRef.current
      const fromNode = canvas.nodes.find((n) => n.id === nodeId)
      if (fromNode && line) {
        const a = sidePoint(fromNode, side)
        line.setAttribute('x1', String(a.x * viewport.zoom + viewport.x))
        line.setAttribute('y1', String(a.y * viewport.zoom + viewport.y))
        line.setAttribute('x2', String(e.clientX - (rect?.left ?? 0)))
        line.setAttribute('y2', String(e.clientY - (rect?.top ?? 0)))
      }

      const move = (ev: PointerEvent): void => {
        if (!connectingRef.current || !line) return
        const r = surface?.getBoundingClientRect()
        const p = screenToCanvas(ev.clientX, ev.clientY)
        const target = findConnectTarget(canvas.nodes, nodeId, p.x, p.y)
        setConnectTarget(target ? { nodeId: target.node.id, side: target.side } : null)
        if (target) {
          const pt = sidePoint(target.node, target.side)
          line.setAttribute('x2', String(pt.x * viewport.zoom + viewport.x))
          line.setAttribute('y2', String(pt.y * viewport.zoom + viewport.y))
        } else {
          line.setAttribute('x2', String(ev.clientX - (r?.left ?? 0)))
          line.setAttribute('y2', String(ev.clientY - (r?.top ?? 0)))
        }
      }
      const up = (ev: PointerEvent): void => {
        const conn = connectingRef.current
        connectingRef.current = null
        if (line) {
          line.setAttribute('x1', '0')
          line.setAttribute('y1', '0')
          line.setAttribute('x2', '0')
          line.setAttribute('y2', '0')
        }
        setConnectTarget(null)
        if (conn) {
          const p = screenToCanvas(ev.clientX, ev.clientY)
          const target = findConnectTarget(canvas.nodes, conn.nodeId, p.x, p.y)
          if (target) {
            setCanvas((prev) => ({
              ...prev,
              edges: [
                ...prev.edges,
                {
                  id: uid(),
                  fromNode: conn.nodeId,
                  fromSide: conn.side,
                  toNode: target.node.id,
                  toSide: target.side
                }
              ]
            }))
            touched.current = true
          }
        }
        try {
          surface?.releasePointerCapture(ev.pointerId)
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [canvas.nodes, viewport.zoom, viewport.x, viewport.y, screenToCanvas]
  )

  const updateNodeText = useCallback((id: string, text: string) => {
    setCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id && n.type === 'text' ? { ...n, text } : n))
    }))
    touched.current = true
  }, [])

  const updateNodeLabel = useCallback((id: string, label: string) => {
    setCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id && n.type === 'group' ? { ...n, label } : n))
    }))
    touched.current = true
  }, [])

  const updateEdgeLabel = useCallback((id: string, label: string | undefined) => {
    setCanvas((prev) => ({
      ...prev,
      edges: prev.edges.map((e) => (e.id === id ? { ...e, label } : e))
    }))
    touched.current = true
  }, [])

  const setNodeColor = useCallback((id: string, color?: string) => {
    setCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, color } : n))
    }))
    touched.current = true
  }, [])

  const setEdgeColor = useCallback((id: string, color?: string) => {
    setCanvas((prev) => ({
      ...prev,
      edges: prev.edges.map((e) => (e.id === id ? { ...e, color } : e))
    }))
    touched.current = true
  }, [])

  const togglePin = useCallback(() => {
    if (!canvasItem) return
    save.mutate({ id: canvasItem.id, isPinned: !canvasItem.isPinned })
  }, [canvasItem, save])

  const filedIn = canvasItem?.folderId ?? startIn
  const back = `/projects/${projectId}/notes${filedIn ? `?in=${filedIn}` : ''}`

  const selectedNodes = useMemo(
    () => canvas.nodes.filter((n) => selectedIds.has(n.id)),
    [canvas.nodes, selectedIds]
  )
  const selectedEdges = useMemo(
    () => canvas.edges.filter((e) => selectedIds.has(e.id)),
    [canvas.edges, selectedIds]
  )

  const duplicateNodes = useCallback(
    (ids: Set<string>) => {
      const copied = new Map<string, string>()
      const copies = canvas.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => {
          const id = uid()
          copied.set(n.id, id)
          return { ...n, id, x: n.x + GRID_SIZE, y: n.y + GRID_SIZE }
        })
      if (copies.length === 0) return
      // A line between two cards that were both copied is part of what was copied; one
      // with an end outside the selection is not, and would land on the original.
      const edges = canvas.edges
        .filter((e) => copied.has(e.fromNode) && copied.has(e.toNode))
        .map((e) => ({ ...e, id: uid(), fromNode: copied.get(e.fromNode)!, toNode: copied.get(e.toNode)! }))
      setCanvas((prev) => ({ nodes: [...prev.nodes, ...copies], edges: [...prev.edges, ...edges] }))
      setSelectedIds(new Set(copies.map((c) => c.id)))
      touched.current = true
    },
    [canvas.edges, canvas.nodes]
  )

  /**
   * Six colours and none is one question with seven answers, which is exactly what a
   * submenu is for — and the only one this menu has.
   */
  const colourMenu = useCallback(
    (apply: (color?: string) => void): MenuSubmenu => ({
      label: 'Colour',
      icon: 'droplet',
      items: [
        ...Object.entries(CANVAS_COLOR_NAMES).map(([key, name]) => ({
          label: name,
          onSelect: () => apply(key)
        })),
        { label: 'No colour', onSelect: () => apply(undefined) }
      ]
    }),
    []
  )

  /**
   * Right-clicking something that is not in the selection selects it first, so what the
   * menu is about is always what is on screen with a ring around it.
   */
  const openNodeMenu = useCallback(
    (e: React.MouseEvent, node: CanvasNode) => {
      const withSelection = selectedIds.has(node.id) && selectedIds.size > 1
      const ids = withSelection ? new Set(selectedIds) : new Set([node.id])
      if (!withSelection) setSelectedIds(ids)
      const many = ids.size > 1
      const noun = node.type === 'group' ? 'group' : 'card'
      const items: MenuItem[] = [
        ...(many
          ? []
          : [
              {
                label: node.type === 'group' ? 'Rename group' : 'Edit text',
                icon: 'edit' as const,
                onSelect: () => setEditingNodeId(node.id)
              }
            ]),
        colourMenu((color) => ids.forEach((id) => setNodeColor(id, color))),
        {
          label: many ? `Duplicate ${ids.size} items` : `Duplicate ${noun}`,
          icon: 'copy',
          onSelect: () => duplicateNodes(ids)
        },
        'separator',
        {
          label: many ? `Delete ${ids.size} items` : `Delete ${noun}`,
          icon: 'trash',
          danger: true,
          onSelect: () => deleteIds(ids)
        }
      ]
      openMenu(e, items)
    },
    [colourMenu, deleteIds, duplicateNodes, openMenu, selectedIds, setNodeColor]
  )

  const openEdgeMenu = useCallback(
    (e: React.MouseEvent, edge: CanvasEdge) => {
      setSelectedIds(new Set([edge.id]))
      openMenu(e, [
        edge.label === undefined
          ? {
              label: 'Add a label',
              icon: 'edit',
              onSelect: () => {
                labelFocusRef.current = edge.id
                updateEdgeLabel(edge.id, '')
              }
            }
          : { label: 'Remove the label', icon: 'close', onSelect: () => updateEdgeLabel(edge.id, undefined) },
        colourMenu((color) => setEdgeColor(edge.id, color)),
        'separator',
        {
          label: 'Delete line',
          icon: 'trash',
          danger: true,
          onSelect: () => deleteIds(new Set([edge.id]))
        }
      ])
    },
    [colourMenu, deleteIds, openMenu, setEdgeColor, updateEdgeLabel]
  )

  const openBoardMenu = useCallback(
    (e: React.MouseEvent) => {
      const at = screenToCanvas(e.clientX, e.clientY)
      openMenu(e, [
        { label: 'New card', icon: 'plus', onSelect: () => addTextNode(at) },
        { label: 'New group', icon: 'folder', onSelect: () => addGroup(at) },
        'separator',
        {
          label: 'Select everything',
          icon: 'check',
          disabled: canvas.nodes.length === 0,
          onSelect: () => setSelectedIds(new Set(canvas.nodes.map((n) => n.id)))
        },
        { label: 'Fit all', icon: 'monitor', disabled: canvas.nodes.length === 0, onSelect: fitAll }
      ])
    },
    [addGroup, addTextNode, canvas.nodes, fitAll, openMenu, screenToCanvas]
  )

  if (!data) return <div className="h-full" />
  if (missing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon="canvas"
          title="That canvas is no longer here."
          hint="It may have been deleted from another screen."
          action={
            <Link className="btn btn-sm" to={back}>
              Back to notes
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div
        ref={canvasRef}
        data-role="canvas-surface"
        className="absolute inset-0 cursor-default touch-none"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, currentColor 8%, transparent) 1px, transparent 1px)',
          backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (panning) setPanning(null)
        }}
        onDoubleClick={(e) => {
          if (e.target === canvasRef.current || (e.target as HTMLElement).dataset?.role === 'canvas-surface') {
            const p = screenToCanvas(e.clientX, e.clientY)
            addTextNode(p)
          }
        }}
        onContextMenu={(e) => {
          // A right-drag pans, and a pan that ends in a menu is a menu nobody asked for.
          const el = e.target as HTMLElement
          if (!pannedRef.current && (el === canvasRef.current || el.dataset?.role === 'canvas-surface')) {
            openBoardMenu(e)
            return
          }
          e.preventDefault()
        }}
      >
        <div
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        >
          {/* Groups behind everything */}
          {canvas.nodes
            .filter((n): n is Extract<CanvasNode, { type: 'group' }> => n.type === 'group')
            .map((node) => (
              <GroupNodeView
                key={node.id}
                node={node}
                selected={selectedIds.has(node.id)}
                editing={editingNodeId === node.id}
                connectingSourceId={connectingRef.current?.nodeId ?? null}
                connectTarget={connectTarget}
                onPointerDown={(e) => startDrag(e, node.id)}
                onContextMenu={(e) => openNodeMenu(e, node)}
                onStartConnect={(e, side) => startConnect(e, node.id, side)}
                onStartResize={(e, corner) => startResize(e, node.id, corner)}
                onEditLabel={updateNodeLabel}
                onSetEditing={(editing) => setEditingNodeId(editing ? node.id : null)}
                onSetColor={(color) => setNodeColor(node.id, color)}
              />
            ))}

          {/* Edges */}
          {/* 1px rather than 0: a zero-sized svg is not rendered at all, overflow or no overflow */}
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" style={{ width: 1, height: 1 }}>
            {canvas.edges.map((edge) => {
              const from = canvas.nodes.find((n) => n.id === edge.fromNode)
              const to = canvas.nodes.find((n) => n.id === edge.toNode)
              if (!from || !to) return null
              const a = sidePoint(from, edge.fromSide ?? 'right')
              const b = sidePoint(to, edge.toSide ?? 'left')
              const selected = selectedIds.has(edge.id) || selectedIds.has(from.id) || selectedIds.has(to.id)
              return (
                <g
                  key={edge.id}
                  pointerEvents="auto"
                  onClick={() => setSelectedIds(new Set([edge.id]))}
                  onContextMenu={(e) => openEdgeMenu(e, edge)}
                >
                  {/* A 1.5px line is a hard thing to hit; this is the part you aim at. */}
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14} />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={edge.color ? CANVAS_COLORS[edge.color] ?? edge.color : 'currentColor'}
                    strokeWidth={selected ? 2.5 : 1.5}
                    className={edge.color ? '' : 'text-base-content/30'}
                    markerEnd="url(#arrow)"
                  />
                  {edge.label !== undefined && (
                    <foreignObject x={(a.x + b.x) / 2 - 60} y={(a.y + b.y) / 2 - 12} width={120} height={24}>
                      <input
                        ref={(el) => {
                          if (el && labelFocusRef.current === edge.id) {
                            labelFocusRef.current = null
                            el.focus()
                          }
                        }}
                        value={edge.label ?? ''}
                        onChange={(e) => updateEdgeLabel(edge.id, e.target.value)}
                        className="w-full bg-transparent text-center text-[11px] text-base-content outline-none"
                        placeholder=""
                      />
                    </foreignObject>
                  )}
                </g>
              )
            })}
            <defs>
              <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" fill="currentColor" className="text-base-content/50" />
              </marker>
            </defs>
          </svg>

          {/* Text nodes */}
          {canvas.nodes
            .filter((n): n is Extract<CanvasNode, { type: 'text' }> => n.type === 'text')
            .map((node) => (
              <TextNodeView
                key={node.id}
                node={node}
                selected={selectedIds.has(node.id)}
                editing={editingNodeId === node.id}
                connectingSourceId={connectingRef.current?.nodeId ?? null}
                connectTarget={connectTarget}
                onPointerDown={(e) => startDrag(e, node.id)}
                onContextMenu={(e) => openNodeMenu(e, node)}
                onStartConnect={(e, side) => startConnect(e, node.id, side)}
                onStartResize={(e, corner) => startResize(e, node.id, corner)}
                onEdit={updateNodeText}
                onSetEditing={(editing) => setEditingNodeId(editing ? node.id : null)}
                onSetColor={(color) => setNodeColor(node.id, color)}
              />
            ))}
        </div>

        {/* Connecting preview — rendered in screen coords so dragging it does not re-render the board */}
        <svg className="pointer-events-none absolute inset-0 overflow-visible">
          <line
            ref={connectingLineRef}
            x1={0}
            y1={0}
            x2={0}
            y2={0}
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-base-content/40"
            strokeDasharray="4 4"
          />
        </svg>

        {/* Box selection — rendered in screen coords */}
        <div ref={boxSelectRef} className="absolute hidden border border-primary bg-primary/10" />
      </div>

      {/* Toolbar */}
      <div className="drag-region absolute inset-x-0 top-0 flex h-[3.25rem] items-center gap-2 bg-base-100/75 px-4 backdrop-blur-sm">
        <Link
          to={back}
          className="group flex items-center gap-1.5 rounded-field px-2 py-1 text-[12px] text-base-content/50 transition hover:bg-base-content/5 hover:text-base-content"
        >
          <Icon name="arrowLeft" size={13} className="transition-transform group-hover:-translate-x-0.5" />
          Notes
        </Link>

        <div className="mx-3 h-5 w-px bg-base-content/10" />

        <input
          className="quiet-input max-w-xs px-2 py-1 text-[15px] font-medium"
          placeholder="Untitled canvas"
          value={title}
          onChange={(e) => {
            touched.current = true
            setTitle(e.target.value)
          }}
        />

        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton icon="plus" title="Add card (double-click canvas)" onClick={() => addTextNode()} />
          <ToolbarButton icon="folder" title="Add group" onClick={addGroup} />
          <div className="mx-1 h-5 w-px bg-base-content/10" />
          <ToolbarButton icon="minus" title="Zoom out" onClick={() => setViewport((v) => ({ ...v, zoom: Math.max(0.1, v.zoom * 0.9) }))} />
          <span className="min-w-[3rem] text-center text-[11px] text-base-content/40">{Math.round(viewport.zoom * 100)}%</span>
          <ToolbarButton icon="plus" title="Zoom in" onClick={() => setViewport((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.1) }))} />
          <ToolbarButton icon="monitor" title="Fit all" onClick={fitAll} />
          <div className="mx-1 h-5 w-px bg-base-content/10" />
          {canvasItem && (
            <>
              <button
                className={`btn btn-sm btn-circle ${canvasItem.isPinned ? 'btn-neutral' : 'btn-ghost text-base-content/40'}`}
                title={canvasItem.isPinned ? 'Unpin' : 'Pin to the top'}
                onClick={togglePin}
              >
                <Icon name="pin" size={14} />
              </button>
              <button
                className="btn btn-ghost btn-sm text-base-content/40 hover:text-error"
                onClick={() => {
                  deleted.current = true
                  remove.mutate({ id: canvasItem.id })
                  navigate(back, { replace: true })
                }}
              >
                Delete
              </button>
            </>
          )}
          <span className="ml-2 w-[6.5rem] text-right text-[11px] text-base-content/35">
            {dirty ? 'Unsaved…' : savedAt ? `Saved ${relativeFromIso(savedAt)}` : 'Not saved yet'}
          </span>
        </div>
      </div>

      {/* Selection inspector */}
      {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
        <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-box border bg-base-100/90 px-3 py-2 text-[12px] shadow-sm backdrop-blur-sm">
          <span className="text-base-content/50">
            {selectedNodes.length} selected
          </span>
          <div className="h-4 w-px bg-base-content/10" />
          {selectedNodes.length > 0 && (
            <div className="flex items-center gap-1">
              {['1', '2', '3', '4', '5', '6'].map((c) => (
                <button
                  key={c}
                  className="size-5 rounded-full border border-base-content/10"
                  style={{ backgroundColor: CANVAS_COLORS[c] }}
                  title={`Color ${c}`}
                  onClick={() => setNodeColor(selectedNodes[0].id, c)}
                />
              ))}
              <button
                className="ml-1 size-5 rounded-full border border-base-content/10 bg-base-100"
                title="No color"
                onClick={() => setNodeColor(selectedNodes[0].id, undefined)}
              />
            </div>
          )}
          {selectedEdges.length > 0 && selectedNodes.length === 0 && (
            <div className="flex items-center gap-1">
              {['1', '2', '3', '4', '5', '6'].map((c) => (
                <button
                  key={c}
                  className="size-5 rounded-full border border-base-content/10"
                  style={{ backgroundColor: CANVAS_COLORS[c] }}
                  title={`Color ${c}`}
                  onClick={() => setEdgeColor(selectedEdges[0].id, c)}
                />
              ))}
              <button
                className="ml-1 size-5 rounded-full border border-base-content/10 bg-base-100"
                title="No color"
                onClick={() => setEdgeColor(selectedEdges[0].id, undefined)}
              />
            </div>
          )}
        </div>
      )}

      {/* Hint */}
      {canvas.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center text-base-content/25">
            <Icon name="canvas" size={48} className="mx-auto mb-3" />
            <p className="text-[14px]">Double-click anywhere to add a card</p>
            <p className="mt-1 text-[12px]">Right-click for more · Space + drag to pan · Cmd + scroll to zoom</p>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolbarButton({
  icon,
  title,
  onClick
}: {
  icon: import('@/components/Icon').IconName
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className="btn btn-ghost btn-circle btn-xs" title={title} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  )
}

function TextNodeView({
  node,
  selected,
  editing,
  connectingSourceId,
  connectTarget,
  onPointerDown,
  onContextMenu,
  onStartConnect,
  onStartResize,
  onEdit,
  onSetEditing,
  onSetColor
}: {
  node: Extract<CanvasNode, { type: 'text' }>
  selected: boolean
  editing: boolean
  connectingSourceId: string | null
  connectTarget: { nodeId: string; side: CanvasSide } | null
  onPointerDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onStartConnect: (e: React.PointerEvent, side: CanvasSide) => void
  onStartResize: (e: React.PointerEvent, corner: ResizeCorner) => void
  onEdit: (id: string, text: string) => void
  onSetEditing: (editing: boolean) => void
  onSetColor: (color?: string) => void
}): React.JSX.Element {
  const showConnectHandles = (selected && !editing && connectingSourceId === null) || (connectingSourceId !== null && connectingSourceId !== node.id)
  const showResizeHandles = selected && !editing && connectingSourceId === null

  /*
   * A textarea is as tall as it is told to be, and text in one starts at the top. So it
   * is grown to fit what is in it and centred by the box around it — otherwise a card's
   * words would jump to the top edge the moment you double-clicked to change them.
   */
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, node.height - 16)}px`
  }, [editing, node.text, node.height])

  return (
    <div
      data-node-id={node.id}
      className={`pointer-events-auto absolute rounded-lg border shadow-sm transition-shadow ${
        selected ? 'shadow-md ring-2 ring-primary/40' : ''
      } ${nodeColorClass(node.color)}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        ...nodeStyle(node.color)
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onSetEditing(true)
      }}
    >
      {editing ? (
        <div className="flex size-full items-center justify-center px-3 py-2">
          <textarea
            ref={areaRef}
            autoFocus
            className="w-full resize-none bg-transparent text-center text-[13px] leading-snug text-base-content outline-none"
            value={node.text ?? ''}
            onChange={(e) => onEdit(node.id, e.target.value)}
            onBlur={() => onSetEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSetEditing(false)
              }
            }}
          />
        </div>
      ) : (
        <div className="pointer-events-none flex size-full items-center justify-center overflow-hidden whitespace-pre-wrap px-3 py-2 text-center text-[13px] leading-snug">
          {node.text || <span className="text-base-content/25">Empty card</span>}
        </div>
      )}
      {showConnectHandles && (
        <>
          {(['top', 'right', 'bottom', 'left'] as CanvasSide[]).map((side) => (
            <Handle
              key={side}
              side={side}
              active={connectTarget?.nodeId === node.id && connectTarget?.side === side}
              onPointerDown={(e) => onStartConnect(e, side)}
            />
          ))}
        </>
      )}
      {showResizeHandles && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => (
            <ResizeHandle key={corner} corner={corner} onPointerDown={(e) => onStartResize(e, corner)} />
          ))}
        </>
      )}
    </div>
  )
}

function GroupNodeView({
  node,
  selected,
  editing,
  connectingSourceId,
  connectTarget,
  onPointerDown,
  onContextMenu,
  onStartConnect,
  onStartResize,
  onEditLabel,
  onSetEditing,
  onSetColor
}: {
  node: Extract<CanvasNode, { type: 'group' }>
  selected: boolean
  editing: boolean
  connectingSourceId: string | null
  connectTarget: { nodeId: string; side: CanvasSide } | null
  onPointerDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onStartConnect: (e: React.PointerEvent, side: CanvasSide) => void
  onStartResize: (e: React.PointerEvent, corner: ResizeCorner) => void
  onEditLabel: (id: string, label: string) => void
  onSetEditing: (editing: boolean) => void
  onSetColor: (color?: string) => void
}): React.JSX.Element {
  const showConnectHandles = (selected && !editing && connectingSourceId === null) || (connectingSourceId !== null && connectingSourceId !== node.id)
  const showResizeHandles = selected && !editing && connectingSourceId === null
  const accent = node.color ? CANVAS_COLORS[node.color] ?? node.color : 'var(--color-base-content)'
  const background = node.color ? `${accent}10` : 'var(--color-base-200)'
  return (
    <div
      data-node-id={node.id}
      className={`pointer-events-auto absolute rounded-xl border-2 ${selected ? 'ring-2 ring-primary/40' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderColor: accent,
        backgroundColor: background
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onSetEditing(true)
      }}
    >
      <div className="absolute -top-3 left-3 px-1">
        {editing ? (
          <input
            autoFocus
            className="rounded border bg-base-100 px-1.5 py-0.5 text-[12px] text-base-content outline-none"
            value={node.label ?? ''}
            onChange={(e) => onEditLabel(node.id, e.target.value)}
            onBlur={() => onSetEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSetEditing(false)
            }}
          />
        ) : (
          <span className="rounded border bg-base-100 px-1.5 py-0.5 text-[12px] font-medium" style={{ borderColor: accent }}>
            {node.label || 'Group'}
          </span>
        )}
      </div>
      {showConnectHandles && (
        <>
          {(['top', 'right', 'bottom', 'left'] as CanvasSide[]).map((side) => (
            <Handle
              key={side}
              side={side}
              active={connectTarget?.nodeId === node.id && connectTarget?.side === side}
              onPointerDown={(e) => onStartConnect(e, side)}
            />
          ))}
        </>
      )}
      {showResizeHandles && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => (
            <ResizeHandle key={corner} corner={corner} onPointerDown={(e) => onStartResize(e, corner)} />
          ))}
        </>
      )}
    </div>
  )
}

function Handle({
  side,
  active,
  onPointerDown
}: {
  side: CanvasSide
  active?: boolean
  onPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element {
  const size = active ? HANDLE_SIZE + 4 : HANDLE_SIZE
  const style: React.CSSProperties = {
    width: size,
    height: size,
    position: 'absolute',
    borderRadius: '50%',
    backgroundColor: 'var(--node-accent, currentColor)',
    cursor: 'crosshair',
    boxShadow: active ? '0 0 0 2px var(--color-base-100)' : undefined,
    transition: 'width 0.1s, height 0.1s'
  }
  if (side === 'top') {
    style.left = '50%'
    style.top = -size / 2
    style.transform = 'translateX(-50%)'
  } else if (side === 'right') {
    style.right = -size / 2
    style.top = '50%'
    style.transform = 'translateY(-50%)'
  } else if (side === 'bottom') {
    style.left = '50%'
    style.bottom = -size / 2
    style.transform = 'translateX(-50%)'
  } else {
    style.left = -size / 2
    style.top = '50%'
    style.transform = 'translateY(-50%)'
  }
  return <div className="pointer-events-auto" style={style} onPointerDown={onPointerDown} />
}

function ResizeHandle({
  corner,
  onPointerDown
}: {
  corner: ResizeCorner
  onPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element {
  const style: React.CSSProperties = {
    width: RESIZE_HANDLE_SIZE,
    height: RESIZE_HANDLE_SIZE,
    position: 'absolute',
    borderRadius: 2,
    backgroundColor: 'var(--node-accent, currentColor)',
    border: '1px solid var(--color-base-100)'
  }
  const offset = -RESIZE_HANDLE_SIZE / 2
  if (corner === 'nw') {
    style.left = offset
    style.top = offset
    style.cursor = 'nwse-resize'
  } else if (corner === 'ne') {
    style.right = offset
    style.top = offset
    style.cursor = 'nesw-resize'
  } else if (corner === 'sw') {
    style.left = offset
    style.bottom = offset
    style.cursor = 'nesw-resize'
  } else {
    style.right = offset
    style.bottom = offset
    style.cursor = 'nwse-resize'
  }
  return <div className="pointer-events-auto" style={style} onPointerDown={onPointerDown} />
}
