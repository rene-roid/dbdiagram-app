import type { LayoutKind, Positions } from './layout'
import { SAMPLE } from './sample'

export interface DocMeta {
  id: string
  name: string
  updatedAt: number
}
export interface DocIndex {
  activeId: string
  docs: DocMeta[]
}
export interface DocData {
  source: string
  positions: Positions
  /** the auto-sort mode last used on this diagram */
  layout?: LayoutKind
}

const INDEX_KEY = 'dbdiagram:index'
const docKey = (id: string) => `dbdiagram:doc:${id}`
// keys used before diagrams could be saved side by side
const LEGACY_SOURCE = 'dbdiagram:source'
const LEGACY_POSITIONS = 'dbdiagram:positions'

export const newId = () => Math.random().toString(36).slice(2, 10)

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false // quota exceeded
  }
}

export function loadIndex(): DocIndex {
  const idx = read<DocIndex>(INDEX_KEY)
  if (idx && idx.docs.length && idx.docs.some((d) => d.id === idx.activeId)) return idx

  const legacy = localStorage.getItem(LEGACY_SOURCE)
  const doc: DocMeta = { id: newId(), name: legacy ? 'Untitled' : 'Sample e-commerce', updatedAt: Date.now() }
  const data: DocData = {
    source: legacy ?? SAMPLE,
    positions: read<Positions>(LEGACY_POSITIONS) ?? {},
  }
  write(docKey(doc.id), data)
  const fresh: DocIndex = { activeId: doc.id, docs: [doc] }
  write(INDEX_KEY, fresh)
  localStorage.removeItem(LEGACY_SOURCE)
  localStorage.removeItem(LEGACY_POSITIONS)
  return fresh
}

export const saveIndex = (idx: DocIndex) => write(INDEX_KEY, idx)

export const loadDoc = (id: string): DocData => {
  const d = read<DocData>(docKey(id))
  return { source: d?.source ?? '', positions: d?.positions ?? {}, layout: d?.layout }
}

export const saveDoc = (id: string, data: DocData) => write(docKey(id), data)

export const deleteDoc = (id: string) => localStorage.removeItem(docKey(id))
