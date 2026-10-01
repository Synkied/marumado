const TOKEN_KEY = 'marumado.token'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private mode: token lives for this page only */
  }
}

export type MachineId = 'local' | number

let machine: MachineId = 'local'

/** Which machine the API answers for. Other machines are reached through this Marumado (`/api/machines/<id>/…`). */
export function setApiMachine(id: MachineId) {
  machine = id
}

/** `path` as seen from the chosen machine. The list of machines always comes from this Marumado. */
export function apiPath(path: string): string {
  return machine === 'local' || path === 'machines' || path.startsWith('machines/') || path.startsWith('machines?') ? path : `machines/${machine}/${path}`
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let body = init.body
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }
  const res = await fetch(`/api/${apiPath(path)}`, { ...init, headers, body })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    let detail = res.statusText
    if (typeof data === 'object' && data && 'detail' in data) detail = String(data.detail)
    // A form's field errors: {"field": ["message"]}
    else if (typeof data === 'object' && data && Object.keys(data).length) detail = Object.values(data).flat().join(' ')
    throw new ApiError(res.status, detail)
  }
  return data as T
}
