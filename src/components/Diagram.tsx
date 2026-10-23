import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type NodeChange,
} from '@xyflow/react'
import { toPng } from 'html-to-image'
import type { DiagramModel, GroupDef, TableDef } from '../dbml'
import { autoLayout, layoutModel, placeNew, type LayoutKind, type Positions } from '../layout'
import { describeRelation, type Endpoint } from '../refs'
import EdgeCanvas, { type EdgeLayerApi, type EdgeRec, type EdgeStyle, type FlowDir } from './EdgeCanvas'
import TableNode, { type TableFlowNode } from './TableNode'
import { SelectedRowContext, TableActionsContext, rowKey, type TableActions } from './tableActions'

const nodeTypes = { table: TableNode }
const NO_GROUPS: GroupDef[] = []

export interface DiagramHandle {
  autoLayout(kind: LayoutKind): void
  /** lay out the next parsed model from scratch (used after loading a different schema) */
  layoutNext(): void
  fitView(): void
  focusTable(id: string): void
  exportPng(): Promise<void>
  /** let the user click the target column of a new relation, starting at this column */
  pickTarget(from: Endpoint): void
  undo(): void
  redo(): void
}

interface Props {
  model: DiagramModel
  initialPositions: Positions
  dark: boolean
  edgeStyle: EdgeStyle
  /** draw the TableGroup boxes behind their tables */
  showGroups: boolean
  /** sort mode used when a diagram without saved positions is first laid out */
  layoutKind: LayoutKind
  /** relation whose edit menu is open (kept highlighted) */
  activeRel: string | null
  onEdgeClick(relId: string, x: number, y: number): void
  onPositionsChange(p: Positions): void
  onTableClick(id: string): void
  onRowMenu(tableId: string, column: string | null, x: number, y: number): void
  onConnect(from: Endpoint, to: Endpoint, x: number, y: number, mode: 'drag' | 'pick'): void
}

interface Link {
  x1: number
  y1: number
  x2: number
  y2: number
}

const nodeColor = (n: { data: unknown }) => (n.data as { table: TableDef }).table.headerColor ?? '#0e7490'

function hueOf(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return (h * 137.508) % 360
}

const rowAt = (x: number, y: number) => {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.row[data-table]')
  return el ? { tableId: el.dataset.table!, column: el.dataset.col!, el } : null
}

const Inner = forwardRef<DiagramHandle, Props>(function Inner(props, ref) {
  const { model, initialPositions, dark, edgeStyle, showGroups, activeRel, onPositionsChange } = props
  const rf = useReactFlow()
  const wrap = useRef<HTMLDivElement>(null)
  const positions = useRef<Positions>(initialPositions)
  const [nodes, setNodes] = useState<TableFlowNode[]>([])
  const firstFit = useRef(true)
  const layoutNextModel = useRef(false)
  const hover = useRef<string | null>(null)
  const hoverEdge = useRef<string | null>(null)
  const moveFrame = useRef(0)
  const [overTitle, setOverTitle] = useState(false)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const history = useRef<{ past: Positions[]; future: Positions[] }>({ past: [], future: [] })
  const [, bump] = useState(0)
  const edgeApi = useRef<EdgeLayerApi | null>(null)
  const tableCache = useRef(new Map<string, { key: string; table: TableDef }>())
  const latest = useRef(props)
  latest.current = props

  const [link, setLink] = useState<Link | null>(null)
  const [picking, setPicking] = useState(false)

  const edges = useMemo<EdgeRec[]>(() => {
    const byId = new Map(model.tables.map((t) => [t.id, t]))
    const out: EdgeRec[] = []
    for (const r of model.relations) {
      const a = byId.get(r.from.table)
      const b = byId.get(r.to.table)
      if (!a || !b) continue
      // colour by the table that holds the foreign key, so one table's relations share a colour
      const child = r.to.cardinality === '*' && r.from.cardinality === '1' ? b : a
      const n = Math.max(r.from.columns.length, r.to.columns.length, 1)
      for (let i = 0; i < n; i++) {
        out.push({
          id: `${r.id}:${i}`,
          relId: r.id,
          source: a.id,
          target: b.id,
          fromCol: a.columns.findIndex((c) => c.name === r.from.columns[i]),
          toCol: b.columns.findIndex((c) => c.name === r.to.columns[i]),
          fromCard: r.from.cardinality,
          toCard: r.to.cardinality,
          hue: hueOf(child.id),
        })
      }
    }
    return out
  }, [model])

  // Clicked column row or relation line: its relations get flowing dots, running from the "one" side to the "many" side.
  const [selRow, setSelRow] = useState<{ tableId: string; column: string } | null>(null)
  const [selRel, setSelRel] = useState<string | null>(null)
  // Clicked group title: the other tables fade out. Cleared by Esc, by clicking the title again or empty canvas.
  const [groupPick, setGroupPick] = useState<string | null>(null)
  const focusGroup = showGroups && model.groups.some((g) => g.name === groupPick) ? groupPick : null
  const displayNodes = useMemo(() => {
    if (!focusGroup) return nodes
    const members = new Set(model.groups.find((g) => g.name === focusGroup)?.tables)
    return nodes.map((n) => (members.has(n.id) ? n : { ...n, className: 'dimmed' }))
  }, [nodes, focusGroup, model.groups])
  const pickGroup = (name: string | null) => {
    setGroupPick(name)
    const g = name ? model.groups.find((x) => x.name === name) : null
    if (g) rf.fitView({ nodes: g.tables.filter((id) => rf.getNode(id)).map((id) => ({ id })), padding: 0.2, duration: 400 })
  }
  const flow = useMemo(() => {
    let match: ((e: EdgeRec) => boolean) | null = null
    if (selRel) match = (e) => e.relId === selRel
    else if (selRow) {
      const col = model.tables.find((t) => t.id === selRow.tableId)?.columns.findIndex((c) => c.name === selRow.column) ?? -1
      if (col >= 0) match = (e) => (e.source === selRow.tableId && e.fromCol === col) || (e.target === selRow.tableId && e.toCol === col)
    }
    if (!match) return null
    const out = new Map<string, FlowDir>()
    for (const e of edges) {
      if (!match(e)) continue
      out.set(e.id, e.fromCard === '1' && e.toCard === '*' ? 'fwd' : e.fromCard === '*' && e.toCard === '1' ? 'back' : 'both')
    }
    return out
  }, [selRow, selRel, edges, model])

  useEffect(() => {
    if (!selRow && !selRel && !focusGroup) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest('input, textarea, .cm-editor')) return
      setSelRow(null)
      setSelRel(null)
      setGroupPick(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selRow, selRel, focusGroup])

  // Rebuild nodes when the model changes, keeping positions of tables that already exist.
  useEffect(() => {
    const fresh = layoutNextModel.current
    const placed = fresh ? autoLayout(model, latest.current.layoutKind) : placeNew(model, positions.current, latest.current.layoutKind)
    if (fresh && model.tables.length) {
      firstFit.current = true
      layoutNextModel.current = false
    }
    positions.current = placed
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      return model.tables.map((t) => {
        // reuse the previous table object (and node) when the table is unchanged
        const key = JSON.stringify(t)
        const cached = tableCache.current.get(t.id)
        const table = cached && cached.key === key ? cached.table : t
        tableCache.current.set(t.id, { key, table })
        const old = prevById.get(t.id)
        const pos = placed[t.id]
        if (old && old.data.table === table && old.position.x === pos.x && old.position.y === pos.y) return old
        return { id: t.id, type: 'table' as const, position: pos, data: { table }, selected: old?.selected ?? false }
      })
    })
    onPositionsChange(placed)
    if (firstFit.current && model.tables.length) {
      firstFit.current = false
      requestAnimationFrame(() => rf.fitView({ padding: 0.1, duration: 0 }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])

  const pushHistory = useCallback((snapshot: Positions) => {
    const h = history.current
    h.past.push({ ...snapshot })
    if (h.past.length > 200) h.past.shift()
    h.future = []
    bump((n) => n + 1)
  }, [])

  const applyPositions = useCallback(
    (p: Positions) => {
      const next = { ...positions.current, ...p }
      positions.current = next
      setNodes((ns) => ns.map((n) => (next[n.id] ? { ...n, position: next[n.id] } : n)))
      onPositionsChange(next)
    },
    [onPositionsChange],
  )

  const undo = useCallback(() => {
    const h = history.current
    const prev = h.past.pop()
    if (!prev) return
    h.future.push({ ...positions.current })
    applyPositions(prev)
    bump((n) => n + 1)
  }, [applyPositions])

  const redo = useCallback(() => {
    const h = history.current
    const next = h.future.pop()
    if (!next) return
    h.past.push({ ...positions.current })
    applyPositions(next)
    bump((n) => n + 1)
  }, [applyPositions])

  // Ctrl+Z / Ctrl+Y move tables back and forth, except while typing: the editor has its own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el?.closest('.cm-editor, input, textarea, [contenteditable=true]')) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (k === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const dragStart = useRef<Positions | null>(null)
  const onDragStart = useCallback(() => {
    dragStart.current = { ...positions.current }
  }, [])

  const commitPositions = useCallback(() => {
    const next: Positions = {}
    let moved = false
    const before = dragStart.current
    for (const n of rf.getNodes()) {
      next[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
      const b = before?.[n.id]
      if (!b || b.x !== next[n.id].x || b.y !== next[n.id].y) moved = true
    }
    if (moved && before) pushHistory(before)
    dragStart.current = null
    positions.current = next
    onPositionsChange(next)
  }, [rf, onPositionsChange, pushHistory])

  /* ---------- creating relations from the UI ---------- */

  const clearDropTarget = () => wrap.current?.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'))

  // Follows the pointer from `start` (a point inside the diagram) and reports the column under it on release.
  const trackLink = useCallback((from: Endpoint, start: { x: number; y: number }, mode: 'drag' | 'pick') => {
    const move = (ev: PointerEvent) => {
      const b = wrap.current!.getBoundingClientRect()
      setLink({ x1: start.x, y1: start.y, x2: ev.clientX - b.left, y2: ev.clientY - b.top })
      clearDropTarget()
      const hit = rowAt(ev.clientX, ev.clientY)
      if (hit && !(hit.tableId === from.tableId && hit.column === from.column)) hit.el.classList.add('drop-target')
    }
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
      clearDropTarget()
      setLink(null)
      setPicking(false)
      if (!ev) return
      const hit = rowAt(ev.clientX, ev.clientY)
      if (hit && !(hit.tableId === from.tableId && hit.column === from.column)) {
        latest.current.onConnect(from, { tableId: hit.tableId, column: hit.column }, ev.clientX, ev.clientY, mode)
      }
    }
    const up = (ev: PointerEvent) => {
      if (mode === 'drag') finish(ev)
    }
    const down = (ev: PointerEvent) => {
      if (mode !== 'pick') return
      ev.stopPropagation()
      ev.preventDefault()
      finish(ev)
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
  }, [])

  const actions = useMemo<TableActions>(
    () => ({
      beginConnect(e, tableId, column) {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const target = e.currentTarget as HTMLElement
        const row = target.closest('.row')!.getBoundingClientRect()
        const b = wrap.current!.getBoundingClientRect()
        const start = { x: (target.classList.contains('left') ? row.left : row.right) - b.left, y: row.top + row.height / 2 - b.top }
        setLink({ x1: start.x, y1: start.y, x2: e.clientX - b.left, y2: e.clientY - b.top })
        trackLink({ tableId, column }, start, 'drag')
      },
      openMenu(e, tableId, column) {
        e.preventDefault()
        e.stopPropagation()
        latest.current.onRowMenu(tableId, column, e.clientX, e.clientY)
      },
      selectRow(tableId, column) {
        setSelRel(null)
        setSelRow((s) => (s && s.tableId === tableId && s.column === column ? null : { tableId, column }))
      },
    }),
    [trackLink],
  )

  useImperativeHandle(
    ref,
    () => ({
      autoLayout(kind) {
        pushHistory(positions.current)
        const p = layoutModel(model, kind)
        positions.current = p
        setNodes((ns) => ns.map((n) => ({ ...n, position: p[n.id] ?? n.position })))
        onPositionsChange(p)
        requestAnimationFrame(() => rf.fitView({ padding: 0.1, duration: 400 }))
      },
      layoutNext() {
        layoutNextModel.current = true
      },
      fitView() {
        rf.fitView({ padding: 0.1, duration: 300 })
      },
      focusTable(id) {
        const n = rf.getNode(id)
        if (!n) return
        setNodes((ns) => ns.map((x) => (x.selected === (x.id === id) ? x : { ...x, selected: x.id === id })))
        const w = n.measured?.width ?? 260
        const h = n.measured?.height ?? 200
        rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 })
      },
      async exportPng() {
        const el = wrap.current?.querySelector<HTMLElement>('.react-flow')
        if (!el) return
        const url = await toPng(el, {
          pixelRatio: 2,
          backgroundColor: dark ? '#283040' : '#f5f7fa',
          filter: (n) => !(n instanceof HTMLElement && /react-flow__(controls|minimap|panel)|zoom-badge|link-overlay/.test(n.className?.toString() ?? '')),
        })
        const a = document.createElement('a')
        a.href = url
        a.download = 'diagram.png'
        a.click()
      },
      undo,
      redo,
      pickTarget(from) {
        const row = wrap.current?.querySelector<HTMLElement>(`.row[data-table="${CSS.escape(from.tableId)}"][data-col="${CSS.escape(from.column)}"]`)
        if (!row) return
        const b = wrap.current!.getBoundingClientRect()
        const r = row.getBoundingClientRect()
        const start = { x: r.right - b.left, y: r.top + r.height / 2 - b.top }
        setPicking(true)
        setLink({ x1: start.x, y1: start.y, x2: start.x, y2: start.y })
        trackLink(from, start, 'pick')
      },
    }),
    [model, rf, dark, onPositionsChange, trackLink, pushHistory, undo, redo],
  )

  const relById = useMemo(() => new Map(model.relations.map((r) => [r.id, r])), [model])
  const tableById = useMemo(() => new Map(model.tables.map((t) => [t.id, t])), [model])

  const setHoverEdge = (id: string | null, x: number, y: number) => {
    if (id !== hoverEdge.current) {
      hoverEdge.current = id
      edgeApi.current?.redraw()
    }
    const rel = id ? relById.get(id) : null
    setTip(rel ? { x, y, text: describeRelation(rel, tableById) } : null)
  }

  const onPaneMouseMove = (e: React.MouseEvent) => {
    if (link) return
    const { clientX, clientY } = e
    cancelAnimationFrame(moveFrame.current)
    moveFrame.current = requestAnimationFrame(() => {
      const b = wrap.current?.getBoundingClientRect()
      if (!b) return
      setHoverEdge(edgeApi.current?.hitTest(clientX, clientY) ?? null, clientX - b.left, clientY - b.top)
      setOverTitle(edgeApi.current?.hitGroup(clientX, clientY) != null)
    })
  }

  const path = link
    ? (() => {
        const dx = Math.max(40, Math.abs(link.x2 - link.x1) / 2)
        const dir = link.x2 >= link.x1 ? 1 : -1
        return `M${link.x1} ${link.y1}C${link.x1 + dir * dx} ${link.y1} ${link.x2 - dir * dx} ${link.y2} ${link.x2} ${link.y2}`
      })()
    : null

  return (
    <TableActionsContext.Provider value={actions}>
     <SelectedRowContext.Provider value={selRow ? rowKey(selRow.tableId, selRow.column) : null}>
      <div className={`diagram-wrap${link ? ' linking' : ''}${tip || overTitle ? ' edge-hover' : ''}`} ref={wrap}>
        <ReactFlow
          nodes={displayNodes}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStart={onDragStart}
          onNodeDragStop={commitPositions}
          onPaneClick={(e) => {
            // a click on a group title focuses that group, on a relation line selects it, on empty canvas clears both
            const group = edgeApi.current?.hitGroup(e.clientX, e.clientY) ?? null
            if (group) {
              setSelRow(null)
              setSelRel(null)
              if (group === focusGroup) setGroupPick(null)
              else pickGroup(group)
              return
            }
            setGroupPick(null)
            const id = edgeApi.current?.hitTest(e.clientX, e.clientY) ?? null
            setSelRow(null)
            setSelRel((s) => (id && id !== s ? id : null))
          }}
          onPaneMouseMove={onPaneMouseMove}
          onPaneMouseLeave={() => setHoverEdge(null, 0, 0)}
          onPaneContextMenu={(e) => {
            // relations are edited from the right-click menu; a plain left click only pans/selects
            const id = edgeApi.current?.hitTest(e.clientX, e.clientY)
            e.preventDefault()
            if (id) props.onEdgeClick(id, e.clientX, e.clientY)
          }}
          onNodeClick={(_, n) => props.onTableClick(n.id)}
          onNodeMouseEnter={(_, n) => {
            hover.current = n.id
            setHoverEdge(null, 0, 0)
            edgeApi.current?.redraw()
          }}
          onNodeMouseLeave={() => {
            hover.current = null
            edgeApi.current?.redraw()
          }}
          nodesConnectable={false}
          deleteKeyCode={null}
          minZoom={0.03}
          maxZoom={2.5}
          nodeDragThreshold={2}
          onlyRenderVisibleElements
          colorMode={dark ? 'dark' : 'light'}
        >
          <EdgeCanvas edges={edges} style={edgeStyle} dark={dark} hover={hover} hoverEdge={hoverEdge} activeRel={activeRel} flow={flow} groups={showGroups ? model.groups : NO_GROUPS} focusGroup={focusGroup} apiRef={edgeApi} />
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
          <Controls showInteractive={false} />
          {nodes.length > 0 && (
            <MiniMap
              pannable
              zoomable
              nodeColor={nodeColor}
              nodeStrokeWidth={0}
              maskColor={dark ? 'rgba(30, 36, 50, 0.7)' : 'rgba(240, 242, 245, 0.7)'}
            />
          )}
          <ZoomBadge />
          <Panel position="top-left" className="history-panel">
            <button onClick={undo} disabled={!history.current.past.length} title="Undo move (Ctrl+Z)">↶</button>
            <button onClick={redo} disabled={!history.current.future.length} title="Redo move (Ctrl+Shift+Z)">↷</button>
          </Panel>
        </ReactFlow>
        {tip && <div className="edge-tip" style={{ left: tip.x + 14, top: tip.y + 16 }}>{tip.text}<small>right-click to edit</small></div>}
        {link && path && (
          <svg className="link-overlay">
            <path d={path} className="link-line" />
            <circle cx={link.x1} cy={link.y1} r={4.5} className="link-dot" />
            <circle cx={link.x2} cy={link.y2} r={4.5} className="link-dot" />
          </svg>
        )}
        {picking && <div className="pick-banner">Click the column to link to · Esc to cancel</div>}
      </div>
     </SelectedRowContext.Provider>
    </TableActionsContext.Provider>
  )
})

function ZoomBadge() {
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  return <div className="zoom-badge">{zoom}%</div>
}

const Diagram = forwardRef<DiagramHandle, Props>(function Diagram(props, ref) {
  return (
    <ReactFlowProvider>
      <Inner {...props} ref={ref} />
    </ReactFlowProvider>
  )
})

export default Diagram
