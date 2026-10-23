import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close, ref])
}

export interface MenuItem {
  label: ReactNode
  hint?: string
  onClick?: () => void
  disabled?: boolean
  divider?: boolean
  active?: boolean
  danger?: boolean
}

export function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <ul className="menu-list" role="menu">
      {items.map((it, i) =>
        it.divider ? (
          <li key={i} className="menu-divider" role="separator" />
        ) : (
          <li
            key={i}
            role="menuitem"
            title={it.hint}
            className={`menu-item${it.active ? ' active' : ''}${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`}
            onClick={() => {
              if (it.disabled) return
              close()
              it.onClick?.()
            }}
          >
            {it.label}
          </li>
        ),
      )}
    </ul>
  )
}

/** A toolbar button that opens a dropdown list. */
export function Dropdown({ label, items, title, wide }: { label: ReactNode; items: MenuItem[]; title?: string; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useDismiss(open, close, ref)
  return (
    <div className="dropdown" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={open ? 'on' : ''} title={title}>
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className={`dropdown-panel${wide ? ' wide' : ''}`}>
          <MenuList items={items} close={close} />
        </div>
      )}
    </div>
  )
}

/** A menu pinned to a screen position (right click, drop menus). Stays inside the window. */
export function PopupMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useDismiss(true, onClose, ref)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y])
  return (
    <div className="popup-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="popup-title">{title}</div>}
      <MenuList items={items} close={onClose} />
    </div>
  )
}
