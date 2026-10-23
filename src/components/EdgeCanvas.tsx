import { useEffect, useRef, type MutableRefObject } from 'react'
import { useStoreApi } from '@xyflow/react'
import type { Cardinality, GroupDef, TableDef } from '../dbml'
import { HEADER_H, ROW_H, TABLE_WIDTH } from '../metrics'

const hueOfName = (name: string) => {
  let h = 7
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) >>> 0
  return h % 360
}

export type EdgeStyle = 'bundled' | 'curved' | 'stepped' | 'straight'

export const EDGE_STYLES: { value: EdgeStyle; label: string }[] = [
  { value: 'bundled', label: 'Bundled' },
  { value: 'curved', label: 'Curved' },
  { value: 'stepped', label: 'Stepped' },
  { value: 'straight', label: 'Straight' },
]

export interface EdgeRec {
  id: string
  /** id of the relation this edge belongs to (composite relations have several edges) */
  relId: string
  source: string
  target: string
  fromCol: number
  toCol: number
  fromCard: Cardinality
  toCard: Cardinality
  hue: number
}

/** which way the dots run along an edge: from→to, to→from, or both (one-to-one, many-to-many) */
export type FlowDir = 'fwd' | 'back' | 'both'

export interface EdgeLayerApi {
  redraw(): void
  /** relation id of the line under the given screen point, if any */
  hitTest(clientX: number, clientY: number): string | null
  /** name of the table group whose title is under the given screen point, if any */
  hitGroup(clientX: number, clientY: number): string | null
}

interface Props {
  edges: EdgeRec[]
  style: EdgeStyle
  dark: boolean
  /** table currently under the mouse; its relations are highlighted like a selected table's */
  hover: MutableRefObject<string | null>
  /** relation under the mouse, highlighted like a selected table's relations */
  hoverEdge: MutableRefObject<string | null>
  /** relation whose edit menu is open */
  activeRel: string | null
  /** edges (by id) of the clicked column row: highlighted, with dots flowing along them */
  flow: Map<string, FlowDir> | null
  /** TableGroups, drawn as tinted boxes behind their tables */
  groups: GroupDef[]
  /** group the user clicked: only its tables and the relations between them stay lit */
  focusGroup: string | null
  apiRef: MutableRefObject<EdgeLayerApi | null>
}

type Pather = Pick<Path2D, 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'arcTo'>
type Side = 1 | -1 // 1: anchored on the right edge of a table, -1: on the left
type Pt = { x: number; y: number }

const rowY = (top: number, col: number) => top + HEADER_H + (col >= 0 ? col * ROW_H + ROW_H / 2 : -HEADER_H / 2)

function roundedPolyline(ctx: Pather, pts: Pt[], radius: number) {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const c = pts[i + 1]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    ctx.arcTo(b.x, b.y, c.x, c.y, r)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
}

/**
 * Traces one relation. Every style leaves the table horizontally, and edges that start at the same
 * column share their first segment, so they read as one line that fans out towards its targets.
 */
function trace(ctx: Pather, style: EdgeStyle, sx: number, sy: number, sSide: Side, tx: number, ty: number, tSide: Side) {
  const opposite = sSide !== tSide
  const gap = Math.abs(tx - sx)
  switch (style) {
    case 'curved': {
      const reach = opposite ? Math.max(40, gap / 2) : 70
      ctx.moveTo(sx, sy)
      ctx.bezierCurveTo(sx + sSide * reach, sy, tx + tSide * reach, ty, tx, ty)
      return
    }
    case 'bundled': {
      const stub = opposite ? Math.min(28, gap / 3) : 30
      const ax = sx + sSide * stub
      const bx = tx + tSide * stub
      const k = opposite ? Math.max(30, Math.abs(bx - ax) * 0.45) : 60
      ctx.moveTo(sx, sy)
      ctx.lineTo(ax, sy)
      ctx.bezierCurveTo(ax + sSide * k, sy, bx + tSide * k, ty, bx, ty)
      ctx.lineTo(tx, ty)
      return
    }
    case 'stepped': {
      // the vertical run sits next to the source, so edges from one column share it
      const channel = opposite ? sx + sSide * Math.min(36, gap / 2) : (sSide === 1 ? Math.max(sx, tx) : Math.min(sx, tx)) + sSide * 36
      roundedPolyline(ctx, [{ x: sx, y: sy }, { x: channel, y: sy }, { x: channel, y: ty }, { x: tx, y: ty }], 10)
      return
    }
    case 'straight': {
      const stub = opposite ? Math.min(20, gap / 3) : 28
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + sSide * stub, sy)
      ctx.lineTo(tx + tSide * stub, ty)
      ctx.lineTo(tx, ty)
      return
    }
  }
}

/** A bar for "one", a crow's foot for "many", drawn at the table edge. */
function drawMarker(ctx: Pather, x: number, y: number, dir: Side, card: Cardinality) {
  if (card === '1') {
    ctx.moveTo(x + dir * 10, y - 5)
    ctx.lineTo(x + dir * 10, y + 5)
    ctx.moveTo(x + dir * 14, y - 5)
    ctx.lineTo(x + dir * 14, y + 5)
  } else {
    const tip = x + dir * 12
    ctx.moveTo(tip, y)
    ctx.lineTo(x, y - 6)
    ctx.moveTo(tip, y)
    ctx.lineTo(x, y + 6)
    ctx.moveTo(tip, y)
    ctx.lineTo(x, y)
  }
}

/** All relations on a single canvas: one cheap draw per frame instead of one SVG per relation. */
export default function EdgeCanvas({ edges, style, dark, hover, hoverEdge, activeRel, flow, groups, focusGroup, apiRef }: Props) {
  const store = useStoreApi()
  const canvas = useRef<HTMLCanvasElement>(null)
  const props = useRef({ edges, style, dark, activeRel, flow, groups, focusGroup })
  props.current = { edges, style, dark, activeRel, flow, groups, focusGroup }
  const hits = useRef<{ relId: string; path: Path2D }[]>([])
  const titleHits = useRef<{ name: string; x: number; y: number; w: number; h: number }[]>([])
  const lastZoom = useRef(1)
  const raf = useRef(0)

  useEffect(() => {
    const draw = () => {
      raf.current = 0
      const el = canvas.current
      if (!el) return
      const { transform, width, height, nodeLookup } = store.getState()
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      const pw = Math.round(width * dpr)
      const ph = Math.round(height * dpr)
      if (el.width !== pw || el.height !== ph) {
        el.width = pw
        el.height = ph
      }
      const ctx = el.getContext('2d')!
      const [tx0, ty0, zoom] = transform
      const { edges, style, dark, activeRel, flow, groups, focusGroup } = props.current
      hits.current = []
      titleHits.current = []
      lastZoom.current = zoom

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, pw, ph)
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * tx0, dpr * ty0)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'

      const vx0 = -tx0 / zoom - 100
      const vy0 = -ty0 / zoom - 100
      const vx1 = (width - tx0) / zoom + 100
      const vy1 = (height - ty0) / zoom + 100

      // table groups: a tinted, labelled box around the member tables
      const PAD = 30
      for (const g of groups) {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const id of g.tables) {
          const n = nodeLookup.get(id)
          if (!n) continue
          const t = (n.data as { table: TableDef }).table
          const p = n.internals.positionAbsolute
          x0 = Math.min(x0, p.x)
          y0 = Math.min(y0, p.y)
          x1 = Math.max(x1, p.x + TABLE_WIDTH)
          y1 = Math.max(y1, p.y + HEADER_H + t.columns.length * ROW_H + 4)
        }
        if (x0 === Infinity || x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue
        const hue = hueOfName(g.name)
        ctx.globalAlpha = focusGroup && focusGroup !== g.name ? 0.25 : 1
        const size = Math.min(160, Math.max(15, 15 / zoom))
        const boxTop = y0 - PAD - size - 18
        ctx.beginPath()
        ctx.roundRect(x0 - PAD, boxTop, x1 - x0 + PAD * 2, y1 + PAD - boxTop, 16)
        ctx.fillStyle = `hsla(${hue} 60% ${dark ? 62 : 50}% / ${dark ? 0.1 : 0.07})`
        ctx.fill()
        ctx.strokeStyle = `hsla(${hue} 60% ${dark ? 66 : 45}% / 0.45)`
        ctx.lineWidth = Math.max(1.5, 1.4 / zoom)
        ctx.setLineDash([10, 7])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = `hsla(${hue} 70% ${dark ? 75 : 35}% / 0.95)`
        ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(g.name, x0 - PAD + 14, boxTop + size + 8)
        titleHits.current.push({ name: g.name, x: x0 - PAD + 6, y: boxTop + 4, w: ctx.measureText(g.name).width + 16, h: size + 14 })
        ctx.globalAlpha = 1
      }
      const inGroup = focusGroup ? new Set(groups.find((g) => g.name === focusGroup)?.tables) : null

      const focus = new Set<string>()
      for (const n of nodeLookup.values()) if (n.selected) focus.add(n.id)
      if (hover.current) focus.add(hover.current)
      const focusRel = hoverEdge.current ?? activeRel
      const flowing = flow !== null && flow.size > 0
      const dim = focus.size > 0 || focusRel !== null || flowing || inGroup !== null
      const dimAlpha = focus.size > 0 ? 0.07 : flowing ? 0.12 : 0.2

      const baseWidth = Math.max(1.5, 1.7 / zoom)
      // dots keep their on-screen look when zoomed out; offset is the distance they have travelled
      const k = Math.max(1, 1 / zoom)
      const spacing = 30 * k
      const travel = (performance.now() / 1000) * 64 * k
      const showMarkers = zoom > 0.35
      const sat = dark ? 70 : 62
      const light = dark ? 68 : 40

      const drawEdge = (e: EdgeRec, active: boolean) => {
        const s = nodeLookup.get(e.source)
        const t = nodeLookup.get(e.target)
        if (!s || !t) return
        const sTable = (s.data as { table: TableDef }).table
        const tTable = (t.data as { table: TableDef }).table
        const sx0 = s.internals.positionAbsolute.x
        const sy0 = s.internals.positionAbsolute.y
        const tx1 = t.internals.positionAbsolute.x
        const ty1 = t.internals.positionAbsolute.y
        if (
          Math.max(sx0, tx1) + TABLE_WIDTH < vx0 ||
          Math.min(sx0, tx1) > vx1 ||
          Math.max(sy0 + sTable.columns.length * ROW_H, ty1 + tTable.columns.length * ROW_H) + HEADER_H < vy0 ||
          Math.min(sy0, ty1) > vy1
        ) {
          return
        }
        const sy = rowY(sy0, e.fromCol)
        const ty = rowY(ty1, e.toCol)
        let sSide: Side
        let tSide: Side
        if (sx0 + TABLE_WIDTH + 24 <= tx1) [sSide, tSide] = [1, -1]
        else if (tx1 + TABLE_WIDTH + 24 <= sx0) [sSide, tSide] = [-1, 1]
        else [sSide, tSide] = [1, 1]
        const sx = sSide === 1 ? sx0 + TABLE_WIDTH : sx0
        const tx = tSide === 1 ? tx1 + TABLE_WIDTH : tx1

        const alpha = active ? 1 : dim ? dimAlpha : dark ? 0.72 : 0.62
        ctx.strokeStyle = `hsla(${e.hue} ${active ? 85 : sat}% ${active ? (dark ? 72 : 36) : light}% / ${alpha})`
        ctx.lineWidth = active ? baseWidth * 1.8 : baseWidth
        const path = new Path2D()
        trace(path, style, sx, sy, sSide, tx, ty, tSide)
        ctx.stroke(path)
        hits.current.push({ relId: e.relId, path })
        const dir = flow?.get(e.id)
        if (dir) {
          // a zero-length round dash is a dot; moving the dash offset slides the dots along the line
          const w = baseWidth * 2.6
          ctx.setLineDash([0.01, spacing])
          const pass = (sign: 1 | -1, shift: number) => {
            ctx.lineDashOffset = -sign * travel + shift
            ctx.strokeStyle = `hsla(${e.hue} 90% ${dark ? 70 : 42}% / 0.5)`
            ctx.lineWidth = w * 2
            ctx.stroke(path)
            ctx.strokeStyle = dark ? `hsl(${e.hue} 100% 94%)` : '#fff'
            ctx.lineWidth = w
            ctx.stroke(path)
          }
          if (dir !== 'back') pass(1, 0)
          if (dir !== 'fwd') pass(-1, dir === 'both' ? spacing / 2 : 0)
          ctx.setLineDash([])
          ctx.lineDashOffset = 0
        }
        if (showMarkers && alpha > 0.1) {
          const marks = new Path2D()
          drawMarker(marks, sx, sy, sSide, e.fromCard)
          drawMarker(marks, tx, ty, tSide, e.toCard)
          ctx.lineWidth = active ? 2.2 : 1.5
          ctx.stroke(marks)
        }
      }

      // dimmed ones first so the highlighted relations always end up on top
      const active: EdgeRec[] = []
      for (const e of edges) {
        if (inGroup && inGroup.has(e.source) && inGroup.has(e.target)) active.push(e)
        else if (dim && (focus.has(e.source) || focus.has(e.target) || e.relId === focusRel || flow?.has(e.id))) active.push(e)
        else drawEdge(e, false)
      }
      for (const e of active) drawEdge(e, true)

      // the dots animate, so keep repainting for as long as some relation is flowing
      if (flowing) raf.current = requestAnimationFrame(draw)
    }

    const schedule = () => {
      if (!raf.current) raf.current = requestAnimationFrame(draw)
    }
    const hitTest = (clientX: number, clientY: number) => {
      const el = canvas.current
      if (!el || !hits.current.length) return null
      const rect = el.getBoundingClientRect()
      const dpr = el.width / rect.width
      const ctx = el.getContext('2d')!
      ctx.lineWidth = 10 / lastZoom.current // about 10px of grab area, whatever the zoom
      const x = (clientX - rect.left) * dpr
      const y = (clientY - rect.top) * dpr
      for (let i = hits.current.length - 1; i >= 0; i--) {
        if (ctx.isPointInStroke(hits.current[i].path, x, y)) return hits.current[i].relId
      }
      return null
    }
    const hitGroup = (clientX: number, clientY: number) => {
      const el = canvas.current
      if (!el || !titleHits.current.length) return null
      const rect = el.getBoundingClientRect()
      const [tx, ty, zoom] = store.getState().transform
      const x = (clientX - rect.left - tx) / zoom
      const y = (clientY - rect.top - ty) / zoom
      return titleHits.current.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)?.name ?? null
    }
    apiRef.current = { redraw: schedule, hitTest, hitGroup }
    const unsubscribe = store.subscribe(schedule)
    schedule()
    return () => {
      unsubscribe()
      apiRef.current = null
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [store, hover, hoverEdge, apiRef])

  // props changed: repaint
  useEffect(() => {
    apiRef.current?.redraw()
  }, [edges, style, dark, activeRel, flow, groups, focusGroup, apiRef])

  return <canvas ref={canvas} className="edge-canvas" />
}
