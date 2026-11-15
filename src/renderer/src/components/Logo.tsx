// The Threefold mark: three overlapping sheets, one per mode (warm, neutral,
// cool), with the overlaps showing through. Geometry matches brand/threefold-mark.svg.

import { useId } from 'react'

export function Logo({ size = 28 }: { size?: number }) {
  const left = useId()
  const right = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <clipPath id={left}>
          <rect x="4" y="22" width="28" height="28" rx="8" />
        </clipPath>
        <clipPath id={right}>
          <rect x="32" y="22" width="28" height="28" rx="8" />
        </clipPath>
      </defs>
      <rect x="4" y="22" width="28" height="28" rx="8" fill="var(--logo-ember, #c2571a)" />
      <rect x="32" y="22" width="28" height="28" rx="8" fill="var(--logo-tide, #3b63d9)" />
      <rect x="18" y="14" width="28" height="28" rx="8" fill="var(--logo-ink, #1f2430)" />
      <rect x="18" y="14" width="28" height="28" rx="8" fill="var(--logo-fold-warm, #f2c9a8)" clipPath={`url(#${left})`} />
      <rect x="18" y="14" width="28" height="28" rx="8" fill="var(--logo-fold-cool, #c9d6f7)" clipPath={`url(#${right})`} />
    </svg>
  )
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Logo size={22} />
      <span>Threefold</span>
    </span>
  )
}
