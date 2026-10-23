import { Parser } from '@dbml/core'
import {
  tableId,
  type Column,
  type DbmlError,
  type DiagramModel,
  type EnumDef,
  type GroupDef,
  type IndexDef,
  type ParseResult,
  type RelationDef,
  type TableDef,
} from './dbml'

const DEFAULT_SCHEMA = 'public'

/* eslint-disable @typescript-eslint/no-explicit-any */
const toError = (d: any): DbmlError => ({
  message: d.message,
  line: d.location?.start?.line ?? 1,
  column: d.location?.start?.column ?? 1,
  endLine: d.location?.end?.line ?? d.location?.start?.line ?? 1,
  endColumn: d.location?.end?.column ?? d.location?.start?.column ?? 1,
})

/**
 * Settings the bundled parser doesn't know yet (e.g. `note` on a check constraint, which
 * dbdiagram.io accepts). They don't affect the diagram, so we blank them out and parse again
 * instead of refusing to draw anything.
 */
const isIgnorable = (d: any) => /^Unknown \w+ setting/.test(String(d?.message))

function blankOut(source: string, diags: any[]): string {
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  const offset = (line: number, col: number) => (lineStarts[line - 1] ?? source.length) + col - 1

  const chars = source.split('')
  for (const d of diags) {
    const start = offset(d.location.start.line, d.location.start.column)
    const end = offset(d.location.end.line, d.location.end.column)
    // also remove the comma that separates the setting from the previous one
    let from = start
    for (let i = start - 1; i >= 0 && /\s/.test(chars[i]); i--) from = i
    if (chars[from - 1] === ',') from -= 1
    for (let i = from; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '
  }
  return chars.join('')
}

function exportRaw(source: string): { raw?: any; diags?: any[]; error?: string } {
  try {
    return { raw: (Parser.parse(source, 'dbmlv2') as any).export() }
  } catch (e: any) {
    if (Array.isArray(e?.diags)) return { diags: e.diags }
    return { error: String(e?.message ?? e) }
  }
}

export function parseDbml(source: string): ParseResult {
  if (!source.trim()) {
    return {
      ok: true,
      warnings: [],
      model: { tables: [], relations: [], enums: [], groups: [] },
    }
  }

  let attempt = exportRaw(source)
  const warnings: DbmlError[] = []
  for (let i = 0; i < 3 && attempt.diags?.length; i++) {
    const ignorable = attempt.diags.filter(isIgnorable)
    if (ignorable.length !== attempt.diags.length) break
    warnings.push(...ignorable.map(toError))
    attempt = exportRaw(blankOut(source, ignorable))
  }

  if (!attempt.raw) {
    const errors = attempt.diags
      ? attempt.diags.map(toError)
      : [{ message: attempt.error ?? 'Unknown error', line: 1, column: 1, endLine: 1, endColumn: 1 }]
    return { ok: false, errors }
  }
  return { ok: true, model: buildModel(attempt.raw), warnings }
}

function buildModel(raw: any): DiagramModel {
  const tables: TableDef[] = []
  const relations: RelationDef[] = []
  const enums: EnumDef[] = []
  const groups: GroupDef[] = []

  for (const schema of raw.schemas ?? []) {
    const schemaName: string = schema.name || DEFAULT_SCHEMA
    for (const t of schema.tables ?? []) {
      tables.push({
        id: tableId(schemaName, t.name),
        schema: schemaName,
        name: t.name,
        alias: t.alias ?? null,
        note: t.note ?? null,
        headerColor: t.headerColor ?? null,
        group: null,
        columns: (t.fields ?? []).map(
          (f: any): Column => ({
            name: f.name,
            type: f.type?.type_name ?? '',
            pk: !!f.pk,
            unique: !!f.unique,
            notNull: !!f.not_null,
            increment: !!f.increment,
            note: f.note ?? null,
            defaultValue: f.dbdefault ? String(f.dbdefault.value) : null,
            isFk: false,
          }),
        ),
        indexes: (t.indexes ?? []).map(
          (i: any): IndexDef => ({
            columns: (i.columns ?? []).map((c: any) => String(c.value)),
            unique: !!i.unique,
            pk: !!i.pk,
            name: i.name ?? null,
          }),
        ),
      })
    }
    for (const e of schema.enums ?? []) {
      enums.push({
        id: tableId(schemaName, e.name),
        name: schemaName === DEFAULT_SCHEMA ? e.name : `${schemaName}.${e.name}`,
        values: (e.values ?? []).map((v: any) => ({ name: v.name, note: v.note ?? null })),
      })
    }
    for (const g of schema.tableGroups ?? []) {
      groups.push({
        name: g.name,
        tables: (g.tables ?? []).map((t: any) => tableId(t.schemaName ?? schemaName, t.tableName)),
      })
    }
    for (const r of schema.refs ?? []) {
      const [a, b] = r.endpoints ?? []
      if (!a || !b) continue
      relations.push({
        id: `ref-${relations.length}`,
        name: r.name ?? null,
        from: {
          table: tableId(a.schemaName, a.tableName),
          columns: a.fieldNames ?? [],
          cardinality: a.relation === '*' ? '*' : '1',
        },
        to: {
          table: tableId(b.schemaName, b.tableName),
          columns: b.fieldNames ?? [],
          cardinality: b.relation === '*' ? '*' : '1',
        },
      })
    }
  }

  const byId = new Map(tables.map((t) => [t.id, t]))
  for (const g of groups) {
    for (const id of g.tables) {
      const t = byId.get(id)
      if (t) t.group = g.name
    }
  }

  // The "many" side of a relation holds the foreign key. For 1-1 / many-many, mark the `from` side.
  for (const r of relations) {
    const fkSide =
      r.to.cardinality === '*' && r.from.cardinality === '1' ? r.to : r.from
    const t = byId.get(fkSide.table)
    if (!t) continue
    for (const c of t.columns) if (fkSide.columns.includes(c.name)) c.isFk = true
  }

  return { tables, relations, enums, groups }
}
