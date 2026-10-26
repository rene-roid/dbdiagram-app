import { useEffect, useRef, type MutableRefObject } from 'react'
import { useStoreApi } from '@xyflow/react'
import type { Cardinality, GroupDef, TableDef } from '../dbml'
import { HEADER_H, ROW_H, TABLE_WIDTH } from '../metrics'

const hueOfName = (name: string) => {
  let h = 7
  for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) >>> 0
  return h % 360
}

export type EdgeStyle = 'bundled' | 'curved' | 'stepped' | 'straight' | 'lanes'

export const EDGE_STYLES: { value: EdgeStyle; label: string }[] = [
  { value: 'bundled', label: 'Bundled' },
  { value: 'curved', label: 'Curved' },
  { value: 'stepped', label: 'Stepped' },
  { value: 'straight', label: 'Straight' },
  { value: 'lanes', label: 'Lanes' },
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
  /** colour in the lanes style, where every relation gets its own */
  laneHue: number
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
type NodeLookup = ReturnType<ReturnType<typeof useStoreApi>['getState']>['nodeLookup']
/** where an edge leaves its source table and enters its target */
type Ends = { sx: number; sy: number; sSide: Side; tx: number; ty: number; tSide: Side }
type Route = { pts: Pt[]; sSide: Side; tSide: Side }

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

function endsOf(e: EdgeRec, nodeLookup: NodeLookup): Ends | null {
  const s = nodeLookup.get(e.source)
  const t = nodeLookup.get(e.target)
  if (!s || !t) return null
  const sx0 = s.internals.positionAbsolute.x
  const tx1 = t.internals.positionAbsolute.x
  let sSide: Side
  let tSide: Side
  if (sx0 + TABLE_WIDTH + 24 <= tx1) [sSide, tSide] = [1, -1]
  else if (tx1 + TABLE_WIDTH + 24 <= sx0) [sSide, tSide] = [-1, 1]
  else [sSide, tSide] = [1, 1]
  return {
    sx: sSide === 1 ? sx0 + TABLE_WIDTH : sx0,
    sy: rowY(s.internals.positionAbsolute.y, e.fromCol),
    sSide,
    tx: tSide === 1 ? tx1 + TABLE_WIDTH : tx1,
    ty: rowY(t.internals.positionAbsolute.y, e.toCol),
    tSide,
  }
}

const LANE = 10 // distance between neighbouring lanes
const STUB = 20 // room for the end marker before a line may turn

/**
 * Right-angled routes where no two lines share a vertical run: each one gets its own lane (a free x
 * on a 10px grid) between the tables, and lines ending at the same row fan out a little so their
 * horizontal runs don't overlap either. Short runs are placed first so they take the lanes nearest
 * the source, which keeps nested lines from crossing.
 */
function routeLanes(edges: EdgeRec[], nodeLookup: NodeLookup) {
  const items: { e: EdgeRec; g: Ends }[] = []
  for (const e of edges) {
    const g = endsOf(e, nodeLookup)
    if (g) items.push({ e, g })
  }

  // lines ending at the same row (and side) of a table: spread them out, ordered by where they go
  const atRow = new Map<string, { g: Ends; end: 's' | 't'; other: number }[]>()
  const add = (key: string, g: Ends, end: 's' | 't', other: number) => {
    const list = atRow.get(key)
    if (list) list.push({ g, end, other })
    else atRow.set(key, [{ g, end, other }])
  }
  for (const { e, g } of items) {
    add(`${e.source}|${e.fromCol}|${g.sSide}`, g, 's', g.ty)
    add(`${e.target}|${e.toCol}|${g.tSide}`, g, 't', g.sy)
  }
  for (const list of atRow.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => a.other - b.other)
    const step = Math.min(5, 16 / (list.length - 1))
    list.forEach((it, i) => {
      const dy = (i - (list.length - 1) / 2) * step
      if (it.end === 's') it.g.sy += dy
      else it.g.ty += dy
    })
  }

  items.sort((a, b) => Math.abs(a.g.ty - a.g.sy) - Math.abs(b.g.ty - b.g.sy))
  const taken = new Map<number, [number, number][]>() // lane index -> vertical runs already in it
  const free = (lane: number, y0: number, y1: number) => !taken.get(lane)?.some(([a, b]) => a < y1 + LANE && b > y0 - LANE)
  const routes = new Map<string, Route>()
  for (const { e, g } of items) {
    const { sx, sy, sSide, tx, ty, tSide } = g
    const y0 = Math.min(sy, ty)
    const y1 = Math.max(sy, ty)
    if (sSide !== tSide && y1 - y0 < 0.5) {
      routes.set(e.id, { pts: [{ x: sx, y: sy }, { x: tx, y: ty }], sSide, tSide })
      continue
    }
    const dir = sSide
    // facing tables: lanes between them; otherwise lanes beside the one that sticks out further
    const start = sSide !== tSide ? sx + dir * STUB : (dir === 1 ? Math.max(sx, tx) : Math.min(sx, tx)) + dir * STUB
    const end = sSide !== tSide ? tx - dir * STUB : start + dir * LANE * 60
    const first = dir === 1 ? Math.ceil(start / LANE) : Math.floor(start / LANE)
    const last = dir === 1 ? Math.floor(end / LANE) : Math.ceil(end / LANE)
    let x: number
    if ((last - first) * dir < 0) {
      x = (sx + tx) / 2 // tables too close for any lane
    } else {
      let lane = first
      while (lane !== last && !free(lane, y0, y1)) lane += dir
      // every lane is busy: share the middle one
      if (!free(lane, y0, y1)) lane = Math.round((first + last) / 2)
      const runs = taken.get(lane)
      if (runs) runs.push([y0, y1])
      else taken.set(lane, [[y0, y1]])
      x = lane * LANE
    }
    routes.set(e.id, { pts: [{ x: sx, y: sy }, { x, y: sy }, { x, y: ty }, { x: tx, y: ty }], sSide, tSide })
  }
  return routes
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
    case 'lanes': // routed all at once by routeLanes
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
  const lanes = useRef<{ edges: EdgeRec[]; sig: number; routes: Map<string, Route> } | null>(null)
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
      const laneMode = style === 'lanes'
      const sat = laneMode ? (dark ? 75 : 70) : dark ? 70 : 62
      const light = laneMode ? (dark ? 66 : 42) : dark ? 68 : 40
      const restAlpha = laneMode ? 0.9 : dark ? 0.72 : 0.62

      let routes: Map<string, Route> | null = null
      if (laneMode) {
        // lanes depend on where every table is, so only re-route when something moved
        let sig = nodeLookup.size
        for (const n of nodeLookup.values()) {
          const p = n.internals.positionAbsolute
          sig = (Math.imul(sig, 31) + Math.round(p.x * 4)) | 0
          sig = (Math.imul(sig, 31) + Math.round(p.y * 4)) | 0
        }
        const c = lanes.current
        if (!c || c.edges !== edges || c.sig !== sig) lanes.current = { edges, sig, routes: routeLanes(edges, nodeLookup) }
        routes = lanes.current!.routes
      }

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
        const r: Route | Ends | null | undefined = routes ? routes.get(e.id) : endsOf(e, nodeLookup)
        if (!r) return
        const path = new Path2D()
        let sx, sy, tx, ty
        if ('pts' in r) {
          ;({ x: sx, y: sy } = r.pts[0])
          ;({ x: tx, y: ty } = r.pts[r.pts.length - 1])
          roundedPolyline(path, r.pts, 6)
        } else {
          ;({ sx, sy, tx, ty } = r)
          trace(path, style, sx, sy, r.sSide, tx, ty, r.tSide)
        }
        const { sSide, tSide } = r

        const hue = laneMode ? e.laneHue : e.hue
        const alpha = active ? 1 : dim ? dimAlpha : restAlpha
        ctx.strokeStyle = `hsla(${hue} ${active ? 85 : sat}% ${active ? (dark ? 72 : 36) : light}% / ${alpha})`
        ctx.lineWidth = active ? baseWidth * 1.8 : baseWidth
        ctx.stroke(path)
        hits.current.push({ relId: e.relId, path })
        const dir = flow?.get(e.id)
        if (dir) {
          // a zero-length round dash is a dot; moving the dash offset slides the dots along the line
          const w = baseWidth * 2.6
          ctx.setLineDash([0.01, spacing])
          const pass = (sign: 1 | -1, shift: number) => {
            ctx.lineDashOffset = -sign * travel + shift
            ctx.strokeStyle = `hsla(${hue} 90% ${dark ? 70 : 42}% / 0.5)`
            ctx.lineWidth = w * 2
            ctx.stroke(path)
            ctx.strokeStyle = dark ? `hsl(${hue} 100% 94%)` : '#fff'
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
