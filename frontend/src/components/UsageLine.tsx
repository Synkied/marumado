import { dollars, tokens } from '../lib/format'
import type { Usage } from '../lib/types'
import './usage.css'

/** What an agent used, in one line: its tokens, what they cost at API prices (when every model has a known price), and
    how full its context is. The breakdown is on hover. */
export function UsageLine({ usage, context = true, className = '' }: { usage: Usage; context?: boolean; className?: string }) {
  const t = usage.tokens
  const ctx = context ? usage.context : null
  const detail = [
    `${tokens(t.input)} input, ${tokens(t.cache_read)} read from the cache, ${tokens(t.cache_write + t.cache_write_1h)} written to it, ${tokens(t.output)} output`,
    `${usage.calls} model call${usage.calls === 1 ? '' : 's'}${usage.models.length ? ` (${usage.models.join(', ')})` : ''}`,
    usage.priced ? 'Cost at Anthropic’s API prices: with a subscription, nothing is billed per token.' : 'Not every model has a known price, so no cost is shown.',
  ].join('\n')
  return (
    <p className={`usage ${className}`} title={detail}>
      <span>{tokens(usage.total)} tokens</span>
      {usage.priced && usage.calls > 0 && <span>{dollars(usage.cost)} at API prices</span>}
      {ctx && ctx.tokens > 0 && (
        <span>
          context {tokens(ctx.tokens)}
          {ctx.window ? ` of ${tokens(ctx.window)}` : ''}
        </span>
      )}
    </p>
  )
}
