import { tableId, type RelationDef } from './dbml'
import type { RefKind } from './refs'

/**
 * Finds where each relation is written in the DBML text, so the UI can edit or delete it.
 * Handles `Ref: a.x > b.y`, `Ref name { a.x > b.y }` and inline `[ref: > b.y]` column settings.
 */

export interface RefOperand {
  tableId: string
  columns: string[]
  /** text range of the operand, or null when it is implied (the column an inline ref belongs to) */
  range: { from: number; to: number } | null
}

export interface RefSource {
  form: 'short' | 'block' | 'inline'
  /** the operator exactly as written, e.g. `>` or `>?` */
  op: string
  opRange: { from: number; to: number }
  left: RefOperand
  right: RefOperand
  /** range to remove to delete the relation */
  remove: { from: number; to: number }
  /** where to put the cursor when showing it */
  at: number
}

const ID = /(?:"[^"\n]*"|[A-Za-z_][\w$]*)/.source
const COLS = /(?:"[^"\n]*"|[A-Za-z_][\w$]*|\([^)\n]*\))/.source
const OPERAND = `${ID}(?:[.]${ID})?[.]${COLS}`
// `>`, `<`, `-`, `<>`, and the optional variants such as `>?`
const OP = '([?]?(?:<>|<|>|-)[?]?)'

const SHORT = new RegExp(`^([ \\t]*)Ref(?:[ \\t]+${ID})?[ \\t]*:[ \\t]*(${OPERAND})[ \\t]*${OP}[ \\t]*(${OPERAND})`, 'id')
const BLOCK_OPEN = new RegExp(`^[ \\t]*Ref(?:[ \\t]+${ID})?[ \\t]*[{]`, 'i')
const BLOCK_LINE = new RegExp(`^[ \\t]*(${OPERAND})[ \\t]*${OP}[ \\t]*(${OPERAND})`, 'd')
const TABLE_OPEN = new RegExp(`^[ \\t]*Table[ \\t]+(${ID}(?:[.]${ID})?)(?:[ \\t]+as[ \\t]+(${ID}))?[^{\\n]*[{]`, 'i')
const INLINE = new RegExp(`(?:^|[\\[,\\s])ref[ \\t]*:[ \\t]*${OP}[ \\t]*(${OPERAND})`, 'id')

const unquote = (s: string) => s.replace(/"/g, '')

/** Blanks out comments and string contents (same length), so regexes can't match inside them. */
function mask(text: string): string {
  const out: string[] = []
  let mode: 'none' | 'block' | 'triple' = 'none'
  for (const line of text.split('\n')) {
    const chars = line.split('')
    let i = 0
    while (i < chars.length) {
      if (mode === 'block') {
        const end = line.indexOf('*/', i)
        const stop = end < 0 ? chars.length : end + 2
        for (let k = i; k < stop; k++) chars[k] = ' '
        i = stop
        if (end >= 0) mode = 'none'
      } else if (mode === 'triple') {
        const end = line.indexOf("'''", i)
        const stop = end < 0 ? chars.length : end + 3
        for (let k = i; k < stop; k++) chars[k] = ' '
        i = stop
        if (end >= 0) mode = 'none'
      } else if (line.startsWith('//', i)) {
        for (let k = i; k < chars.length; k++) chars[k] = ' '
        i = chars.length
      } else if (line.startsWith('/*', i)) {
        mode = 'block'
        chars[i] = chars[i + 1] = ' '
        i += 2
      } else if (line.startsWith("'''", i)) {
        mode = 'triple'
        chars[i] = chars[i + 1] = chars[i + 2] = ' '
        i += 3
      } else if (chars[i] === "'" || chars[i] === '`') {
        const q = chars[i]
        let k = i + 1
        while (k < chars.length && chars[k] !== q) {
          if (chars[k] === '\\') chars[k++] = ' '
          if (k < chars.length) chars[k] = ' '
          k++
        }
        i = k + 1
      } else i++
    }
    out.push(chars.join(''))
  }
  return out.join('\n')
}

function parseOperand(text: string, from: number, aliases: Map<string, { schema: string; name: string }>): RefOperand {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if (ch === '.' && !quoted) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const colText = parts.pop()!.trim()
  const columns = colText.startsWith('(')
    ? colText.slice(1, -1).split(',').map((c) => unquote(c.trim())).filter(Boolean)
    : [unquote(colText)]
  const table = unquote(parts.pop() ?? '')
  const schemaPart = parts.pop()
  const alias = aliases.get(table)
  const id = schemaPart ? tableId(unquote(schemaPart), table) : alias ? tableId(alias.schema, alias.name) : tableId(null, table)
  return { tableId: id, columns, range: { from, to: from + text.length } }
}

function tableHeader(m: RegExpExecArray) {
  const parts = m[1].split('.').map(unquote)
  const name = parts.pop()!
  return { schema: parts.pop() ?? 'public', name, alias: m[2] ? unquote(m[2]) : null }
}

export function findRefSources(source: string): RefSource[] {
  const masked = mask(source)
  const lines = source.split('\n')
  const mlines = masked.split('\n')
  const starts: number[] = []
  let off = 0
  for (const l of lines) {
    starts.push(off)
    off += l.length + 1
  }

  // pass 1: aliases (`Table users as U`)
  const aliases = new Map<string, { schema: string; name: string }>()
  for (const l of mlines) {
    const m = TABLE_OPEN.exec(l)
    if (m) {
      const h = tableHeader(m)
      if (h.alias) aliases.set(h.alias, { schema: h.schema, name: h.name })
    }
  }

  const out: RefSource[] = []
  let depth = 0
  let table: { schema: string; name: string } | null = null
  let tableDepth = 0
  let block: { startLine: number; found: RefSource[] } | null = null

  const lineEnd = (i: number) => starts[i] + lines[i].length + 1 // include the newline

  for (let i = 0; i < mlines.length; i++) {
    const l = mlines[i]
    const base = starts[i]

    if (block) {
      const m = BLOCK_LINE.exec(l)
      if (m?.indices) {
        const [ls, le] = m.indices[1]!
        const [os, oe] = m.indices[2]!
        const [rs, re] = m.indices[3]!
        block.found.push({
          form: 'block',
          op: m[2],
          opRange: { from: base + os, to: base + oe },
          left: parseOperand(source.slice(base + ls, base + le), base + ls, aliases),
          right: parseOperand(source.slice(base + rs, base + re), base + rs, aliases),
          remove: { from: base, to: lineEnd(i) },
          at: base + ls,
        })
      }
      if (l.includes('}')) {
        // a block with a single relation is removed whole
        if (block.found.length === 1) block.found[0].remove = { from: starts[block.startLine], to: lineEnd(i) }
        out.push(...block.found)
        block = null
      }
      continue
    }

    const short = SHORT.exec(l)
    if (short?.indices && depth === 0) {
      const [ls, le] = short.indices[2]!
      const [os, oe] = short.indices[3]!
      const [rs, re] = short.indices[4]!
      out.push({
        form: 'short',
        op: short[3],
        opRange: { from: base + os, to: base + oe },
        left: parseOperand(source.slice(base + ls, base + le), base + ls, aliases),
        right: parseOperand(source.slice(base + rs, base + re), base + rs, aliases),
        remove: { from: base, to: lineEnd(i) },
        at: base + ls,
      })
    } else if (depth === 0 && BLOCK_OPEN.test(l)) {
      block = { startLine: i, found: [] }
      if (l.includes('}')) block = null
      continue
    }

    const open = depth === 0 ? TABLE_OPEN.exec(l) : null
    if (open) {
      table = tableHeader(open)
      tableDepth = depth + 1
    }

    // inline `[... ref: > other.col ...]` on a column line directly inside a table
    if (table && depth === tableDepth && !open) {
      const col = new RegExp(`^[ \\t]*(${ID})`).exec(l)
      const group = /\[[^\]\n]*\]/.exec(l)
      if (col && group) {
        const inner = group[0]
        const m = INLINE.exec(inner)
        if (m?.indices) {
          const gs = base + group.index
          const [os, oe] = m.indices[1]!
          const [rs, re] = m.indices[2]!
          const settingStart = gs + m.index + m[0].search(/ref/i)
          const settingEnd = gs + re
          out.push({
            form: 'inline',
            op: m[1],
            opRange: { from: gs + os, to: gs + oe },
            left: { tableId: tableId(table.schema, table.name), columns: [unquote(col[1])], range: null },
            right: parseOperand(source.slice(gs + rs, gs + re), gs + rs, aliases),
            remove: inlineRemoval(source, gs, gs + inner.length, settingStart, settingEnd),
            at: base + col.index,
          })
        }
      }
    }

    for (const ch of l) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (table && depth < tableDepth) table = null
      }
    }
  }
  return out
}

/** Removes a `ref: ...` setting together with a neighbouring comma, or the whole `[...]` if it was the only setting. */
function inlineRemoval(source: string, groupStart: number, groupEnd: number, from: number, to: number) {
  let before = from
  while (before > groupStart + 1 && /\s/.test(source[before - 1])) before--
  if (source[before - 1] === ',') return { from: before - 1, to }
  let after = to
  while (after < groupEnd - 1 && /\s/.test(source[after])) after++
  if (source[after] === ',') {
    after++
    while (after < groupEnd - 1 && /\s/.test(source[after])) after++
    return { from, to: after }
  }
  // the only setting: drop the whole bracket group and the space in front of it
  let start = groupStart
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--
  return { from: start, to: groupEnd }
}

/** `>?` -> `>` */
export const opKind = (op: string) => op.replace(/[?]/g, '') as RefKind

const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i])

/**
 * Source statement that defines this relation. `flipped` is true when the text lists the endpoints in
 * the opposite order to the parsed relation (an inline `ref: > roles.id` is reported referenced-table first).
 */
export function findSourceOf(sources: RefSource[], r: RelationDef): { src: RefSource; flipped: boolean } | null {
  for (const s of sources) {
    const fwd = s.left.tableId === r.from.table && s.right.tableId === r.to.table && sameCols(s.left.columns, r.from.columns) && sameCols(s.right.columns, r.to.columns)
    if (fwd) return { src: s, flipped: false }
    const rev = s.left.tableId === r.to.table && s.right.tableId === r.from.table && sameCols(s.left.columns, r.to.columns) && sameCols(s.right.columns, r.from.columns)
    if (rev) return { src: s, flipped: true }
  }
  return null
}
