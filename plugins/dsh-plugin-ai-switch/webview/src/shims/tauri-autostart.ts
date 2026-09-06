/**
 * `@tauri-apps/plugin-autostart` stand-in.
 *
 * "Start with the system" belongs to a desktop application, not to a panel inside
 * dsh's web GUI — if you want the switch running at login, that is dsh's own
 * autostart. The settings section that calls these is gated on `isDesktop()` and so
 * never renders here; the throw is for anything that gets past that.
 */
const message = 'Autostart is managed by dsh, not by the AI Switch panel'

export async function isEnabled(): Promise<boolean> {
  return false
}

export async function enable(): Promise<void> {
  throw new Error(message)
}

export async function disable(): Promise<void> {
  throw new Error(message)
}
