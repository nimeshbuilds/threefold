// The Twofold mark: two overlapping sheets, one warm and one cool, with the
// overlap showing through. It stands for the two modes sharing one app.
// Geometry matches brand/twofold-mark.svg.

import { useId } from 'react'

export function Logo({ size = 28 }: { size?: number }) {
  const clip = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <clipPath id={clip}>
          <rect x="8" y="18" width="32" height="32" rx="9" />
        </clipPath>
      </defs>
      <rect x="8" y="18" width="32" height="32" rx="9" fill="var(--logo-ember, #c2571a)" />
      <rect x="24" y="14" width="32" height="32" rx="9" fill="var(--logo-ink, #1f2430)" />
      <rect x="24" y="14" width="32" height="32" rx="9" fill="var(--logo-fold, #f2c9a8)" clipPath={`url(#${clip})`} />
    </svg>
  )
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Logo size={22} />
      <span>Twofold</span>
    </span>
  )
}
