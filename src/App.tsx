import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { displayName, findTableOffset, type DbmlError, type DiagramModel } from './dbml'
import { useParser } from './useParser'
import { DEFAULT_LAYOUT, LAYOUTS, type LayoutKind, type Positions } from './layout'
import { SAMPLE } from './sample'
import {
  REF_KINDS,
  changeKindEdit,
  deleteRefEdit,
  describeRelation,
  findColumnOffset,
  moveEndEdit,
  refStatement,
  relationExists,
  relationKind,
  suggestKind,
  type Endpoint,
  type TextEdit,
} from './refs'
import { findRefSources, findSourceOf, opKind, type RefSource } from './refSource'
import {
  deleteDoc,
  loadDoc,
  loadIndex,
  newId,
  saveDoc,
  saveIndex,
  type DocData,
  type DocIndex,
} from './store'
import Editor, { type EditorHandle } from './components/Editor'
import Diagram, { type DiagramHandle } from './components/Diagram'
import { EDGE_STYLES, type EdgeStyle } from './components/EdgeCanvas'
import { DiagramsMenu, Dropdown, PopupMenu, type MenuItem } from './components/Menu'

const EMPTY: DiagramModel = { tables: [], relations: [], enums: [], groups: [] }
const NO_ERRORS: DbmlError[] = []
const NEW_TEMPLATE = `Table example {
  id integer [pk, increment]
  name varchar(80) [not null]
  created_at timestamp
}
`

function pref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`dbdiagram:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
const setPref = (key: string, value: unknown) => localStorage.setItem(`dbdiagram:${key}`, JSON.stringify(value))

type PopupState =
  | { kind: 'row'; x: number; y: number; tableId: string; column: string | null }
  | { kind: 'connect'; x: number; y: number; from: Endpoint; to: Endpoint }
  | { kind: 'edge'; x: number; y: number; relId: string; src: RefSource | null; flipped: boolean }

export default function App() {
  /* ---------- saved diagrams ---------- */
  const [index, setIndex] = useState<DocIndex>(loadIndex)
  const first = useRef(loadDoc(index.activeId)).current
  const [source, setSource] = useState(first.source)
  const [session, setSession] = useState({ id: index.activeId, positions: first.positions })
  const positions = useRef<Positions>(first.positions)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const activeId = useRef(index.activeId)
  activeId.current = session.id

  /* ---------- preferences ---------- */
  const [dark, setDark] = useState(() => pref('dark', window.matchMedia('(prefers-color-scheme: dark)').matches))
  const [split, setSplit] = useState(() => pref('split', 0.4))
  const [wrap, setWrap] = useState(() => pref('wrap', true))
  const [edgeStyle, setEdgeStyle] = useState<EdgeStyle>(() => pref('lineStyle', 'stepped'))
  const [layout, setLayout] = useState<LayoutKind>(first.layout ?? DEFAULT_LAYOUT)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [flush, setFlush] = useState(0)
  const reconnect = useRef<{ src: RefSource; side: 'from' | 'to' } | null>(null)

  const [query, setQuery] = useState('')
  const [showEnums, setShowEnums] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [popup, setPopup] = useState<PopupState | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const { result, parsing, ms } = useParser(source, session.id, flush)
  const lastGood = useRef<{ id: string; model: DiagramModel }>({ id: session.id, model: EMPTY })
  if (lastGood.current.id !== session.id) lastGood.current = { id: session.id, model: EMPTY }
  if (result?.ok) lastGood.current = { id: session.id, model: result.model }
  const model = lastGood.current.model
  const modelRef = useRef(model)
  modelRef.current = model
  const errors = result && !result.ok ? result.errors : NO_ERRORS
  const warnings = result?.ok ? result.warnings : NO_ERRORS

  const editor = useRef<EditorHandle>(null)
  const diagram = useRef<DiagramHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    setPref('dark', dark)
  }, [dark])
  useEffect(() => setPref('wrap', wrap), [wrap])
  useEffect(() => setPref('lineStyle', edgeStyle), [edgeStyle])

  /* ---------- persistence ---------- */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current)
    const ok = saveDoc(activeId.current, { source: sourceRef.current, positions: positions.current, layout: layoutRef.current })
    setSaveState(ok ? 'saved' : 'error')
    if (!ok) flash('Browser storage is full: this diagram could not be saved. Delete old diagrams or download the DBML.')
  }, [flash])
  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    setSaveState((s) => (s === 'saving' ? s : 'saving'))
    saveTimer.current = setTimeout(saveNow, 400)
  }, [saveNow])

  useEffect(scheduleSave, [source, scheduleSave])
  useEffect(() => {
    const flush = () => saveNow()
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [saveNow])

  const onPositionsChange = useCallback(
    (p: Positions) => {
      positions.current = p
      scheduleSave()
    },
    [scheduleSave],
  )

  const commitIndex = (next: DocIndex) => {
    setIndex(next)
    saveIndex(next)
  }

  const openDoc = (id: string, data = loadDoc(id), next = index) => {
    const kind = data.layout ?? DEFAULT_LAYOUT
    layoutRef.current = kind
    setLayout(kind)
    positions.current = data.positions
    sourceRef.current = data.source
    activeId.current = id
    setSource(data.source)
    setSession({ id, positions: data.positions })
    commitIndex({ ...next, activeId: id })
    setPopup(null)
  }

  const switchTo = (id: string) => {
    if (id === session.id) return
    saveNow()
    openDoc(id)
  }

  const createDoc = (name: string, text: string, data: DocData = { source: text, positions: {} }) => {
    saveNow()
    const id = newId()
    saveDoc(id, data)
    openDoc(id, data, { ...index, docs: [...index.docs, { id, name, updatedAt: Date.now() }] })
  }

  // the open diagram's latest state lives in refs, the others in storage
  const docData = (id: string): DocData =>
    id === session.id ? { source: sourceRef.current, positions: positions.current, layout: layoutRef.current } : loadDoc(id)

  const duplicateDoc = (id: string) => {
    const name = index.docs.find((d) => d.id === id)?.name ?? 'Untitled'
    const data = docData(id)
    createDoc(uniqueName(`${name} copy`), data.source, data)
  }

  const uniqueName = (base: string) => {
    const taken = new Set(index.docs.map((d) => d.name))
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  const removeDoc = (id: string) => {
    const doc = index.docs.find((d) => d.id === id)
    if (!doc || !window.confirm(`Delete "${doc.name}"? This can't be undone.`)) return
    deleteDoc(id)
    const docs = index.docs.filter((d) => d.id !== id)
    if (!docs.length) {
      const fresh = newId()
      saveDoc(fresh, { source: NEW_TEMPLATE, positions: {} })
      openDoc(fresh, { source: NEW_TEMPLATE, positions: {} }, { activeId: fresh, docs: [{ id: fresh, name: 'Untitled', updatedAt: Date.now() }] })
    } else if (id === session.id) {
      openDoc(docs[0].id, loadDoc(docs[0].id), { ...index, docs })
    } else {
      commitIndex({ ...index, docs })
    }
  }

  const rename = (name: string, id = session.id) =>
    commitIndex({ ...index, docs: index.docs.map((d) => (d.id === id ? { ...d, name } : d)) })

  const activeDoc = index.docs.find((d) => d.id === session.id)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    createDoc(uniqueName(file.name.replace(/\.(dbml|txt)$/i, '') || 'Imported'), await file.text())
  }

  const download = (id = session.id) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([docData(id).source], { type: 'text/plain' }))
    a.download = `${index.docs.find((d) => d.id === id)?.name ?? 'schema'}.dbml`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  /* ---------- diagram <-> editor ---------- */
  const tableById = useMemo(() => new Map(model.tables.map((t) => [t.id, t])), [model])

  const onTableClick = useCallback(
    (id: string) => {
      const t = tableById.get(id)
      if (t) editor.current?.jumpTo(findTableOffset(sourceRef.current, t))
    },
    [tableById],
  )

  const onRowMenu = useCallback((tableId: string, column: string | null, x: number, y: number) => {
    setPopup({ kind: 'row', x, y, tableId, column })
  }, [])

  const applyEdit = useCallback((edit: TextEdit) => {
    setFlush((n) => n + 1) // parse straight away instead of waiting for typing to pause
    editor.current?.replace(edit.from, edit.to, edit.insert)
  }, [])

  const onEdgeClick = useCallback((relId: string, x: number, y: number) => {
    const rel = modelRef.current.relations.find((r) => r.id === relId)
    const found = rel ? findSourceOf(findRefSources(sourceRef.current), rel) : null
    setPopup({ kind: 'edge', x, y, relId, src: found?.src ?? null, flipped: found?.flipped ?? false })
  }, [])

  const onConnect = useCallback(
    (from: Endpoint, to: Endpoint, x: number, y: number, mode: 'drag' | 'pick') => {
      const pending = reconnect.current
      reconnect.current = null
      if (pending && mode === 'pick') {
        const table = modelRef.current.tables.find((t) => t.id === to.tableId)
        const edit = table ? moveEndEdit(pending.src, pending.side, table, to.column) : null
        if (edit) {
          applyEdit(edit)
          flash('Relation updated')
        }
        return
      }
      if (relationExists(modelRef.current, from, to)) {
        flash('That relation already exists')
        return
      }
      setPopup({ kind: 'connect', x, y, from, to })
    },
    [flash, applyEdit],
  )

  const popupItems = (): { title: string; items: MenuItem[] } | null => {
    if (!popup) return null
    if (popup.kind === 'edge') {
      const rel = model.relations.find((r) => r.id === popup.relId)
      if (!rel) return null
      const src = popup.src
      const current = src ? opKind(src.op) : relationKind(rel)
      // sides of the parsed relation vs. sides as written in the text
      const textSide = (side: 'from' | 'to') => (popup.flipped ? (side === 'from' ? 'to' : 'from') : side)
      const movable = (side: 'from' | 'to') => !!src && !!(textSide(side) === 'from' ? src.left : src.right).range && rel[side].columns.length === 1
      const reconnectItem = (side: 'from' | 'to'): MenuItem => ({
        label: `Change column on ${tableById.get(rel[side].table)?.name ?? rel[side].table}…`,
        hint: movable(side) ? 'Then click the column this end should point to' : 'This end is defined by the column itself (inline ref) or is composite',
        disabled: !movable(side),
        onClick: () => {
          if (!src) return
          reconnect.current = { src, side: textSide(side) }
          const fixed = side === 'to' ? { tableId: rel.from.table, column: rel.from.columns[0] } : { tableId: rel.to.table, column: rel.to.columns[0] }
          requestAnimationFrame(() => diagram.current?.pickTarget(fixed))
        },
      })
      return {
        title: describeRelation(rel, tableById),
        items: [
          ...(src ? [] : [{ label: <small>Not found in the DBML text, so it can't be edited here</small>, disabled: true } as MenuItem]),
          ...REF_KINDS.map((k): MenuItem => ({
            label: (
              <span className="doc-item">
                <span className="check">{k.kind === current ? '✓' : ''}</span>
                <code>{k.kind}</code> {k.label}
              </span>
            ),
            hint: k.hint,
            disabled: !src,
            onClick: () => {
              if (src && k.kind !== current) applyEdit(changeKindEdit(src, k.kind))
            },
          })),
          { divider: true, label: '' },
          reconnectItem('from'),
          reconnectItem('to'),
          { label: 'Show in editor', disabled: !src, onClick: () => src && editor.current?.jumpTo(src.at) },
          { divider: true, label: '' },
          { label: 'Delete relation', danger: true, disabled: !src, onClick: () => src && applyEdit(deleteRefEdit(src)) },
        ],
      }
    }
    if (popup.kind === 'connect') {
      const a = tableById.get(popup.from.tableId)
      const b = tableById.get(popup.to.tableId)
      if (!a || !b) return null
      const suggested = suggestKind({ table: a, column: popup.from.column }, { table: b, column: popup.to.column })
      const label = `${displayName(a)}.${popup.from.column} → ${displayName(b)}.${popup.to.column}`
      return {
        title: label,
        items: [...REF_KINDS].sort((x, y) => (x.kind === suggested ? -1 : y.kind === suggested ? 1 : 0)).map((k) => ({
          label: (
            <>
              <code>{k.kind}</code> {k.label}
              {k.kind === suggested && <small className="suggested">suggested</small>}
            </>
          ),
          hint: k.hint,
          onClick: () => {
            setFlush((n) => n + 1)
            editor.current?.append(refStatement({ table: a, column: popup.from.column }, { table: b, column: popup.to.column }, k.kind))
            flash('Relation added to the end of the DBML')
          },
        })),
      }
    }
    const t = tableById.get(popup.tableId)
    if (!t) return null
    const col = popup.column
    const items: MenuItem[] = []
    if (col) {
      items.push({
        label: `Create relation from "${col}"…`,
        hint: 'Then click the column it should point to. You can also drag from the dots next to a column.',
        onClick: () => {
          reconnect.current = null
          requestAnimationFrame(() => diagram.current?.pickTarget({ tableId: t.id, column: col }))
        },
      })
      items.push({ divider: true, label: '' })
    }
    items.push({
      label: 'Show in editor',
      onClick: () => {
        const off = col ? findColumnOffset(sourceRef.current, t, col) : findTableOffset(sourceRef.current, t)
        editor.current?.jumpTo(off)
      },
    })
    items.push({
      label: col ? 'Copy column name' : 'Copy table name',
      onClick: () => void navigator.clipboard?.writeText(col ?? t.name),
    })
    if (col) items.push({ label: 'Copy table.column', onClick: () => void navigator.clipboard?.writeText(`${t.name}.${col}`) })
    return { title: col ? `${displayName(t)}.${col}` : displayName(t), items }
  }

  /* ---------- toolbar bits ---------- */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return model.tables.filter((t) => displayName(t).toLowerCase().includes(q)).slice(0, 12)
  }, [query, model])

  const docActions: MenuItem[] = [
    { label: '+ New diagram', onClick: () => createDoc(uniqueName('Untitled'), NEW_TEMPLATE) },
    { label: 'New from sample', onClick: () => createDoc(uniqueName('Sample e-commerce'), SAMPLE) },
    { label: 'Import .dbml file…', onClick: () => fileInput.current?.click() },
  ]

  const chooseLayout = (kind: LayoutKind) => {
    layoutRef.current = kind
    setLayout(kind)
    diagram.current?.autoLayout(kind)
    scheduleSave()
  }
  const layoutItems: MenuItem[] = [
    ...LAYOUTS.map((l) => ({
      label: <span className="doc-item"><span className="check">{l.kind === layout ? '✓' : ''}</span>{l.label}</span>,
      hint: l.hint,
      active: l.kind === layout,
      onClick: () => chooseLayout(l.kind),
    })),
    { divider: true, label: '' },
    { label: 'Re-apply current sort', hint: 'Sort everything again with the selected mode', onClick: () => chooseLayout(layout) },
  ]

  const styleItems: MenuItem[] = EDGE_STYLES.map((s) => ({
    label: <span className="doc-item"><span className="check">{s.value === edgeStyle ? '✓' : ''}</span>{s.label}</span>,
    onClick: () => setEdgeStyle(s.value),
  }))

  const dragSplit = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) => setSplit(Math.min(0.8, Math.max(0.15, (ev.clientX - rect.left) / rect.width)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSplit((s) => {
        setPref('split', s)
        return s
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.preventDefault()
  }

  const menu = popupItems()

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void onFile(e.dataTransfer.files[0])
      }}
    >
      <header className="toolbar">
        <img src="/icon.svg" alt="" className="logo" />
        <DiagramsMenu
          docs={index.docs}
          activeId={session.id}
          onOpen={switchTo}
          onRename={(id, name) => rename(name, id)}
          onDuplicate={duplicateDoc}
          onDownload={download}
          onDelete={removeDoc}
          actions={docActions}
        />
        <input
          className="doc-name"
          value={activeDoc?.name ?? ''}
          onChange={(e) => rename(e.target.value)}
          onBlur={(e) => !e.target.value.trim() && rename('Untitled')}
          spellCheck={false}
          title="Rename this diagram"
        />
        <input ref={fileInput} type="file" accept=".dbml,.txt,text/plain" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        <div className="sep" />
        <Dropdown label={`Sort: ${LAYOUTS.find((l) => l.kind === layout)?.label ?? ""}`} items={layoutItems} title="Auto sort: re-arrange all tables (remembered per diagram)" wide />
        <Dropdown label={`Lines: ${EDGE_STYLES.find((s) => s.value === edgeStyle)?.label}`} items={styleItems} title="How relations are drawn" />
        <button onClick={() => diagram.current?.fitView()}>Fit</button>
        <button onClick={() => void diagram.current?.exportPng()} title="Download the current view as an image">PNG</button>
        <button onClick={() => download()} title="Download the DBML source">Save .dbml</button>
        <div className="grow" />
        <div className="search">
          <input
            placeholder={`Find table (${model.tables.length})`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) {
                diagram.current?.focusTable(matches[0].id)
                setQuery('')
              }
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {matches.length > 0 && (
            <ul className="search-results">
              {matches.map((t) => (
                <li key={t.id} onMouseDown={() => { diagram.current?.focusTable(t.id); setQuery('') }}>
                  {displayName(t)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={() => setShowEnums((v) => !v)} className={showEnums ? 'on' : ''} disabled={!model.enums.length}>
          Enums ({model.enums.length})
        </button>
        <button onClick={() => setDark((d) => !d)} title="Toggle theme">{dark ? 'Light' : 'Dark'}</button>
      </header>

      <main className="main">
        <section className="pane editor-pane" style={{ width: `${split * 100}%` }}>
          <div className="pane-bar">
            <span>DBML</span>
            <div className="grow" />
            <button className={wrap ? 'on small' : 'small'} onClick={() => setWrap((w) => !w)} title="Wrap long lines">
              Wrap lines
            </button>
          </div>
          <div className="editor-host">
            <Editor ref={editor} value={source} onChange={setSource} errors={errors} warnings={warnings} dark={dark} wrap={wrap} />
          </div>
        </section>
        <div className="divider" onPointerDown={dragSplit} />
        <section className="pane diagram-pane">
          <Diagram
            key={session.id}
            ref={diagram}
            model={model}
            initialPositions={session.positions}
            dark={dark}
            edgeStyle={edgeStyle}
            layoutKind={layout}
            activeRel={popup?.kind === 'edge' ? popup.relId : null}
            onEdgeClick={onEdgeClick}
            onPositionsChange={onPositionsChange}
            onTableClick={onTableClick}
            onRowMenu={onRowMenu}
            onConnect={onConnect}
          />
          {showEnums && (
            <aside className="enums">
              {model.enums.map((e) => (
                <details key={e.id}>
                  <summary>{e.name} <small>({e.values.length})</small></summary>
                  <ul>
                    {e.values.map((v) => (
                      <li key={v.name} title={v.note ?? undefined}>{v.name}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </aside>
          )}
        </section>
      </main>

      <footer className="status">
        <span>{model.tables.length} tables</span>
        <span>{model.relations.length} relations</span>
        <span>{model.enums.length} enums</span>
        <span className="muted tip">Drag the dots beside a column to link it · right-click a line to edit it · right-click a column for more · Ctrl+Z undoes moves</span>
        <div className="grow" />
        <span className={`save-state ${saveState}`} title="Changes are saved in this browser automatically">
          {saveState === 'saved' ? '✓ Saved' : saveState === 'saving' ? 'Saving…' : 'Not saved (storage full)'}
        </span>
        {parsing && <span className="muted">parsing…</span>}
        {!parsing && ms > 0 && <span className="muted">parsed in {Math.round(ms)} ms</span>}
        {warnings.length > 0 && (
          <button className="pill warn" onClick={() => setShowIssues((v) => !v)}>
            {warnings.length} warning{warnings.length > 1 ? 's' : ''}
          </button>
        )}
        {errors.length > 0 ? (
          <button className="pill err" onClick={() => setShowIssues((v) => !v)}>
            {errors.length} error{errors.length > 1 ? 's' : ''} (showing last valid diagram)
          </button>
        ) : (
          !parsing && <span className="pill ok">valid</span>
        )}
        {showIssues && (errors.length > 0 || warnings.length > 0) && (
          <ul className="issues">
            {[...errors.map((e) => ({ e, kind: 'err' })), ...warnings.map((e) => ({ e, kind: 'warn' }))].map(({ e, kind }, i) => (
              <li key={i} className={kind} onClick={() => editor.current?.jumpToLine(e.line)}>
                <b>{e.line}:{e.column}</b> {e.message}
              </li>
            ))}
          </ul>
        )}
      </footer>

      {popup && menu && <PopupMenu x={popup.x} y={popup.y} title={menu.title} items={menu.items} onClose={() => setPopup(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
