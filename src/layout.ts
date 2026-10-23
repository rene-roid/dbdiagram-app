import dagre from '@dagrejs/dagre'
import { displayName, type DiagramModel, type TableDef } from './dbml'
import { tableHeight, TABLE_WIDTH } from './metrics'

export type Positions = Record<string, { x: number; y: number }>

export type LayoutKind = 'hierarchical' | 'vertical' | 'clusters' | 'groups' | 'compact' | 'grid' | 'circular'

export const LAYOUTS: { kind: LayoutKind; label: string; hint: string }[] = [
  { kind: 'groups', label: 'By group / schema', hint: 'One block per TableGroup (or schema), related tables together' },
  { kind: 'hierarchical', label: 'Hierarchy, left to right', hint: 'Parents on the left, children on the right' },
  { kind: 'vertical', label: 'Hierarchy, top to bottom', hint: 'Parents on top, children below' },
  { kind: 'clusters', label: 'Clusters', hint: 'Related tables packed together, one block per connected group' },
  { kind: 'compact', label: 'Compact', hint: 'Tightest packing, ignores relations' },
  { kind: 'grid', label: 'Grid A-Z', hint: 'Alphabetical rows' },
  { kind: 'circular', label: 'Circular', hint: 'All tables on one ring, related tables adjacent' },
]

const GAP = 40
type Rel = { a: string; b: string } // a = parent ("one" side), b = child

interface Block {
  pos: Positions // relative to the block origin
  w: number
  h: number
  label?: string
}

const sizeOf = (t: TableDef) => ({ w: TABLE_WIDTH, h: tableHeight(t) })

function relations(model: DiagramModel, ids: Set<string>): Rel[] {
  const seen = new Set<string>()
  const out: Rel[] = []
  for (const r of model.relations) {
    const f = r.from.table
    const t = r.to.table
    if (f === t || !ids.has(f) || !ids.has(t)) continue
    const [a, b] = r.from.cardinality === '*' && r.to.cardinality === '1' ? [t, f] : [f, t]
    const key = `${a}>${b}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ a, b })
  }
  return out
}

function components(tables: TableDef[], rels: Rel[]): TableDef[][] {
  const parent = new Map(tables.map((t) => [t.id, t.id]))
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!)
      x = parent.get(x)!
    }
    return x
  }
  for (const r of rels) parent.set(find(r.a), find(r.b))
  const groups = new Map<string, TableDef[]>()
  for (const t of tables) {
    const k = find(t.id)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(t)
  }
  return [...groups.values()]
}

function dagreBlock(tables: TableDef[], rels: Rel[], dir: 'LR' | 'TB'): Block {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: dir, nodesep: dir === 'LR' ? 36 : 50, ranksep: dir === 'LR' ? 130 : 90, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const t of tables) g.setNode(t.id, { width: TABLE_WIDTH, height: tableHeight(t) })
  for (const r of rels) g.setEdge(r.a, r.b)
  dagre.layout(g)
  const pos: Positions = {}
  for (const t of tables) {
    const n = g.node(t.id)
    const s = sizeOf(t)
    pos[t.id] = { x: Math.round(n.x - s.w / 2), y: Math.round(n.y - s.h / 2) }
  }
  return wrapRanks(tables, pos, dir)
}

/**
 * A hub table with dozens of relations makes dagre stack every neighbour in one rank, which gives a
 * tall sliver. Ranks that are longer than a "square-ish" target are split into several columns
 * (rows for top-to-bottom); ranks that already fit keep dagre's own positions.
 */
function wrapRanks(tables: TableDef[], pos: Positions, dir: 'LR' | 'TB'): Block {
  const horizontal = dir === 'LR'
  const rankOf = (id: string) => (horizontal ? pos[id].x : pos[id].y)
  const stackOf = (id: string) => (horizontal ? pos[id].y : pos[id].x)
  const stackLen = (t: TableDef) => (horizontal ? tableHeight(t) : TABLE_WIDTH)
  const rankLen = (t: TableDef) => (horizontal ? TABLE_WIDTH : tableHeight(t))
  const area = tables.reduce((s, t) => s + (TABLE_WIDTH + GAP) * (tableHeight(t) + GAP), 0)
  const target = Math.max(...tables.map(stackLen), Math.sqrt(area) * 1.2)
  const rankGap = horizontal ? 130 : 90
  // dagre keeps children level with their parents, which can stretch a big graph into a sliver
  const extentOf = Math.max(...tables.map((t) => stackOf(t.id) + stackLen(t))) - Math.min(...tables.map((t) => stackOf(t.id)))
  const compactAll = extentOf > target * 1.3

  const ranks = new Map<number, TableDef[]>()
  for (const t of tables) {
    const k = rankOf(t.id)
    if (!ranks.has(k)) ranks.set(k, [])
    ranks.get(k)!.push(t)
  }

  const out: Positions = {}
  let cursor = 0
  let w = 0
  let h = 0
  for (const k of [...ranks.keys()].sort((a, b) => a - b)) {
    const members = ranks.get(k)!.sort((a, b) => stackOf(a.id) - stackOf(b.id))
    const span = members.reduce((s, t) => s + stackLen(t) + GAP, -GAP)
    const keep = !compactAll && span <= target
    // pack into columns no longer than the target; a rank that fits stays a single column
    const cols: TableDef[][] = [[]]
    let used = 0
    for (const t of members) {
      if (span > target && used > 0 && used + stackLen(t) > target) {
        cols.push([])
        used = 0
      }
      cols[cols.length - 1].push(t)
      used += stackLen(t) + GAP
    }
    for (const col of cols) {
      let stack = 0
      const extent = Math.max(...col.map(rankLen))
      for (const t of col) {
        const p = keep ? stackOf(t.id) : stack
        out[t.id] = horizontal ? { x: cursor, y: p } : { x: p, y: cursor }
        stack += stackLen(t) + GAP
        w = Math.max(w, out[t.id].x + TABLE_WIDTH)
        h = Math.max(h, out[t.id].y + tableHeight(t))
      }
      cursor += extent + (horizontal ? GAP * 1.5 : GAP)
    }
    cursor += rankGap - (horizontal ? GAP * 1.5 : GAP)
  }
  return { pos: out, w, h }
}

/** Masonry: every table goes into the currently shortest column. */
function masonryBlock(tables: TableDef[], cols?: number): Block {
  const n = tables.length
  const c = Math.max(1, cols ?? Math.round(Math.sqrt(n) * 1.15))
  const heights = new Array<number>(c).fill(0)
  const pos: Positions = {}
  const sorted = [...tables].sort((a, b) => b.columns.length - a.columns.length || a.name.localeCompare(b.name))
  for (const t of sorted) {
    let col = 0
    for (let i = 1; i < c; i++) if (heights[i] < heights[col]) col = i
    pos[t.id] = { x: col * (TABLE_WIDTH + GAP), y: heights[col] }
    heights[col] += tableHeight(t) + GAP
  }
  const used = Math.min(c, n)
  return { pos, w: used * (TABLE_WIDTH + GAP) - GAP, h: Math.max(...heights, GAP) - GAP }
}

function gridBlock(tables: TableDef[]): Block {
  const sorted = [...tables].sort((a, b) => displayName(a).localeCompare(displayName(b)))
  const c = Math.max(1, Math.ceil(Math.sqrt(sorted.length * 1.4)))
  const pos: Positions = {}
  let y = 0
  let w = 0
  for (let i = 0; i < sorted.length; i += c) {
    const row = sorted.slice(i, i + c)
    row.forEach((t, j) => {
      pos[t.id] = { x: j * (TABLE_WIDTH + GAP), y }
    })
    w = Math.max(w, row.length * (TABLE_WIDTH + GAP) - GAP)
    y += Math.max(...row.map((t) => tableHeight(t))) + GAP
  }
  return { pos, w, h: Math.max(y - GAP, 0) }
}

/** Shelf packing: blocks go left to right, wrapping when a row is full. */
function packBlocks(blocks: Block[], maxWidth: number, gap = 90): Positions {
  const out: Positions = {}
  let x = 0
  let y = 0
  let rowH = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > maxWidth) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    for (const [id, p] of Object.entries(b.pos)) out[id] = { x: x + p.x, y: y + p.y }
    x += b.w + gap
    rowH = Math.max(rowH, b.h)
  }
  return out
}

const targetWidth = (blocks: Block[]) => {
  const area = blocks.reduce((s, b) => s + (b.w + 90) * (b.h + 90), 0)
  const widest = Math.max(...blocks.map((b) => b.w), 0)
  return Math.max(widest, Math.sqrt(area) * 1.5)
}

const UNGROUPED = 'Ungrouped'
const GROUP_GAP = 150

/** Lays out one set of tables: each connected component as a hierarchy, lone tables packed together. */
function clusterBlock(tables: TableDef[], allRels: Rel[]): Block {
  const ids = new Set(tables.map((t) => t.id))
  const rels = allRels.filter((r) => ids.has(r.a) && ids.has(r.b))
  const blocks: Block[] = []
  const loose: TableDef[] = []
  for (const c of components(tables, rels)) {
    if (c.length === 1) {
      loose.push(c[0])
      continue
    }
    const set = new Set(c.map((t) => t.id))
    blocks.push(dagreBlock(c, rels.filter((r) => set.has(r.a) && set.has(r.b)), 'LR'))
  }
  blocks.sort((a, b) => b.w * b.h - a.w * a.h)
  if (loose.length) blocks.push(masonryBlock(loose))
  const pos = packBlocks(blocks, targetWidth(blocks))
  let w = 0
  let h = 0
  for (const t of tables) {
    w = Math.max(w, pos[t.id].x + TABLE_WIDTH)
    h = Math.max(h, pos[t.id].y + tableHeight(t))
  }
  return { pos, w, h }
}

function circular(model: DiagramModel, rels: Rel[]): Positions {
  // DFS from the best connected table so neighbours sit next to each other on the ring.
  const adj = new Map<string, string[]>(model.tables.map((t) => [t.id, []]))
  for (const r of rels) {
    adj.get(r.a)!.push(r.b)
    adj.get(r.b)!.push(r.a)
  }
  const byId = new Map(model.tables.map((t) => [t.id, t]))
  const order: TableDef[] = []
  const seen = new Set<string>()
  const starts = [...model.tables].sort((a, b) => adj.get(b.id)!.length - adj.get(a.id)!.length)
  for (const s of starts) {
    if (seen.has(s.id)) continue
    const stack = [s.id]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      order.push(byId.get(id)!)
      const next = adj.get(id)!.filter((n) => !seen.has(n)).sort((a, b) => adj.get(a)!.length - adj.get(b)!.length)
      stack.push(...next)
    }
  }
  const n = order.length
  const radius = Math.max(260, (n * (TABLE_WIDTH + 70)) / (2 * Math.PI))
  const out: Positions = {}
  order.forEach((t, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2
    const { w, h } = sizeOf(t)
    out[t.id] = { x: Math.round(radius + Math.cos(ang) * radius * 1.35 - w / 2), y: Math.round(radius + Math.sin(ang) * radius - h / 2) }
  })
  return out
}

export function layoutModel(model: DiagramModel, kind: LayoutKind): Positions {
  const tables = model.tables
  if (!tables.length) return {}
  const ids = new Set(tables.map((t) => t.id))
  const rels = relations(model, ids)

  switch (kind) {
    case 'circular':
      return circular(model, rels)
    case 'grid': {
      const b = gridBlock(tables)
      return b.pos
    }
    case 'compact':
      return masonryBlock(tables).pos
    case 'groups': {
      const buckets = new Map<string, TableDef[]>()
      const schemas = new Set(tables.map((t) => t.schema))
      for (const t of tables) {
        const key = t.group ?? (schemas.size > 1 ? t.schema : UNGROUPED)
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key)!.push(t)
      }
      // nothing to group by: fall back to clustering by relations
      if (buckets.size === 1) return clusterBlock(tables, rels).pos
      const blocks = [...buckets.entries()]
        .sort((x, y) => (x[0] === UNGROUPED ? 1 : y[0] === UNGROUPED ? -1 : y[1].length - x[1].length))
        .map(([, ts]) => clusterBlock(ts, rels))
      return packBlocks(blocks, targetWidth(blocks), GROUP_GAP)
    }
    case 'clusters':
      return clusterBlock(tables, rels).pos
    case 'vertical':
    case 'hierarchical': {
      const dir = kind === 'vertical' ? 'TB' : 'LR'
      const comps = components(tables, rels)
      const connected = comps.filter((c) => c.length > 1).flat()
      const loose = comps.filter((c) => c.length === 1).flat()
      const out: Positions = {}
      let maxY = 0
      if (connected.length) {
        const set = new Set(connected.map((t) => t.id))
        const b = dagreBlock(connected, rels.filter((r) => set.has(r.a) && set.has(r.b)), dir)
        Object.assign(out, b.pos)
        maxY = b.h
      }
      if (loose.length) {
        const b = masonryBlock(loose, Math.max(2, Math.ceil(Math.sqrt(loose.length * 2))))
        const dy = connected.length ? maxY + 100 : 0
        for (const [id, p] of Object.entries(b.pos)) out[id] = { x: p.x, y: p.y + dy }
      }
      return out
    }
  }
}

export const DEFAULT_LAYOUT: LayoutKind = 'groups'

export const autoLayout = (model: DiagramModel, kind: LayoutKind = DEFAULT_LAYOUT) => layoutModel(model, kind)

/** Place tables that have no saved position to the right of everything already placed. */
export function placeNew(model: DiagramModel, existing: Positions, kind: LayoutKind = DEFAULT_LAYOUT): Positions {
  const out: Positions = {}
  let maxX = -Infinity
  let minY = Infinity
  for (const t of model.tables) {
    const p = existing[t.id]
    if (p) {
      out[t.id] = p
      maxX = Math.max(maxX, p.x + TABLE_WIDTH)
      minY = Math.min(minY, p.y)
    }
  }
  if (maxX === -Infinity) return autoLayout(model, kind)
  let y = minY
  for (const t of model.tables) {
    if (out[t.id]) continue
    out[t.id] = { x: maxX + 80, y }
    y += tableHeight(t) + GAP
  }
  return out
}
