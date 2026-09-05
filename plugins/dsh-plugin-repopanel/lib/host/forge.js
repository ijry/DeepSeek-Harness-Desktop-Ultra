/**
 * Provider dispatch: turn a resolved remote plus a token into one forge client.
 *
 * The client face is deliberately narrow and provider-agnostic (identity /
 * labels / list / count / item / comments / addComment / setState /
 * createIssue), so adding GitLab is one more module implementing the same face
 * and one more row in the switch below — not a change to the routes or the
 * browser half.
 *
 * @module dsh-plugin-repopanel/host/forge
 */
import { ERR, PanelError } from '../shared/protocol.js'
import { githubClient } from './github.js'

/** Providers this build can actually talk to. */
export const IMPLEMENTED_PROVIDERS = ['github']

/**
 * Build the client for a remote.
 *
 * @param remote - a resolved ForgeRemote (`{ host, ownerRepo, provider }`).
 * @param token - the resolved access token, or undefined for anonymous reads.
 * @param fetchImpl - injected only so tests can drive the routes without a
 *   network; production callers leave it undefined.
 */
export function forgeClient(remote, token, fetchImpl) {
  switch (remote.provider) {
    case 'github':
      return githubClient({ host: remote.host, ownerRepo: remote.ownerRepo, token, fetchImpl })
    case 'gitlab':
      // Deferred, not forgotten: the face above is what a gitlab.js has to
      // implement. Reported as unsupported rather than silently listing nothing.
      throw new PanelError(
        ERR.unsupportedHost,
        `GitLab (${remote.host}) is not supported by this build yet`,
      )
    default:
      throw new PanelError(
        ERR.unsupportedHost,
        `${remote.host} is not a recognized code-hosting service`,
      )
  }
}
