/**
 * `@tauri-apps/api/event` stand-in.
 *
 * Only the desktop transport used this module, and the panel never loads that
 * transport: events reach the browser over the panel's own WebSocket
 * (`/dsh-plugin-ai-switch/ws/events`), through `Transport.subscribe`. The shim keeps
 * the module resolvable and the listeners inert.
 */
export type UnlistenFn = () => void

export type Event<T> = {
  event: string
  id: number
  payload: T
}

export async function listen<T>(
  _event: string,
  _handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return () => {}
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}
