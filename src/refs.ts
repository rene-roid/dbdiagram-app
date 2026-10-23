import type { DiagramModel, RelationDef, TableDef } from './dbml'
import { displayName, findTableOffset } from './dbml'
import type { RefSource } from './refSource'

export type RefKind = '>' | '<' | '-' | '<>'

export interface Endpoint {
  tableId: string
  column: string
}

export const REF_KINDS: { kind: RefKind; label: string; hint: string }[] = [
  { kind: '>', label: 'Many to one', hint: 'many A rows point to one B row (A has the foreign key)' },
  { kind: '<', label: 'One to many', hint: 'one A row has many B rows (B has the foreign key)' },
  { kind: '-', label: 'One to one', hint: 'each A row matches at most one B row' },
  { kind: '<>', label: 'Many to many', hint: 'many A rows to many B rows' },
]

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/
const quote = (s: string) => (SIMPLE.test(s) ? s : `"${s.replace(/"/g, '')}"`)

const nameOf = (t: TableDef, column: string) =>
  `${t.schema === 'public' ? '' : `${quote(t.schema)}.`}${quote(t.name)}.${quote(column)}`

/** Picks the most likely relation type: the side that is a primary key / unique is the "one" side. */
export function suggestKind(from: { table: TableDef; column: string }, to: { table: TableDef; column: string }): RefKind {
  const isOne = (x: { table: TableDef; column: string }) => {
    const c = x.table.columns.find((c) => c.name === x.column)
    return !!c && (c.pk || c.unique)
  }
  const a = isOne(from)
  const b = isOne(to)
  if (a && b) return '-'
  if (a && !b) return '<'
  return '>'
}

export function refStatement(from: { table: TableDef; column: string }, to: { table: TableDef; column: string }, kind: RefKind) {
  return `Ref: ${nameOf(from.table, from.column)} ${kind} ${nameOf(to.table, to.column)}`
}

/** True when a relation between exactly these two columns already exists (in either direction). */
export function relationExists(model: DiagramModel, a: Endpoint, b: Endpoint) {
  return model.relations.some((r) => {
    const f = { tableId: r.from.table, cols: r.from.columns }
    const t = { tableId: r.to.table, cols: r.to.columns }
    const fwd = f.tableId === a.tableId && f.cols.includes(a.column) && t.tableId === b.tableId && t.cols.includes(b.column)
    const rev = f.tableId === b.tableId && f.cols.includes(b.column) && t.tableId === a.tableId && t.cols.includes(a.column)
    return fwd || rev
  })
}

/** Offset of a column's line inside its table block, or of the table itself when the column isn't found. */
export function findColumnOffset(source: string, table: TableDef, column: string): number {
  const start = findTableOffset(source, table)
  if (start < 0) return -1
  const body = source.indexOf('{', start)
  if (body < 0) return start
  const bare = column.replace(/"/g, '')
  let depth = 0
  let pos = body
  while (pos < source.length) {
    const end = source.indexOf('\n', pos)
    const lineEnd = end < 0 ? source.length : end
    const line = source.slice(pos, lineEnd)
    if (depth === 1) {
      const m = /^[ \t]*"?([^\s"[{]+)"?/.exec(line)
      if (m && m[1] === bare) return pos + line.indexOf(m[1])
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth <= 0 || end < 0) break
    pos = end + 1
  }
  return start
}

/** The DBML operator that describes a parsed relation: many-to-one (>), one-to-many (<), ... */
export function relationKind(r: Pick<RelationDef, 'from' | 'to'>): RefKind {
  const a = r.from.cardinality
  const b = r.to.cardinality
  if (a === '*' && b === '*') return '<>'
  if (a === '*') return '>'
  if (b === '*') return '<'
  return '-'
}

export const kindLabel = (k: RefKind) => REF_KINDS.find((x) => x.kind === k)!.label

export function describeRelation(r: RelationDef, tables: Map<string, TableDef>) {
  const end = (e: RelationDef['from']) => {
    const t = tables.get(e.table)
    return `${t ? displayName(t) : e.table}.${e.columns.join(', ')}`
  }
  return `${end(r.from)} → ${end(r.to)} · ${kindLabel(relationKind(r)).toLowerCase()}`
}

export interface TextEdit {
  from: number
  to: number
  insert: string
}

export const changeKindEdit = (src: RefSource, kind: RefKind): TextEdit => {
  // `>?` (optional) keeps its question mark when the type changes
  const pre = src.op.startsWith('?') ? '?' : ''
  const post = src.op.endsWith('?') ? '?' : ''
  return { ...src.opRange, insert: `${pre}${kind}${post}` }
}

export const deleteRefEdit = (src: RefSource): TextEdit => ({ ...src.remove, insert: '' })

/** Points one end of the relation at another column. The implied column of an inline ref can't be moved. */
export function moveEndEdit(src: RefSource, side: 'from' | 'to', table: TableDef, column: string): TextEdit | null {
  const range = (side === 'from' ? src.left : src.right).range
  if (!range) return null
  return { ...range, insert: nameOf(table, column) }
}
