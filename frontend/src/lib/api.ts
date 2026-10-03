export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Older versions kept the token in this browser; the login is now an HttpOnly cookie.
try {
  localStorage.removeItem('marumado.token')
} catch {
  /* nothing stored */
}

export type MachineId = 'local' | number

let machine: MachineId = 'local'

/** Which machine the machine modules (Machine, Processes, Ports, Docker) answer for. Other machines are reached
    through this Marumado (`/api/machines/<id>/…`). */
export function setApiMachine(id: MachineId) {
  machine = id
}

/** What a machine has, as opposed to what you have: these follow the machine picker. Everything else (projects,
    tasks, agents, skills, URLs, the login, the list of machines) belongs to this Marumado, the hub you opened. */
const MACHINE_PATHS = ['system', 'processes', 'ports', 'docker']

export const followsMachine = (path: string) => MACHINE_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))

/** `path` as seen from the chosen machine, for the machine paths; as this Marumado's for the rest. */
export function apiPath(path: string): string {
  return machine === 'local' || !followsMachine(path) ? path : `machines/${machine}/${path}`
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  // Proves the request comes from Marumado's own pages (see backend core/auth.py).
  headers.set('X-Marumado', '1')
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

/** Trade the access token for this browser's login cookie. */
export function logIn(token: string): Promise<void> {
  return api('auth', { method: 'POST', json: { token } })
}

export async function logOut() {
  await api('auth', { method: 'DELETE' }).catch(() => undefined)
  window.location.reload()
}
