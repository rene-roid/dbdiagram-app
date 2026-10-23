import type { TableDef } from './dbml'

export const TABLE_WIDTH = 260
export const HEADER_H = 36
export const ROW_H = 26
export const FOOTER_PAD = 4

export const tableHeight = (t: Pick<TableDef, 'columns'>) => HEADER_H + t.columns.length * ROW_H + FOOTER_PAD
