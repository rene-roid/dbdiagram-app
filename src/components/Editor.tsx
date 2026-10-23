import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import type { DbmlError } from '../dbml'
import { dbml, dbmlHighlight } from '../dbmlLang'

export interface EditorHandle {
  jumpTo(offset: number): void
  jumpToLine(line: number): void
  /** Adds text on new lines at the end of the document (undoable) and scrolls to it. */
  append(text: string): void
  /** Replaces a range of the document (undoable) and scrolls it into view. */
  replace(from: number, to: number, insert: string): void
}

interface Props {
  value: string
  onChange(v: string): void
  errors: DbmlError[]
  warnings: DbmlError[]
  dark: boolean
  wrap: boolean
}

const theme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--editor-bg)', color: 'var(--text)', height: '100%' },
      '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: dark ? 'rgba(56, 139, 253, 0.32)' : 'rgba(9, 105, 218, 0.2)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--editor-gutter)',
        color: 'var(--muted)',
        border: 'none',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': { backgroundColor: dark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(9, 105, 218, 0.06)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
      '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)' },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #ef4444' },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy #d29922' },
    },
    { dark },
  )

const Editor = forwardRef<EditorHandle, Props>(function Editor({ value, onChange, errors, warnings, dark, wrap }, ref) {
  const view = useRef<EditorView | null>(null)

  const extensions = useMemo(
    () => [dbml, dbmlHighlight(dark), theme(dark), ...(wrap ? [EditorView.lineWrapping] : [])],
    [dark, wrap],
  )

  useImperativeHandle(ref, () => ({
    jumpTo(offset) {
      const v = view.current
      if (!v || offset < 0) return
      v.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'start', yMargin: 24 }) })
    },
    jumpToLine(line) {
      const v = view.current
      if (!v) return
      const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines))
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
      v.focus()
    },
    replace(from, to, insert) {
      const v = view.current
      if (!v) return
      const len = v.state.doc.length
      const a = Math.min(Math.max(from, 0), len)
      const b = Math.min(Math.max(to, a), len)
      v.dispatch({
        changes: { from: a, to: b, insert },
        selection: { anchor: a + insert.length },
        effects: EditorView.scrollIntoView(a, { y: 'center' }),
        userEvent: 'input',
      })
    },
    append(text) {
      const v = view.current
      if (!v) return
      const len = v.state.doc.length
      const tail = v.state.doc.sliceString(Math.max(0, len - 2))
      const lead = len === 0 || tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n'
      const insert = `${lead}${text}\n`
      v.dispatch({
        changes: { from: len, insert },
        selection: { anchor: len + insert.length },
        effects: EditorView.scrollIntoView(len + insert.length, { y: 'end', yMargin: 40 }),
        userEvent: 'input',
      })
    },
  }))

  useEffect(() => {
    const v = view.current
    if (!v) return
    const doc = v.state.doc
    const toDiag = (e: DbmlError, severity: Diagnostic['severity']): Diagnostic => {
      const line = doc.line(Math.min(Math.max(e.line, 1), doc.lines))
      const from = Math.min(line.from + Math.max(e.column - 1, 0), line.to)
      let to = e.endLine === e.line ? Math.min(line.from + Math.max(e.endColumn - 1, 0), line.to) : line.to
      if (to <= from) to = Math.min(from + 1, doc.length)
      return { from, to, severity, message: e.message }
    }
    v.dispatch(setDiagnostics(v.state, [...errors.map((e) => toDiag(e, 'error')), ...warnings.map((e) => toDiag(e, 'warning'))]))
  }, [errors, warnings])

  return (
    <CodeMirror
      className="editor"
      value={value}
      height="100%"
      theme="none"
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(v) => {
        view.current = v
      }}
      basicSetup={{ foldGutter: false, autocompletion: false, highlightActiveLine: true, lineNumbers: true }}
    />
  )
})

export default Editor
