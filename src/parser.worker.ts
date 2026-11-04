import { parseDbml } from './parse'
import type { ParseResult } from './dbml'

export interface WorkerRequest {
  id: number
  source: string
}
export interface WorkerResponse {
  id: number
  result: ParseResult
  ms: number
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const t = performance.now()
  let result: ParseResult
  try {
    result = parseDbml(e.data.source)
  } catch (err) {
    // never leave the UI waiting on a response that will not come
    const message = err instanceof Error ? err.message : String(err)
    result = { ok: false, errors: [{ message, line: 1, column: 1, endLine: 1, endColumn: 1 }] }
  }
  const res: WorkerResponse = { id: e.data.id, result, ms: performance.now() - t }
  self.postMessage(res)
}
