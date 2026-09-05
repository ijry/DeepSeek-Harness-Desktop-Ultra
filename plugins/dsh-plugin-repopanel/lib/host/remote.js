/**
 * Resolve a workspace directory into forge coordinates by reading its `origin`
 * remote. The panel never stores which repository a workspace belongs to — the
 * remote IS the answer, so a user who re-points origin sees the new repository
 * on the next read with nothing to migrate and nothing to invalidate.
 *
 * git is spawned through execFile, never exec: a workspace path can contain
 * spaces, quotes or `&`, and a shell would either misparse it or run it.
 *
 * @module dsh-plugin-repopanel/host/remote
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROVIDER_IDS, parseRemoteUrl, redactUserinfo } from '../shared/protocol.js'

const run = promisify(execFile)

/** How long `git remote get-url` may run before it counts as "no remote". */
export const GIT_TIMEOUT_MS = 5000

/**
 * The provider serving a host, or undefined when it is neither forge. Matching
 * is on whole dot-separated labels, so `github.com`, an Enterprise
 * `github.acme.com` and a nested `code.github.acme.com` all resolve, while a
 * look-alike such as `mygithub.com` does not. The labels ARE the provider ids,
 * so the vocabulary stays in the shared protocol.
 */
export function providerForHost(host) {
  const labels = String(host ?? '').trim().toLowerCase().split('.')
  return PROVIDER_IDS.find((provider) => labels.includes(provider))
}

/**
 * The forge coordinates of a workspace directory:
 * `{ host, ownerRepo, remoteUrl, provider, supported }`, or undefined when the
 * folder has no usable `origin`. `provider` is undefined for a host this plugin
 * cannot talk to and `supported` says so, so a caller never has to know the
 * provider list itself.
 *
 * A folder with no origin — or no git at all — is a NORMAL state the panel
 * reports as "no remote", so every failure mode here answers undefined instead
 * of throwing.
 */
export async function resolveRemote(path) {
  if (typeof path !== 'string' || path.trim().length === 0) return undefined
  let stdout
  try {
    // windowsHide keeps a console window from flashing over the desktop shell.
    const result = await run('git', ['-C', path, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    stdout = result.stdout
  } catch {
    // A non-zero exit (no origin, not a repository), a spawn failure (no git on
    // PATH) and the timeout all mean the same thing to the panel.
    return undefined
  }
  const parsed = parseRemoteUrl(stdout)
  if (parsed === undefined) return undefined
  const provider = providerForHost(parsed.host)
  return {
    host: parsed.host,
    ownerRepo: parsed.ownerRepo,
    // Redacted: this value is displayed in the browser, and a remote can carry
    // `user:token@` from whatever configured it.
    remoteUrl: redactUserinfo(stdout.trim()),
    provider,
    supported: provider !== undefined,
  }
}
