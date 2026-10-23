import { createContext } from 'react'

export interface TableActions {
  /** pointer went down on a column's connector dot: start dragging a new relation */
  beginConnect(e: React.PointerEvent, tableId: string, column: string): void
  /** right click on a column row, or on the header when column is null */
  openMenu(e: React.MouseEvent, tableId: string, column: string | null): void
}

export const TableActionsContext = createContext<TableActions>({
  beginConnect() {},
  openMenu() {},
})
