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
  const result = parseDbml(e.data.source)
  const res: WorkerResponse = { id: e.data.id, result, ms: performance.now() - t }
  self.postMessage(res)
}
