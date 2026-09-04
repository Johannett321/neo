import { useId } from 'react'

/**
 * The app's own mark: three squares on a diagonal inside a squircle, on the
 * rose-to-amber gradient — separate things, held in one line of sight.
 *
 * The geometry is lifted straight from `scripts/make-icon.mjs` on its 1024 grid, so
 * the thing in the sidebar and the thing in the dock are the same drawing rather than
 * two that merely resemble each other. Paths rather than an image file: nothing to
 * fetch, nothing for the CSP to allow, and crisp at 16px.
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
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="100" y1="100" x2="924" y2="924">
          <stop offset="0" stopColor="var(--color-brand-from)" />
          <stop offset="1" stopColor="var(--color-brand-to)" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${id})`} />
      <g fill="#fff">
        <rect x="294" y="574" width="156" height="156" rx="26" />
        <rect x="434" y="434" width="156" height="156" rx="26" />
        <rect x="574" y="294" width="156" height="156" rx="26" />
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
