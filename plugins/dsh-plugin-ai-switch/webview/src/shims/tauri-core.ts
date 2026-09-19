/**
 * `@tauri-apps/api/core` stand-in.
 *
 * The reference app reaches for `invoke` in exactly one place: an auto-hide rule for
 * the accounts toolbar that needs the desktop window's position on screen. That call
 * site is already guarded by `isTauriRuntime()`, which is false in the panel, so this
 * exists to satisfy the import and to fail loudly if anything else ever calls it.
 *
 * Everything that actually matters goes through the transport (`POST
 * /dsh-plugin-ai-switch/api/<command>`), not through Tauri IPC.
 */
export async function invoke<T>(command: string, _args?: unknown): Promise<T> {
  throw new Error(`Tauri IPC is not available in the dsh panel (invoke: ${command})`)
}

export const convertFileSrc = (path: string) => path
