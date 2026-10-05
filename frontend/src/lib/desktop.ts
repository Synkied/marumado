import { logIn } from './api'

/** The desktop app (desktop/, Tauri) opens this same frontend from Marumado's address, in a window of its own. Only
    there does the page get the app's extras: the agents' card (#/card), logging in with the token the app keeps, and
    the app's own notifications. Links to Marumado's pages stay in the app's window and others open in the browser,
    which the app sees to by itself. */
type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }

const internals = (window as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__

export const inDesktop = !!internals

/** Calls one of the app's commands (desktop/src-tauri/src/main.rs). */
export function desktop<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return internals ? (internals.invoke(cmd, args) as Promise<T>) : Promise.reject(new Error('Not in the desktop app.'))
}

let tried = false

/** Logs this window in with the access token the app was given (POST /api/auth), once per page load: resolves
    whether it worked. A refused token leaves the usual login form. */
export async function desktopLogIn(): Promise<boolean> {
  if (!inDesktop || tried) return false
  tried = true
  try {
    await logIn(await desktop<string>('login_token'))
    return true
  } catch {
    return false
  }
}
