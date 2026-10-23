import { useEffect, useRef, useState } from 'react'
import type { ParseResult } from './dbml'
import type { WorkerRequest, WorkerResponse } from './parser.worker'

const DEBOUNCE_MS = 350

interface State {
  result: ParseResult | null
  parsing: boolean
  ms: number
  /** which document the result belongs to */
  docKey: string
}

/**
 * Parses DBML in a Web Worker so typing and dragging never wait on the parser.
 * Switching `docKey` (a different diagram) drops the old result and parses straight away, and so does
 * changing `flushKey` (used for edits made from the UI, which shouldn't wait for typing to pause).
 */
export function useParser(source: string, docKey: string, flushKey = 0) {
  const [state, setState] = useState<State>({ result: null, parsing: true, ms: 0, docKey })
  const worker = useRef<Worker | null>(null)
  const latest = useRef(0)
  const lastDoc = useRef<string | null>(null)
  const lastFlush = useRef(flushKey)

  useEffect(() => {
    const w = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id !== latest.current) return // stale response
      setState((s) => ({ result: e.data.result, parsing: false, ms: e.data.ms, docKey: s.docKey }))
    }
    worker.current = w
    return () => w.terminate()
  }, [])

  useEffect(() => {
    const id = ++latest.current
    const switched = lastDoc.current !== docKey
    lastDoc.current = docKey
    const flushed = lastFlush.current !== flushKey
    lastFlush.current = flushKey
    setState((s) => (switched ? { result: null, parsing: true, ms: 0, docKey } : s.parsing ? s : { ...s, parsing: true }))
    const timer = setTimeout(
      () => {
        const req: WorkerRequest = { id, source }
        worker.current?.postMessage(req)
      },
      switched || flushed ? 0 : DEBOUNCE_MS,
    )
    return () => clearTimeout(timer)
  }, [source, docKey, flushKey])

  // never expose a result that belongs to another diagram
  return state.docKey === docKey ? state : { result: null, parsing: true, ms: 0, docKey }
}
