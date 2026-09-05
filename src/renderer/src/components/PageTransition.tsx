import { useEffect, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { pageVariants, stillVariants } from '@/lib/motion'

/**
 * The page area is the largest surface in the window, and it was the only one that
 * changed without any movement at all — the sidebar animates, the panels animate,
 * and then the thing you were actually looking at jumped. That mismatch is what
 * read as slowness; the data behind every screen arrives in a few milliseconds.
 *
 * The outgoing screen is *not* cross-faded with the incoming one. `mode="wait"`
 * holds the new screen back until the old one has gone, so the two are never on
 * top of each other: the page empties, then arrives as a single block. Leaving is
 * nearly instant and arriving is where the time goes, which is what makes the
 * click feel answered rather than waited on.
 */
export function PageTransition({
  id,
  scrollRef,
  className = '',
  children
}: {
  /** Changing this is what counts as a new screen. */
  id: string
  /** Reset to the top when the screen changes, rather than landing mid-page. */
  scrollRef?: RefObject<HTMLElement | null>
  /** A screen that manages its own height needs the wrapper to have one too. */
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const variants = useReducedMotion() ? stillVariants : pageVariants

  return (
    // Scrolling back to the top belongs *between* the two screens: do it while the
    // old one is still on screen and you watch it jump before it has finished
    // leaving. By the time this fires the page is empty and there is nothing to see.
    <AnimatePresence
      mode="wait"
      initial={false}
      onExitComplete={() => scrollRef?.current?.scrollTo({ top: 0 })}
    >
      <motion.div
        key={id}
        className={className}
        variants={variants}
        initial="hidden"
        animate="shown"
        exit="gone"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

/**
 * The tabs inside a project sit under a heading that does not change, so there is
 * nothing to wait for: the old tab goes at once and the new one settles in. It also
 * has to work this way — the panel comes through an `<Outlet>`, which reads the
 * current route from context and so cannot be held on the old one while it leaves.
 */
export function PanelTransition({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  const variants = useReducedMotion() ? stillVariants : pageVariants

  return (
    <motion.div key={id} variants={variants} initial="hidden" animate="shown">
      {children}
    </motion.div>
  )
}

/**
 * A screen whose data has not arrived yet renders nothing rather than the word
 * "Loading" — at three milliseconds a spinner is a flicker, not information. If a
 * fetch ever does take long enough to notice, this fades a quiet line in once the
 * wait has become real.
 */
export function Pending({ after = 400 }: { after?: number }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    timer.current = setTimeout(() => setShow(true), after)
    return () => clearTimeout(timer.current)
  }, [after])

  return (
    <div className="py-20 text-center text-sm text-base-content/40">
      {show && (
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          Loading…
        </motion.span>
      )}
    </div>
  )
}
