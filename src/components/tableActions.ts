import { createContext } from 'react'

export interface TableActions {
  /** pointer went down on a column's connector dot: start dragging a new relation */
  beginConnect(e: React.PointerEvent, tableId: string, column: string): void
  /** right click on a column row, or on the header when column is null */
  openMenu(e: React.MouseEvent, tableId: string, column: string | null): void
  /** click on a column row: toggle highlighting its relations with flowing dots */
  selectRow(tableId: string, column: string): void
}

export const TableActionsContext = createContext<TableActions>({
  beginConnect() {},
  openMenu() {},
  selectRow() {},
})

export const rowKey = (tableId: string, column: string) => `${tableId}\u0000${column}`

/** rowKey of the column row whose relations are being highlighted, if any */
export const SelectedRowContext = createContext<string | null>(null)
