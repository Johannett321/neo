/**
 * One set of timings for the whole app, so the sidebar, the page area and the
 * panels inside it all move at the same speed. The curve is a decelerating ease —
 * fast off the mark, settling at the end — which reads as the interface responding
 * to the click rather than playing an animation at you.
 */
export const EASE = [0.32, 0.72, 0, 1] as const

/** Arriving: long enough to be read as movement. */
export const ENTER = { duration: 0.22, ease: EASE } as const

/** Leaving: barely there. A departure that lingers is what makes an app feel slow. */
export const EXIT = { duration: 0.09, ease: EASE } as const

/**
 * A page arrives as one block, not as a stagger of its own parts. Everything
 * animating on every load is noise; the point is only to soften the cut between
 * one screen and the next.
 */
export const pageVariants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: ENTER },
  gone: { opacity: 0, transition: EXIT }
}

/** The same, with the movement taken out, for `prefers-reduced-motion`. */
export const stillVariants = {
  hidden: { opacity: 0, y: 0 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.12 } },
  gone: { opacity: 0, transition: { duration: 0.06 } }
}
