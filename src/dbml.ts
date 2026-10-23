export interface Column {
  name: string
  type: string
  pk: boolean
  unique: boolean
  notNull: boolean
  increment: boolean
  note: string | null
  defaultValue: string | null
  isFk: boolean
}

export interface IndexDef {
  columns: string[]
  unique: boolean
  pk: boolean
  name: string | null
}

export interface TableDef {
  id: string
  schema: string
  name: string
  alias: string | null
  note: string | null
  headerColor: string | null
  columns: Column[]
  indexes: IndexDef[]
  group: string | null
}

export type Cardinality = '1' | '*'

export interface RelationDef {
  id: string
  name: string | null
  from: { table: string; columns: string[]; cardinality: Cardinality }
  to: { table: string; columns: string[]; cardinality: Cardinality }
}

export interface EnumDef {
  id: string
  name: string
  values: { name: string; note: string | null }[]
}

export interface GroupDef {
  name: string
  tables: string[]
}

export interface DiagramModel {
  tables: TableDef[]
  relations: RelationDef[]
  enums: EnumDef[]
  groups: GroupDef[]
}

export interface DbmlError {
  message: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export type ParseResult =
  | { ok: true; model: DiagramModel; warnings: DbmlError[] }
  | { ok: false; errors: DbmlError[] }

const DEFAULT_SCHEMA = 'public'

export const tableId = (schema: string | null | undefined, name: string) =>
  `${schema || DEFAULT_SCHEMA}.${name}`

export const displayName = (t: Pick<TableDef, 'schema' | 'name'>) =>
  t.schema === DEFAULT_SCHEMA ? t.name : `${t.schema}.${t.name}`

/** Find the 0-based character offset of a table's definition in the DBML source. */
export function findTableOffset(source: string, t: Pick<TableDef, 'schema' | 'name'>): number {
  const strip = (s: string) => s.replace(/"/g, '')
  const re = /^[ \t]*table\s+([^\s[{]+)/gim
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const parts = strip(m[1]).split('.')
    const name = parts.pop()
    const schema = parts.pop() || DEFAULT_SCHEMA
    if (name === t.name && schema === t.schema) return m.index
  }
  return -1
}
