/**
 * The one seam between the phone and dsh, and deliberately the narrowest part of
 * this package.
 *
 * dsh's `/api` surface has a loopback fence in front of it precisely because
 * some of its methods are dangerous over a network: `host.pickDirectory` and
 * `host.openPath` drive the desktop, `settings.*` and `credentials.*` are the
 * configuration plane, and `agentPreset.read` is reconnaissance on what a
 * session runs. Upstream pins those to loopback "until a real authentication
 * layer exists".
 *
 * This bridge is that authentication layer for a *subset*, and the subset is
 * enforced by construction rather than by a filter: the functions below are the
 * only calls that exist. There is no generic `invoke(method, payload)` here and
 * there must never be one — a passthrough would re-expose everything the fence
 * was protecting, with a token in front of it, which is not the same thing.
 *
 * @module dsh-plugin-mobile-bridge/host/bridge
 */
import { randomUUID } from 'node:crypto'

import { BridgeError, ERR } from '../shared/protocol.js'
import { pick } from '../shared/lang.js'

/** Mint one RPC correlation id. dsh requires it on every request envelope. */
function rpcId() {
  return randomUUID()
}

/**
 * Unwrap an `RpcResponse`. A business failure becomes a {@link BridgeError} whose
 * `dshCode` carries dsh's own code, so the phone can branch on the real cause
 * (`session-not-found`, `agent-busy`, `model-unavailable`) instead of a string.
 */
function unwrap(response) {
  const result = response?.result
  if (result?.ok === true) return result.value
  const error = result?.error ?? { code: 'internal', message: pick('dsh 未返回结果', 'dsh returned no result') }
  throw new BridgeError(ERR.dshError, String(error.message ?? error.code), {
    dshCode: String(error.code ?? 'internal'),
    details: error.details ?? {},
  })
}

/**
 * The allowlisted dsh surface, bound to one `ctx.apiProxy`.
 *
 * @param {object} apiProxy - `ctx.apiProxy` from the host context.
 * @returns {object} the allowlisted calls.
 */
export function createBridge(apiProxy) {
  if (apiProxy === undefined || apiProxy === null) {
    throw new BridgeError(
      ERR.unavailable,
      pick(
        '当前 dsh 组合没有 apiProxy，手机桥无法工作',
        'This dsh composition has no apiProxy, so the mobile bridge cannot work',
      ),
    )
  }

  return {
    /** `host.describe` — version, cwd, attached session count. No paths beyond cwd/home. */
    async describe() {
      return unwrap(await apiProxy.host.describe({ rpcId: rpcId(), payload: {} }))
    },

    /** `session.list` — every persisted session, newest first. */
    async listSessions() {
      return unwrap(await apiProxy.sessions.list({ rpcId: rpcId(), payload: {} }))
    },

    /** `session.search` — content search across sessions. */
    async searchSessions(query, signal) {
      return unwrap(await apiProxy.sessions.search({ rpcId: rpcId(), payload: { query } }, signal))
    },

    /** `session.create` — a real session plus its idle agent. */
    async createSession(payload) {
      return unwrap(await apiProxy.sessions.create({ rpcId: rpcId(), payload }))
    },

    /** `session.history` — one page of raw events, message-boundary aligned. */
    async history(payload) {
      return unwrap(await apiProxy.sessions.history({ rpcId: rpcId(), payload }))
    },

    /** `session.prompt` — send text (and images) to the agent. */
    async prompt(payload) {
      return unwrap(await apiProxy.sessions.prompt({ rpcId: rpcId(), payload }))
    },

    /** `session.cancel` — stop the active turn, keeping queued work. */
    async cancel(sessionId) {
      return unwrap(await apiProxy.sessions.cancel({ rpcId: rpcId(), payload: { sessionId } }))
    },

    /** `session.rename` — pin a title against automatic regeneration. */
    async rename(sessionId, title) {
      return unwrap(await apiProxy.sessions.rename({ rpcId: rpcId(), payload: { sessionId, title } }))
    },

    /** `session.models` — the advisory model directory for one session. */
    async models(sessionId) {
      return unwrap(await apiProxy.sessions.models({ rpcId: rpcId(), payload: { sessionId } }))
    },

    /** `session.selectModel` — switch this session's model. */
    async selectModel(payload) {
      return unwrap(await apiProxy.sessions.selectModel({ rpcId: rpcId(), payload }))
    },

    /** `workspace.list` — projects, so a new session can start in one. */
    async listWorkspaces() {
      return unwrap(await apiProxy.workspace.list({ rpcId: rpcId(), payload: {} }))
    },

    /** `events.mux` — the all-session stream. Ends when `signal` aborts. */
    muxStream(signal) {
      return apiProxy.events.mux({ rpcId: rpcId(), payload: {} }, signal)
    },

    /** `events.host` — session lifecycle and running-status flips. */
    hostStream(signal) {
      return apiProxy.events.host({ rpcId: rpcId(), payload: {} }, signal)
    },

    /**
     * Answer one answerable server request (an approval or a question).
     *
     * The `requestId` is dsh's own `rpcId` for that interaction, echoed back
     * verbatim: minting a new one here would silently orphan the answer, and dsh
     * would keep waiting. `accepted: false` with `not-pending` is the normal
     * outcome of two clients racing to answer, not an error to retry.
     */
    async respond(requestId, value) {
      const receipt = await apiProxy.respond({
        type: 'client-response',
        rpcId: requestId,
        result: { ok: true, value },
      })
      if (receipt?.accepted === true) return { accepted: true }
      const reason = String(receipt?.reason ?? 'not-pending')
      throw new BridgeError(
        reason === 'bad-response' ? ERR.invalidInput : ERR.notFound,
        reason === 'bad-response'
          ? pick('回答不符合待答请求的格式', 'The answer does not match the shape of the pending request')
          : pick('这个请求已经被回答或已失效', 'This request has already been answered or is no longer pending'),
        { reason },
      )
    },
  }
}
