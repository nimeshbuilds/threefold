import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A button that opens a small menu. Closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  className = '',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  side?: 'top' | 'bottom'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`popover ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div className={`menu menu-${align} menu-${side}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
