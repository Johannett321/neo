import { useId } from 'react'
import { MARK } from '@shared/mark'

/**
 * The app's own mark: three squares on a diagonal inside a squircle, on the
 * rose-to-amber gradient — separate things, held in one line of sight.
 *
 * The geometry comes from `@shared/mark` on its 1024 grid, so the thing in the
 * sidebar, the thing on the splash screen and the thing in the dock are the same
 * drawing rather than three that merely resemble each other. Paths rather than an
 * image file: nothing to fetch, nothing for the CSP to allow, and crisp at 16px.
 */
export function Logo({ size = 22, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  // Several logos can be on screen at once; a shared gradient id would let the first
  // one win and paint the rest black.
  const id = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <defs>
        {/*
          The icon blends by (u + v) / 2 across the face, which is exactly a linear
          gradient along the diagonal between the two corners of the squircle.
        */}
        <linearGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          x1={MARK.face.x}
          y1={MARK.face.y}
          x2={MARK.face.x + MARK.face.size}
          y2={MARK.face.y + MARK.face.size}
        >
          <stop offset="0" stopColor="var(--color-brand-from)" />
          <stop offset="1" stopColor="var(--color-brand-to)" />
        </linearGradient>
      </defs>
      <rect
        x={MARK.face.x}
        y={MARK.face.y}
        width={MARK.face.size}
        height={MARK.face.size}
        rx={MARK.face.r}
        fill={`url(#${id})`}
      />
      <g fill="#fff">
        {MARK.steps.map((s) => (
          <rect
            key={`${s.x},${s.y}`}
            x={s.x}
            y={s.y}
            width={MARK.step.size}
            height={MARK.step.size}
            rx={MARK.step.r}
          />
        ))}
      </g>
    </svg>
  )
}

/** The mark and the name together. The name is set in the app's own UI face, not a logotype. */
export function Brand({
  size = 22,
  text = 'text-[13px]',
  className = ''
}: {
  size?: number
  text?: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <Logo size={size} />
      <span className={`font-semibold tracking-[-0.015em] ${text}`}>Neo</span>
    </span>
  )
}
