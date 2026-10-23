import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StringStream } from '@codemirror/language'
import { Tag, tags as t } from '@lezer/highlight'
import { columnRole, typeCategory } from './semantic'

/** One tag per kind of thing worth colouring differently. */
const T = {
  block: Tag.define(),
  tableName: Tag.define(),
  alias: Tag.define(),
  colId: Tag.define(),
  colRef: Tag.define(),
  colName: Tag.define(),
  colTime: Tag.define(),
  colFlag: Tag.define(),
  colContact: Tag.define(),
  col: Tag.define(),
  typeInt: Tag.define(),
  typeFloat: Tag.define(),
  typeText: Tag.define(),
  typeTime: Tag.define(),
  typeBool: Tag.define(),
  typeUuid: Tag.define(),
  typeJson: Tag.define(),
  typeBinary: Tag.define(),
  typeOther: Tag.define(),
  setting: Tag.define(),
  refOp: Tag.define(),
  refTarget: Tag.define(),
  enumValue: Tag.define(),
  literal: Tag.define(),
  expr: Tag.define(),
  color: Tag.define(),
}

const TOKEN_TABLE: Record<string, Tag> = {
  comment: t.comment,
  string: t.string,
  number: t.number,
  punctuation: t.punctuation,
  block: T.block,
  tableName: T.tableName,
  alias: T.alias,
  colId: T.colId,
  colRef: T.colRef,
  colName: T.colName,
  colTime: T.colTime,
  colFlag: T.colFlag,
  colContact: T.colContact,
  col: T.col,
  typeInt: T.typeInt,
  typeFloat: T.typeFloat,
  typeText: T.typeText,
  typeTime: T.typeTime,
  typeBool: T.typeBool,
  typeUuid: T.typeUuid,
  typeJson: T.typeJson,
  typeBinary: T.typeBinary,
  typeOther: T.typeOther,
  setting: T.setting,
  refOp: T.refOp,
  refTarget: T.refTarget,
  enumValue: T.enumValue,
  literal: T.literal,
  expr: T.expr,
  color: T.color,
  plain: t.variableName,
}

const ROLE_TOKEN = {
  id: 'colId',
  ref: 'colRef',
  name: 'colName',
  time: 'colTime',
  flag: 'colFlag',
  contact: 'colContact',
  plain: 'col',
} as const

const TYPE_TOKEN = {
  int: 'typeInt',
  float: 'typeFloat',
  text: 'typeText',
  time: 'typeTime',
  bool: 'typeBool',
  uuid: 'typeUuid',
  json: 'typeJson',
  binary: 'typeBinary',
  other: 'typeOther',
} as const

const BLOCKS = new Set(['table', 'tablegroup', 'tablepartial', 'enum', 'ref', 'project', 'note', 'indexes', 'checks', 'records', 'diagramview'])
const NAMED_BLOCKS = new Set(['table', 'tablegroup', 'tablepartial', 'enum', 'project', 'diagramview', 'records'])
const INNER_BLOCKS = new Set(['indexes', 'checks', 'note', 'records'])
const SETTINGS = new Set([
  'pk', 'primary', 'key', 'null', 'not', 'unique', 'increment', 'default', 'ref', 'note', 'name', 'type',
  'headercolor', 'color', 'delete', 'update', 'cascade', 'restrict', 'set', 'no', 'action', 'btree', 'hash',
  'gin', 'gist', 'true', 'false',
])

interface State {
  mode: 'none' | 'comment' | 'str3'
  stack: string[]
  pending: string | null
  expectName: boolean
  col: number
  brackets: number
  parens: number
}

const top = (s: State) => s.stack[s.stack.length - 1] ?? 'root'

function identifier(stream: StringStream, state: State): string {
  const word = stream.current().replace(/"/g, '')
  const lower = word.toLowerCase()
  const ctx = top(state)

  // setting lists: [pk, not null, ref: > users.id, note: '...']
  if (state.brackets > 0) {
    return SETTINGS.has(lower) ? 'setting' : 'refTarget'
  }

  // block keywords: Table, Enum, Ref, indexes, Note ...
  if (BLOCKS.has(lower) && state.col === 0 && !state.expectName) {
    const inner = ctx !== 'root'
    const nextIsOpener = stream.match(/^\s*[:{]/, false)
    if (!inner || (INNER_BLOCKS.has(lower) && nextIsOpener)) {
      state.pending = lower
      state.expectName = NAMED_BLOCKS.has(lower) || (lower === 'ref' && !nextIsOpener)
      if (lower === 'ref' || lower === 'note') state.expectName = false
      return 'block'
    }
  }

  // name that follows a block keyword: Table users as U {
  if (state.expectName) {
    if (lower === 'as') return 'block'
    return 'tableName'
  }

  if (state.pending === 'ref' || ctx === 'ref') return 'refTarget'

  switch (ctx) {
    case 'table':
    case 'tablepartial': {
      const c = state.col++
      if (c === 0) return ROLE_TOKEN[columnRole(word)]
      if (c === 1) return TYPE_TOKEN[typeCategory(word)]
      return 'plain'
    }
    case 'enum':
      return state.col++ === 0 ? 'enumValue' : 'plain'
    case 'indexes':
      return ROLE_TOKEN[columnRole(word)]
    case 'tablegroup':
      return 'tableName'
    case 'project':
      return state.col++ === 0 ? 'col' : 'plain'
  }
  if (lower === 'true' || lower === 'false' || lower === 'null') return 'literal'
  return 'plain'
}

export const dbml = StreamLanguage.define<State>({
  name: 'dbml',
  tokenTable: TOKEN_TABLE,
  startState: () => ({ mode: 'none', stack: [], pending: null, expectName: false, col: 0, brackets: 0, parens: 0 }),
  token(stream, state) {
    if (state.mode === 'comment') {
      if (stream.skipTo('*/')) {
        stream.match('*/')
        state.mode = 'none'
      } else stream.skipToEnd()
      return 'comment'
    }
    if (state.mode === 'str3') {
      if (stream.skipTo("'''")) {
        stream.match("'''")
        state.mode = 'none'
      } else stream.skipToEnd()
      return 'string'
    }
    if (stream.sol()) {
      state.col = 0
      state.expectName = false
      if (state.brackets === 0) state.pending = state.pending && top(state) === 'root' && state.pending !== 'ref' ? state.pending : null
    }
    if (stream.eatSpace()) return null

    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      state.mode = 'comment'
      return 'comment'
    }
    if (stream.match("'''")) {
      state.mode = 'str3'
      return 'string'
    }
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string'
    if (stream.match(/^`[^`]*`?/)) return 'expr'
    if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'color'
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number'

    if (stream.match(/^"[^"\n]*"?/)) {
      // quoted identifiers are names, not strings
      return identifier(stream, state)
    }
    if (stream.match(/^[A-Za-z_][\w$]*/)) return identifier(stream, state)

    const ch = stream.next()!
    switch (ch) {
      case '{': {
        const kind = state.pending ?? 'other'
        state.stack.push(kind === 'ref' ? 'ref' : kind)
        state.pending = null
        state.expectName = false
        state.col = 0
        return 'punctuation'
      }
      case '}':
        state.stack.pop()
        state.col = 0
        return 'punctuation'
      case '[':
        // `int[]` is an array type, not a settings list
        if (stream.match(/^\d*\]/)) return 'punctuation'
        state.brackets++
        return 'punctuation'
      case ']':
        state.brackets = Math.max(0, state.brackets - 1)
        return 'punctuation'
      case '(':
        state.parens++
        return 'punctuation'
      case ')':
        state.parens = Math.max(0, state.parens - 1)
        return 'punctuation'
      case '<':
        stream.eat('>')
        return 'refOp'
      case '>':
        stream.eat('?')
        return 'refOp'
      case '-':
        return 'refOp'
      case ':':
        state.expectName = false
        return 'punctuation'
      default:
        return 'punctuation'
    }
  },
})

export interface Palette {
  [key: string]: string
}

const DARK: Palette = {
  block: '#c792ea',
  tableName: '#ffcb6b',
  alias: '#ffcb6b',
  colId: '#f2cc60',
  colRef: '#ff7eb6',
  colName: '#7ee787',
  colTime: '#6cb6ff',
  colFlag: '#ffa657',
  colContact: '#4fd1c5',
  col: '#d6dde6',
  typeInt: '#ff7b72',
  typeFloat: '#d2a8ff',
  typeText: '#8bd5ca',
  typeTime: '#91d7e3',
  typeBool: '#f5a97f',
  typeUuid: '#c6a0f6',
  typeJson: '#eed49f',
  typeBinary: '#ed8796',
  typeOther: '#b7bdf8',
  setting: '#ff9e64',
  refOp: '#f38ba8',
  refTarget: '#a6c8ff',
  enumValue: '#94e2d5',
  literal: '#ff9e64',
  expr: '#56b6c2',
  color: '#e5c07b',
  string: '#a6da95',
  number: '#e5c07b',
  comment: '#6e7a8a',
  punctuation: '#8b97a8',
}

const LIGHT: Palette = {
  block: '#8250df',
  tableName: '#9a6700',
  alias: '#9a6700',
  colId: '#a16207',
  colRef: '#c2185b',
  colName: '#1a7f37',
  colTime: '#0969da',
  colFlag: '#bc4c00',
  colContact: '#0f766e',
  col: '#24292f',
  typeInt: '#cf222e',
  typeFloat: '#8250df',
  typeText: '#0a7f6f',
  typeTime: '#0e7490',
  typeBool: '#c2410c',
  typeUuid: '#7e22ce',
  typeJson: '#a16207',
  typeBinary: '#be123c',
  typeOther: '#4f46e5',
  setting: '#c2570c',
  refOp: '#d6336c',
  refTarget: '#1f6feb',
  enumValue: '#0f766e',
  literal: '#c2570c',
  expr: '#0e7490',
  color: '#9a6700',
  string: '#1a7f37',
  number: '#9a6700',
  comment: '#8c959f',
  punctuation: '#6e7781',
}

const TYPE_KEYS = new Set<string>(Object.keys(TYPE_TOKEN).map((k) => TYPE_TOKEN[k as keyof typeof TYPE_TOKEN]))
const BOLD = new Set(['block', 'tableName', 'colId', 'colName', 'refOp'])

function style(p: Palette) {
  const spec: { tag: Tag; color: string; fontWeight?: string; fontStyle?: string }[] = []
  for (const [key, tag] of Object.entries(T)) {
    spec.push({
      tag,
      color: p[key],
      ...(BOLD.has(key) ? { fontWeight: '600' } : {}),
      ...(TYPE_KEYS.has(key) ? { fontStyle: 'italic' } : {}),
    })
  }
  spec.push(
    { tag: t.comment, color: p.comment, fontStyle: 'italic' },
    { tag: t.string, color: p.string },
    { tag: t.number, color: p.number },
    { tag: t.punctuation, color: p.punctuation },
  )
  return HighlightStyle.define(spec)
}

export const dbmlHighlight = (dark: boolean) => syntaxHighlighting(style(dark ? DARK : LIGHT))
