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

export interface DocEntry {
  id: string
  name: string
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const PENCIL = 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z'
const COPY = 'M8 8h12v12H8zM4 16V4h12'
const TRASH = 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6'

/**
 * The saved-diagrams switcher. Rows open on click; rename with double click or F2;
 * hover shows rename/duplicate/delete; right click a row for the full list.
 */
export function DiagramsMenu({
  docs,
  activeId,
  onOpen,
  onRename,
  onDuplicate,
  onDownload,
  onDelete,
  actions,
}: {
  docs: DocEntry[]
  activeId: string
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDownload: (id: string) => void
  onDelete: (id: string) => void
  actions: MenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    setEditing(null)
    setCtx(null)
  }
  useDismiss(open, close, ref)

  const pick = (id: string) => {
    close()
    onOpen(id)
  }
  const commit = (id: string, value: string) => {
    if (value.trim()) onRename(id, value.trim())
    setEditing(null)
  }
  const ctxDoc = ctx && docs.find((d) => d.id === ctx.id)

  return (
    <div className="dropdown" ref={ref}>
      <button onClick={() => (open ? close() : setOpen(true))} className={open ? 'on' : ''} title="Switch, rename and manage saved diagrams">
        <strong>Diagrams</strong> <span className="count">{docs.length}</span> <span className="caret">▾</span>
      </button>
      {open && (
        <div className="dropdown-panel docs-panel">
          <div className="docs-head">Saved in this browser</div>
          <ul className="docs-list" role="menu">
            {docs.map((d) => (
              <li
                key={d.id}
                role="menuitem"
                tabIndex={0}
                className={`doc-row${d.id === activeId ? ' active' : ''}`}
                onClick={() => editing !== d.id && pick(d.id)}
                onDoubleClick={() => setEditing(d.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter') pick(d.id)
                  if (e.key === 'F2') setEditing(d.id)
                  if (e.key === 'Delete') onDelete(d.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setCtx({ id: d.id, x: e.clientX, y: e.clientY })
                }}
              >
                <span className="doc-dot" />
                {editing === d.id ? (
                  <input
                    className="doc-rename"
                    defaultValue={d.name}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commit(d.id, e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') commit(d.id, e.currentTarget.value)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span className="doc-label" title={d.name}>{d.name}</span>
                )}
                {editing !== d.id && (
                  <span className="doc-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                    <button title="Rename (F2)" onClick={() => setEditing(d.id)}><Icon d={PENCIL} /></button>
                    <button title="Duplicate" onClick={() => onDuplicate(d.id)}><Icon d={COPY} /></button>
                    <button title="Delete" className="danger" onClick={() => onDelete(d.id)}><Icon d={TRASH} /></button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="menu-divider" role="separator" />
          <MenuList items={actions} close={close} />
        </div>
      )}
      {ctx && ctxDoc && (
        <PopupMenu
          x={ctx.x}
          y={ctx.y}
          title={ctxDoc.name}
          onClose={() => setCtx(null)}
          items={[
            { label: 'Open', disabled: ctx.id === activeId, onClick: () => pick(ctx.id) },
            { label: 'Rename', hint: 'F2 or double click', onClick: () => setEditing(ctx.id) },
            { label: 'Duplicate', onClick: () => onDuplicate(ctx.id) },
            { label: 'Download .dbml', onClick: () => onDownload(ctx.id) },
            { divider: true, label: '' },
            { label: 'Delete…', danger: true, onClick: () => onDelete(ctx.id) },
          ]}
        />
      )}
    </div>
  )
}
