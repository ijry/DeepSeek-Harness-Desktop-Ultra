/**
 * Where the panel's own backend lives.
 *
 * The app is served from `<origin>/dsh-plugin-ai-switch/app/` and its host half
 * answers on `<origin>/dsh-plugin-ai-switch/api/<command>`. The bare `/api/` prefix
 * the reference app uses is NOT available: on this origin it belongs to dsh itself
 * (`/api/host.pickDirectory` and friends), and stealing it would break the shell.
 *
 * Derived from the document URL rather than hardcoded so a future mount point change
 * needs no rebuild: everything up to and including the plugin id is the base.
 */
const PLUGIN_ID = 'dsh-plugin-ai-switch'

function resolveBase(): string {
  if (typeof window === 'undefined') {
    return `/${PLUGIN_ID}`
  }
  const { origin, pathname } = window.location
  const marker = `/${PLUGIN_ID}/`
  const index = pathname.indexOf(marker)
  if (index === -1) {
    // Served from somewhere unexpected (a dev server, a copied build): fall back to
    // the conventional mount so the panel still finds its host.
    return `${origin}/${PLUGIN_ID}`
  }
  return `${origin}${pathname.slice(0, index)}/${PLUGIN_ID}`
}

/** `http://127.0.0.1:<port>/dsh-plugin-ai-switch` — no trailing slash. */
export const PANEL_BASE_URL: string = resolveBase()

/** POST one command and unwrap it the way the reference's web transport does. */
export async function panelCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${PANEL_BASE_URL}/api/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message ?? '')
        : String(payload ?? `HTTP ${response.status}`)
    throw new Error(message.length > 0 ? message : `HTTP ${response.status}`)
  }
  return payload as T
}
