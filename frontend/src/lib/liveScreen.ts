/** What an agent's terminal shows that its session record doesn't have yet: the status line while it works
    ("Herding… (34s · ↓ 2.5k tokens)") and the reply it is writing, before the block is done and written down.
    Read from the end of its screen (GET agents/<pane>/output, unwrapped). */

export type Live = { status: string; text: string }

const RULE = /^\s*─{8,}\s*$/
const PROMPT = /^\s*[❯>›]\s?/
// Claude Code's spinner: a glyph, a word with an ellipsis, then what it has used so far in brackets.
const CLAUDE_STATUS = /^\s*[✻✶✳✢✽·*+∗]\s+(\S[^()]*…\s*\(.+\))\s*$/
const CODEX_STATUS = /^\s*[•◦]\s+(Working\b.*?)\s*$/
// Pi's loader: a braille spinner, then its message ("Working (esc to interrupt)").
const PI_STATUS = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(\S.*?)\s*$/
const STATUS: Record<string, RegExp> = { claude: CLAUDE_STATUS, codex: CODEX_STATUS, pi: PI_STATUS }
// A block on Claude Code's screen: "● " then what it said, or the tool it called.
const BLOCK = /^● (.*)$/
const TOOL_BLOCK = /^(?:[A-Z][A-Za-z]*\(|(?:Running|Reading|Read|Searching|Searched|Listed|Wrote|Writing|Update|Updated|Edit|Edited|Bash|Fetch|Web\w*|Task|Agent|User answered|Interrupted)\b)/

/** Where the agent's own input box starts: Claude Code's rule above its ❯ line, Codex's › line, Pi's rule above
    its editor (the second last rule on screen). -1 when it can't be found. */
function boxAt(lines: string[], kind: string): number {
  if (kind === 'pi') {
    const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []))
    return rules.length >= 2 ? rules[rules.length - 2] : -1
  }
  for (let i = lines.length - 1; i > 0; i--) {
    if (kind === 'codex' && /^\s*›\s/.test(lines[i]) && !/^\s*›\s*\d+[.)]/.test(lines[i])) return i
    if (PROMPT.test(lines[i]) && RULE.test(lines[i - 1])) return i - 1
  }
  return -1
}

/** The end of the screen above the agent's own input box, where the conversation ends. */
function transcriptLines(screen: string, kind: string): string[] {
  const lines = screen.replace(/\s+$/, '').split('\n')
  const at = boxAt(lines, kind)
  return at >= 0 ? lines.slice(0, at) : lines
}

export function readLive(screen: string, kind: string): Live {
  if (!screen) return { status: '', text: '' }
  const lines = transcriptLines(screen, kind)
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  let status = ''
  // The status sits at the bottom of the conversation, a line or two above the input box.
  for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
    const m = lines[i].match(STATUS[kind] ?? CLAUDE_STATUS)
    if (m) {
      status = m[1].replace(/\s*[·•]?\s*esc to interrupt\s*/i, '').replace(/\s*[·•]\s*\)/, ')').replace(/\(\s*\)/, '').trim()
      end = i
      break
    }
  }
  if (kind !== 'claude') return { status, text: '' }
  // The last block before it, when it is something said rather than a tool's call.
  let start = -1
  for (let i = end - 1; i >= 0; i--) {
    if (BLOCK.test(lines[i])) {
      start = i
      break
    }
    if (PROMPT.test(lines[i])) break // your message: nothing said since
  }
  if (start < 0) return { status, text: '' }
  const first = lines[start].match(BLOCK)![1]
  if (TOOL_BLOCK.test(first)) return { status, text: '' }
  // While it works the screen comes as shown, wrapped at the terminal's width: a line that reaches the edge goes on.
  const width = Math.max(...lines.map((l) => l.length))
  const body = [first]
  let full = lines[start].length >= width - 12
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim() && !/^\s{2}/.test(line)) break
    const text = line.replace(/^\s{2}/, '')
    if (full && text.trim() && !/^\s*([-*•]|\d+[.)])\s/.test(text)) body[body.length - 1] += ` ${text.trim()}`
    else body.push(text)
    full = line.length >= width - 12
  }
  return { status, text: body.join('\n').trim() }
}

const CHOICE_ONE = /^\s*(?:│\s*)?(?:[❯›>▶→]\s*)?1[.)]\s/
const FRAME = /^[\s│|]*[─━╭╮╰╯┌┐└┘]{3,}/

/** What a question at the bottom of the screen asks: the lines above its first choice ("❯ 1. Yes"), up to the box
    around them or a gap. */
export function readQuestion(screen: string): string {
  const lines = screen.replace(/\s+$/, '').split('\n')
  let at = lines.length
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (CHOICE_ONE.test(lines[i])) {
      at = i
      break
    }
  }
  const asked: string[] = []
  for (let i = at - 1, gap = 0; i >= 0 && asked.length < 14; i--) {
    if (FRAME.test(lines[i])) break
    const line = lines[i].replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '')
    gap = line.trim() ? 0 : gap + 1
    if (gap > 1 && asked.length) break // two blank lines: what came before is the conversation
    asked.unshift(line)
  }
  const text = asked.join('\n').replace(/^\n+|\s+$/g, '')
  const indent = Math.min(...text.split('\n').filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
  return text.split('\n').map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}

/** The status line under the agent's input box, cut into parts: Claude Code's (model, usage, tokens, cost: whatever
    the owner set it to show) at its │, with its mode ("auto mode on") apart; Codex's ("GPT-6.1 default · 5h 100% left
    · Context 0% used") at its ·; Pi's (its context, then its model) at its gaps, with the folder's branch. Without
    the key hints around them. */
export type Footer = { parts: string[]; mode: string }

const NO_FOOTER: Footer = { parts: [], mode: '' }

export function readFooter(screen: string, kind = 'claude'): Footer {
  const lines = screen.replace(/\s+$/, '').split('\n')
  if (kind === 'codex') {
    const at = boxAt(lines, kind)
    if (at < 0) return NO_FOOTER
    const parts = lines
      .slice(at + 1)
      .map((l) => l.trim())
      .filter((l) => l && !/for shortcuts|esc to|^›/.test(l))
      .flatMap((l) => l.split(/\s+·\s+/))
    return { parts: parts.map((p) => p.trim()).filter(Boolean).slice(0, 12), mode: '' }
  }
  if (kind === 'pi') {
    const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []))
    if (rules.length < 2) return NO_FOOTER
    const parts: string[] = []
    for (const raw of lines.slice(rules[rules.length - 1] + 1)) {
      const line = raw.trim()
      if (!line) continue
      // Its first line is the folder and its branch: the branch alone.
      const where = line.match(/^[~/]\S*\s*(?:\((.+)\))?$/)
      if (where) {
        if (where[1]) parts.push(where[1])
        continue
      }
      parts.push(...line.split(/\s{2,}/))
    }
    return { parts: parts.map((p) => p.trim()).filter(Boolean).slice(0, 12), mode: '' }
  }
  if (kind !== 'claude') return NO_FOOTER
  let box = -1
  for (let i = lines.length - 1; i > 0; i--) {
    if (PROMPT.test(lines[i]) && RULE.test(lines[i - 1])) {
      box = i
      break
    }
  }
  if (box < 0) return { parts: [], mode: '' }
  let end = box + 1
  while (end < lines.length && !RULE.test(lines[end])) end++
  const parts: string[] = []
  let mode = ''
  for (const raw of lines.slice(end + 1)) {
    const line = raw.trim()
    if (!line) continue
    if (/\bmode on\b|^⏵⏵|^⏸/.test(line)) {
      mode = line.replace(/^[⏵⏸\s]+/, '').replace(/\s*\([^)]*to cycle\)/, '').replace(/\s*·\s*←.*$/, '').trim()
      continue
    }
    parts.push(...line.split(/\s+[│|]\s+/).map((p) => p.trim()).filter(Boolean))
  }
  return { parts: parts.slice(0, 12), mode }
}

/** A part of the status line that is a share of something, drawn as a meter: Claude Code's bars ("5h █████░░░ 57%
    ↻1h02m"), Codex's "5h 100% left" and "Context 0% used", Pi's "0.0%/524k (auto)". `share` is what is used; `text`
    says it as the agent does. */
export function meterOf(part: string): { label: string; share: number; text: string; rest: string } | null {
  let m = part.match(/^(.*?)\s*[█▉▊▋▌▍▎▏▓▒░■□]+\s*(\d{1,3})%\s*(.*)$/)
  if (m) return { label: m[1], share: Math.min(100, Number(m[2])), text: `${m[2]}%`, rest: m[3] }
  m = part.match(/^(.*?)\s*(\d{1,3})% (left|used)$/)
  if (m) return { label: m[1], share: Math.min(100, m[3] === 'left' ? 100 - Number(m[2]) : Number(m[2])), text: `${m[2]}% ${m[3]}`, rest: '' }
  m = part.match(/^(\d{1,3}(?:\.\d+)?)%\/(\S+)\s*(.*)$/)
  if (m) return { label: 'context', share: Math.min(100, Number(m[1])), text: `${m[1]}%`, rest: `of ${m[2]}${m[3] ? ` ${m[3]}` : ''}` }
  return null
}

/** Letters and digits only: the screen shows markdown already set (no `**`, no backticks), the record as written. */
export const bare = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
