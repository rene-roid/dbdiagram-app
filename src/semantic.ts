export type TypeCategory = 'int' | 'float' | 'text' | 'time' | 'bool' | 'uuid' | 'json' | 'binary' | 'other'

const TYPE_TABLE: [TypeCategory, string][] = [
  ['int', 'int integer smallint bigint tinyint mediumint serial smallserial bigserial int2 int4 int8 uint'],
  ['float', 'decimal numeric float float4 float8 double real money number dec fixed'],
  ['text', 'varchar char text string nvarchar nchar citext longtext mediumtext tinytext character varchar2 nvarchar2 clob'],
  ['time', 'date time timestamp timestamptz timetz datetime datetime2 interval year smalldatetime'],
  ['bool', 'bool boolean bit'],
  ['uuid', 'uuid guid uniqueidentifier'],
  ['json', 'json jsonb xml hstore variant object array'],
  ['binary', 'blob bytea binary varbinary bytes longblob mediumblob tinyblob'],
]

const TYPE_LOOKUP = new Map<string, TypeCategory>()
for (const [cat, words] of TYPE_TABLE) for (const w of words.split(' ')) TYPE_LOOKUP.set(w, cat)

/** int, varchar(50), "public"."my_type", text[] ... -> a coarse category used for colouring. */
export function typeCategory(type: string): TypeCategory {
  const base = type
    .toLowerCase()
    .replace(/"/g, '')
    .replace(/\(.*$/, '')
    .replace(/\[.*$/, '')
    .split('.')
    .pop()!
    .trim()
  return TYPE_LOOKUP.get(base) ?? TYPE_LOOKUP.get(base.split(' ')[0]) ?? 'other'
}

export type ColumnRole = 'id' | 'ref' | 'name' | 'time' | 'flag' | 'contact' | 'plain'

/** "Typical" column names get their own colour: id, user_id, name, created_at, is_active, email ... */
export function columnRole(name: string): ColumnRole {
  const n = name.replace(/"/g, '').toLowerCase()
  if (n === 'id' || n === 'uuid' || n === '_id' || n === 'pk') return 'id'
  if (/(_id|_uuid|_fk|_key)$/.test(n) || /^(fk|ref)_/.test(n)) return 'ref'
  if (/^(name|title|label|slug|code|full_?name|first_?name|last_?name|display_?name|user_?name|description|nombre)$/.test(n)) return 'name'
  if (/(_at|_on|_date|_time|_ts)$/.test(n) || /^(created|updated|deleted|date|timestamp|fecha)/.test(n)) return 'time'
  if (/^(is|has|can|should|was)_/.test(n) || /^(active|enabled|disabled|deleted|archived|visible|public|verified)$/.test(n)) return 'flag'
  if (/(email|phone|mobile|url|website|address|telefono)/.test(n)) return 'contact'
  return 'plain'
}
