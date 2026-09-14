import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Taking somebody to the thing itself, rather than to the screen it is on.
 *
 * Today is a list of rows lifted out of everywhere — a card on a board, an item a
 * meeting left owing — and the question it raises about any one of them is "where did
 * this come from". Navigating to the project answered that with a screen and left the
 * rest of the work to the eye: a board with forty cards on it has not said *which*
 * one. So the destination is told which row it was opened for, and lights it.
 *
 * It travels in the history entry's state rather than in the URL. A `?reveal=` would
 * stay in the address after the flash had finished, would fire again on a reload, and
 * would make an otherwise identical screen two different places to go back to. This is
 * a thing said once on arrival, which is exactly what history state is for.
 */
const FLASH_MS = 1400

interface RevealState {
  reveal?: string
}

/** Go to a screen, pointing at one thing on it. */
export function useReveal(): (path: string, id: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (path: string, id: string) => navigate(path, { state: { reveal: id } satisfies RevealState }),
    [navigate]
  )
}

/**
 * The id this screen was opened to point at, for as long as it should stay lit.
 *
 * Called **once per screen**, not once per row: the state is spent the moment it is
 * read — replaced out of the history entry — so a second reader would find nothing.
 * Pass the answer down to the rows.
 *
 * Spending it is the point. Without that, going back to this screen later, or a
 * reload while it is open, would light the row again for no reason anybody asked for.
 */
export function useRevealed(): string | null {
  const location = useLocation()
  const navigate = useNavigate()
  const wanted = (location.state as RevealState | null)?.reveal ?? null
  const [lit, setLit] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!wanted) return
    setLit(wanted)
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
    // Not cleared when this effect re-runs — replacing the state above re-runs it
    // immediately with nothing wanted, and clearing there would end the flash on the
    // frame it started. It is cleared when the screen goes, below.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setLit(null), FLASH_MS)
  }, [wanted, navigate, location.pathname, location.search])

  useEffect(() => () => clearTimeout(timer.current), [])

  return lit
}

/**
 * The row's half: hold this on the element that should light, and it brings itself
 * into view when it is the one.
 *
 * `center` on both axes because both are in play — a board scrolls sideways and its
 * columns scroll down — and a card at the very edge of the viewport is found no more
 * easily than one just outside it.
 */
export function useRevealTarget<T extends HTMLElement>(lit: boolean): React.RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!lit) return
    // After paint: on arrival the screen it is on has not been laid out yet.
    const frame = requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
    )
    return () => cancelAnimationFrame(frame)
  }, [lit])

  return ref
}
