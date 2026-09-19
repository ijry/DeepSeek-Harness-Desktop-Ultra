/**
 * `@tauri-apps/plugin-process` stand-in.
 *
 * Relaunching is only ever offered after an installer ran, which cannot happen here:
 * the panel is upgraded by `dsh plugin add`, and restarting anything is the shell's
 * business. Reload the browser tab instead of pretending to restart a process.
 */
export async function relaunch(): Promise<void> {
  throw new Error('Restarting is handled by dsh; reload the page after updating the plugin')
}

export async function exit(_code?: number): Promise<void> {
  throw new Error('Exiting is handled by dsh, not by the AI Switch panel')
}
