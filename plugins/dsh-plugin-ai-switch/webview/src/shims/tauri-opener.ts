/**
 * `@tauri-apps/plugin-opener` stand-in: hand the URL to the browser.
 *
 * The reference app only routes through the opener plugin when `isDesktop()` is true,
 * which it never is here, so this is import glue with a working implementation behind
 * it rather than a throw — a panel that someday calls it should still open the link.
 */
export async function openUrl(url: string, _openWith?: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function openPath(path: string): Promise<void> {
  throw new Error(`Opening host paths is not available in the dsh panel: ${path}`)
}

export async function revealItemInDir(path: string): Promise<void> {
  throw new Error(`Revealing host paths is not available in the dsh panel: ${path}`)
}
