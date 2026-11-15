// Threefold's own line icons: 24px grid, 1.75px stroke, round joins.

import type { ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  code: <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  edit: <path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5zM14 7l3 3" />,
  pin: <path d="M9 4.5h6l-1 5.5 3.5 3.5h-11L10 10zM12 13.5V20" />,
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" />,
  chevronDown: <path d="M6.5 9.5L12 15l5.5-5.5" />,
  chevronRight: <path d="M9.5 6.5L15 12l-5.5 5.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  paperclip: <path d="M19 11.5l-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4L13 4.7a3 3 0 0 1 4.3 4.3l-7.5 7.5a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5s1.200-6.100 3.800-8.500z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.500" width="17" height="15" rx="2.500" />
      <path d="M7.500 9.500l3 2.500-3 2.500M12.500 15h4" />
    </>
  ),
  image: (
    <>
      <rect x="3.500" y="4.500" width="17" height="15" rx="2.500" />
      <circle cx="9" cy="10" r="1.600" />
      <path d="M4.500 17.500l5-4.500 3.500 3 2.500-2 4 3.500" />
    </>
  ),
  bulb: <path d="M9 17.500h6M10 20.500h4M12 3.500a6 6 0 0 0-3.600 10.800c.700.600 1.100 1.300 1.100 2.200v1h5v-1c0-.900.400-1.600 1.100-2.200A6 6 0 0 0 12 3.500z" />,
  download: <path d="M12 4.500v10.500M7 10.500l5 5 5-5M5 19.500h14" />,
  external: <path d="M13.500 5h5.500v5.500M19 5l-8 8M17 14v3.500a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 5 17.500v-9A1.500 1.500 0 0 1 6.500 7H10" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.300" fill="currentColor" />
      <circle cx="12" cy="12" r="1.300" fill="currentColor" />
      <circle cx="18" cy="12" r="1.300" fill="currentColor" />
    </>
  ),
  memory: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M9.500 9.500h5v5h-5zM9 2.500V5M15 2.500V5M9 19v2.500M15 19v2.500M2.500 9H5M2.500 15H5M19 9h2.500M19 15h2.500" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.500" r="4" />
      <path d="M11 12.500l8.500-8.500M16 7.500l2.500 2.500M13.500 10l2 2" />
    </>
  ),
  chart: <path d="M4.500 19.500h15M7.500 16.500v-5M12 16.500v-9M16.500 16.500v-3" />,
  upload: <path d="M12 15.500V5M7 9.500l5-5 5 5M5 19.500h14" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 11v5.500M12 7.700v.100" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.500" r="3.500" />
      <path d="M5 19.500c1.200-3.300 3.700-5 7-5s5.800 1.700 7 5" />
    </>
  ),
  panel: (
    <>
      <rect x="3.500" y="4.500" width="17" height="15" rx="2.500" />
      <path d="M9.500 4.500v15" />
    </>
  ),
  eye: (
    <>
      <path d="M2.500 12s3.500-6.500 9.500-6.500 9.500 6.500 9.500 6.500-3.500 6.500-9.500 6.500S2.500 12 2.500 12z" />
      <circle cx="12" cy="12" r="2.800" />
    </>
  ),
  file: <path d="M7 3.500h6.500L18.500 8.500v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM13.500 3.500v5h5" />,
  layers: <path d="M12 3.500l8.500 4.250-8.500 4.250-8.500-4.250zM3.500 12l8.500 4.250 8.500-4.250M3.500 16.250l8.500 4.250 8.500-4.250" />,
  bolt: <path d="M13 3.500L5.500 13.500h5.500l-1 7 7.500-10h-5.500z" />,
  handoff: <path d="M4 7.500h15.500M15.500 3.500l4 4-4 4M20 16.500H4.500M8.500 12.500l-4 4 4 4" />,
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {paths[name] ?? null}
    </svg>
  )
}
