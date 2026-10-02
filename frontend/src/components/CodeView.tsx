import { useEffect, useRef, useState } from 'react'
import './codeview.css'

/** Syntax colours: each module colour mixed toward the ink, so code stays readable in both themes. */
const tone = (c: string) => `var(${c})`

/**
 * A read-only CodeMirror 6 view of `text`, highlighted for `filename`'s language.
 * CodeMirror and the language are loaded on first use, so they cost nothing until a file is opened.
 */
export function CodeView({ text, filename }: { text: string; filename: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let view: { destroy(): void } | undefined
    let cancelled = false
    ;(async () => {
      try {
        const [{ EditorView, basicSetup }, { EditorState }, { HighlightStyle, syntaxHighlighting, LanguageDescription }, { tags: t }, { languages }] = await Promise.all([
          import('codemirror'),
          import('@codemirror/state'),
          import('@codemirror/language'),
          import('@lezer/highlight'),
          import('@codemirror/language-data'),
        ])
        const lang = LanguageDescription.matchFilename(languages, filename)
        const support = lang ? await lang.load().catch(() => null) : null
        if (cancelled || !host.current) return
        const highlight = HighlightStyle.define([
          { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.moduleKeyword], color: tone('--syn-keyword') },
          { tag: [t.string, t.special(t.string), t.regexp], color: tone('--syn-string') },
          { tag: [t.number, t.bool, t.null, t.atom], color: tone('--syn-number') },
          { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: tone('--syn-function') },
          { tag: [t.typeName, t.className, t.namespace], color: tone('--syn-type') },
          { tag: [t.propertyName, t.attributeName], color: tone('--syn-property') },
          { tag: [t.tagName, t.heading], color: tone('--syn-tag'), fontWeight: '600' },
          { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--ink-2)', fontStyle: 'italic' },
          { tag: [t.meta, t.processingInstruction], color: 'var(--ink-2)' },
          { tag: t.link, textDecoration: 'underline' },
          { tag: t.strong, fontWeight: '700' },
          { tag: t.emphasis, fontStyle: 'italic' },
          { tag: t.invalid, color: 'var(--signal-text)' },
        ])
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              EditorState.readOnly.of(true),
              EditorView.lineWrapping,
              syntaxHighlighting(highlight),
              ...(support ? [support] : []),
            ],
          }),
        })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      view?.destroy()
    }
  }, [text, filename])

  if (failed) return <pre className="logs codeview__plain">{text}</pre>
  return <div className="codeview" ref={host} aria-label={`Contents of ${filename}`} />
}
