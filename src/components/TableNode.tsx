import { memo, useContext } from 'react'
import { useStore, type Node, type NodeProps } from '@xyflow/react'
import { displayName, type TableDef } from '../dbml'
import { FOOTER_PAD, HEADER_H, ROW_H, TABLE_WIDTH } from '../metrics'
import { columnRole, typeCategory } from '../semantic'
import { TableActionsContext } from './tableActions'

export type TableNodeData = { table: TableDef; [key: string]: unknown }
export type TableFlowNode = Node<TableNodeData, 'table'>

const ACCENT = '#0e7490'
// Below this zoom level the column rows are unreadable anyway, so we skip rendering them.
const LOD_ZOOM = 0.3
const isZoomedOut = (s: { transform: [number, number, number] }) => s.transform[2] < LOD_ZOOM

function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table } = data
  const compact = useStore(isZoomedOut)
  const actions = useContext(TableActionsContext)
  const color = table.headerColor ?? ACCENT

  return (
    <div className="table-node" style={{ width: TABLE_WIDTH }} title={table.note ?? undefined}>
      <div
        className="table-header"
        style={{ background: color, height: HEADER_H }}
        onContextMenu={(e) => actions.openMenu(e, table.id, null)}
      >
        <span className="table-name">{displayName(table)}</span>
        {table.group && <span className="table-group">{table.group}</span>}
      </div>
      {compact ? (
        <div style={{ height: table.columns.length * ROW_H + FOOTER_PAD }} />
      ) : (
        <div className="rows" style={{ paddingBottom: FOOTER_PAD }}>
          {table.columns.map((c) => (
            <div
              key={c.name}
              className="row"
              style={{ height: ROW_H }}
              data-table={table.id}
              data-col={c.name}
              title={c.note ?? undefined}
              onContextMenu={(e) => actions.openMenu(e, table.id, c.name)}
            >
              <span
                className="port left nodrag nopan"
                title="Drag to another column to create a relation"
                onPointerDown={(e) => actions.beginConnect(e, table.id, c.name)}
              />
              <span className="badges">
                {c.pk ? <b className="badge pk">PK</b> : c.isFk ? <b className="badge fk">FK</b> : null}
              </span>
              <span className={`col-name role-${columnRole(c.name)}${c.notNull || c.pk ? ' req' : ''}`}>{c.name}</span>
              <span className="col-flags">
                {c.unique && <i title="unique">U</i>}
                {c.increment && <i title="auto increment">+</i>}
              </span>
              <span className={`col-type type-${typeCategory(c.type)}`}>{c.type}</span>
              <span
                className="port right nodrag nopan"
                title="Drag to another column to create a relation"
                onPointerDown={(e) => actions.beginConnect(e, table.id, c.name)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(TableNode)
