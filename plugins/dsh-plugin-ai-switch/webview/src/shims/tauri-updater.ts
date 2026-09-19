/**
 * `@tauri-apps/plugin-updater` stand-in.
 *
 * The plugin is versioned and upgraded by dsh (`dsh plugin --profile web add
 * dsh-plugin-ai-switch@<version>`), so there is no signed-bundle updater to consult.
 *
 * `check()` REJECTS rather than resolving `null`: resolving null would make the
 * Updates screen announce "you are on the latest version", which this code has no way
 * to know. A named error puts the real answer on screen instead.
 */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export type Update = {
  version: string
  currentVersion: string
  date?: string
  body?: string
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>
}

export async function check(): Promise<Update | null> {
  throw new Error('Plugin updates come from dsh: run `dsh plugin --profile web add dsh-plugin-ai-switch@latest`')
}
