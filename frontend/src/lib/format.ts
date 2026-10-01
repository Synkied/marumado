export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export const rate = (n: number) => `${bytes(n)}/s`

export function ago(iso: string | number | undefined): string {
  if (!iso) return '—'
  const t = typeof iso === 'number' ? iso * 1000 : Date.parse(iso)
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`
  if (s < 86400 * 60) return `${Math.round(s / 86400 / 7)}w ago`
  return `${Math.round(s / 86400 / 30)}mo ago`
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}
