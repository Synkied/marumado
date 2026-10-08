import { Fragment, type ReactNode } from 'react'

/** What an agent writes, set as text: paragraphs, headings, lists, quotes, tables, code blocks, inline code, bold,
    italics and links. Built as elements (never as HTML), so nothing it says can run in the page. */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  const key = () => out.length
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(FENCE)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      out.push(
        <pre className="md__code" key={key()} data-lang={fence[2] || undefined}>
          {body.join('\n')}
        </pre>,
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      out.push(
        <p className={`md__h md__h--${Math.min(heading[1].length, 3)}`} key={key()}>
          {inline(heading[2])}
        </p>,
      )
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push(<hr className="md__rule" key={key()} />)
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(
        <div className="md__table" key={key()}>
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {head.map((_, m) => (
                    <td key={m}>{inline(r[m] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)![1])
      out.push(
        <blockquote className="md__quote" key={key()}>
          {blocks(body.join('\n'))}
        </blockquote>,
      )
      continue
    }
    if (ITEM.test(line)) {
      const [, indent, marker] = line.match(ITEM)!
      const ordered = /\d/.test(marker)
      // The list sits at its first item's indent (an agent may indent a whole list), so that line is always taken:
      // one left there would come back here forever.
      const margin = new RegExp(`^ {0,${indent.length}}`)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(ITEM)
        if (m && m[1].length <= indent.length) items.push(m[3])
        else if (lines[i].trim() && (m || /^\s+/.test(lines[i])) && items.length) items[items.length - 1] += `\n${lines[i].replace(margin, '').replace(/^\s{1,4}/, '')}`
        else break
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List className="md__list" key={key()}>
          {items.map((it, n) => (
            <li key={n}>{it.includes('\n') ? blocks(it) : inline(it)}</li>
          ))}
        </List>,
      )
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i]) && !QUOTE.test(lines[i])) para.push(lines[i++])
    out.push(
      <p key={key()}>
        {para.map((l, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return out
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

// Inline code first (nothing inside it is read), then links, bold, italics and bare addresses.
const INLINE = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const k = out.length
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(link(m[4], inline(m[3]), k))
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k}>{inline(m[5] ?? m[6])}</strong>)
    else if (m[7] !== undefined) out.push(<em key={k}>{inline(m[7])}</em>)
    else if (m[8] !== undefined) out.push(link(m[8], m[8], k))
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Only web addresses become links; anything else stays as written. */
function link(href: string, label: ReactNode, key: number): ReactNode {
  if (!/^https?:\/\//i.test(href)) return <Fragment key={key}>{label}</Fragment>
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  )
}
