/**
 * The write half of the API: everything that changes a stored record, opens or
 * feeds a terminal, moves bytes, binds a socket or launches a client.
 *
 * Every handler follows the same three steps — validate the body through
 * `shared/protocol.js`, call one engine method, write the envelope — so the
 * validation is never "further up" in a caller that might not have run.
 *
 * @module dsh-plugin-otools-term/host/actions
 */
import {
  AI_KINDS,
  decodeInput,
  ERR,
  normalizeEnum,
  normalizeFlag,
  normalizeId,
  normalizeMode,
  normalizePort,
  normalizePortForwardRule,
  normalizeRemotePath,
  normalizeSecret,
  normalizeSize,
  normalizeSocks5,
  normalizeText,
  optionalRemotePath,
  optionalText,
  TermError,
} from '../shared/protocol.js'
import { launchDesktop } from './desktop.js'
import { ok } from './http.js'
import { importSshConfig } from './sshconfig.js'
import { downloadTree, uploadTree } from './transfer.js'

/** Build the POST dispatcher. */
export function registerActionRoutes(options) {
  const { engine } = options

  /** The server id a body names. */
  const serverIdOf = (body) => normalizeId(body.serverId, 'serverId')

  /** The session id a body names. */
  const sessionIdOf = (body) => normalizeId(body.sessionId, 'sessionId')

  const handlePost = async (req, res, route, body) => {
    // ------------------------------------------------------------- ledger
    if (route === '/servers/save') {
      const server = await engine.store.saveServer(body.server ?? body)
      // Secrets travel in the same request as the record that needs them, so a new
      // connection is one round trip; they are split apart here and never stored
      // together.
      const secrets = body.secrets
      if (secrets !== undefined && secrets !== null && typeof secrets === 'object') {
        await engine.secrets.set(server.id, {
          password: normalizeSecret(secrets.password, 'password') ?? (secrets.password === null ? null : undefined),
          passphrase: normalizeSecret(secrets.passphrase, 'passphrase') ?? (secrets.passphrase === null ? null : undefined),
          privateKeyBody: normalizeSecret(secrets.privateKeyBody, 'privateKeyBody') ?? (secrets.privateKeyBody === null ? null : undefined),
        })
      }
      // An edited record must not keep serving the old credentials from a live
      // connection, so the shared client is dropped; the next use reconnects.
      if (engine.pool.peek(server.id) !== undefined && normalizeFlag(body.reconnect) === true) {
        await engine.disconnect(server.id)
      }
      ok(res, { server: { ...server, ...engine.secrets.presence(server.id) } })
      return true
    }
    if (route === '/servers/delete') {
      const serverId = serverIdOf(body)
      await engine.disconnect(serverId)
      await engine.secrets.remove(serverId)
      await engine.store.removeServer(serverId)
      ok(res, { serverId })
      return true
    }
    if (route === '/servers/secret') {
      const serverId = serverIdOf(body)
      await engine.store.load()
      engine.store.requireServer(serverId)
      const presence = await engine.secrets.set(serverId, {
        password: Object.hasOwn(body, 'password') ? (body.password === null ? null : normalizeSecret(body.password, 'password')) : undefined,
        passphrase: Object.hasOwn(body, 'passphrase') ? (body.passphrase === null ? null : normalizeSecret(body.passphrase, 'passphrase')) : undefined,
        privateKeyBody: Object.hasOwn(body, 'privateKeyBody') ? (body.privateKeyBody === null ? null : normalizeSecret(body.privateKeyBody, 'privateKeyBody')) : undefined,
      })
      ok(res, { serverId, ...presence })
      return true
    }
    if (route === '/servers/import-ssh-config') {
      ok(res, await importSshConfig(optionalText(body.file, 'file', 4096)))
      return true
    }
    if (route === '/prefs') {
      ok(res, { prefs: await engine.store.savePrefs(body.prefs ?? body) })
      return true
    }
    if (route === '/commands') {
      ok(res, { favoriteCommands: await engine.store.saveCommands(body.commands) })
      return true
    }
    if (route === '/favorites') {
      const serverId = serverIdOf(body)
      ok(res, { serverId, paths: await engine.store.saveFavoriteDirs(serverId, body.paths) })
      return true
    }
    if (route === '/workspace') {
      ok(res, { workspace: await engine.store.saveWorkspace(body.workspace ?? null) })
      return true
    }

    // -------------------------------------------------------- connections
    if (route === '/connection/connect') {
      ok(res, await engine.connect(serverIdOf(body)))
      return true
    }
    if (route === '/connection/disconnect') {
      ok(res, await engine.disconnect(serverIdOf(body)))
      return true
    }
    if (route === '/connection/host-key/accept') {
      ok(res, await engine.acceptHostKey(
        serverIdOf(body),
        normalizeText(body.fingerprint, 'fingerprint', 200),
        optionalText(body.keyType, 'keyType', 60),
      ))
      return true
    }
    if (route === '/connection/host-key/forget') {
      ok(res, await engine.forgetHostKey(normalizeText(body.host, 'host', 255), normalizePort(body.port, 'port', 22)))
      return true
    }

    // ----------------------------------------------------------- terminals
    if (route === '/terminal/open') {
      const size = normalizeSize(body)
      ok(res, await engine.openTerminal({
        sessionId: sessionIdOf(body),
        serverId: serverIdOf(body),
        cols: size.cols,
        rows: size.rows,
        cwd: optionalText(body.cwd, 'cwd', 4096),
        initialCommand: optionalText(body.initialCommand, 'initialCommand', 4096),
      }))
      return true
    }
    if (route === '/terminal/input') {
      engine.sessions.write(sessionIdOf(body), decodeInput(body.data))
      ok(res, { ok: true })
      return true
    }
    if (route === '/terminal/resize') {
      const size = normalizeSize(body)
      ok(res, engine.sessions.resize(sessionIdOf(body), size.cols, size.rows))
      return true
    }
    if (route === '/terminal/close') {
      ok(res, { closed: engine.sessions.close(sessionIdOf(body)) })
      return true
    }
    if (route === '/terminal/subscribe') {
      const clientId = normalizeId(body.clientId, 'clientId')
      const ids = Array.isArray(body.sessionIds) ? body.sessionIds.slice(0, 64).map((id) => normalizeId(id, 'sessionId')) : []
      ok(res, { subscribed: engine.hub.subscribe(clientId, ids), sessionIds: ids })
      return true
    }

    // ---------------------------------------------------------------- sftp
    if (route === '/sftp/mkdir') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      ok(res, { path: await sftp.mkdir(normalizeRemotePath(body.path)) })
      return true
    }
    if (route === '/sftp/create-file') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      ok(res, { path: await sftp.createFile(normalizeRemotePath(body.path)) })
      return true
    }
    if (route === '/sftp/rename') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      ok(res, await sftp.rename(normalizeRemotePath(body.from, 'from'), normalizeRemotePath(body.to, 'to')))
      return true
    }
    if (route === '/sftp/delete') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      ok(res, await sftp.remove(normalizeRemotePath(body.path)))
      return true
    }
    if (route === '/sftp/chmod') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      ok(res, await sftp.chmod(normalizeRemotePath(body.path), normalizeMode(body.mode)))
      return true
    }
    if (route === '/sftp/write') {
      const sftp = await engine.sftpOf(serverIdOf(body))
      if (typeof body.content !== 'string') throw new TermError(ERR.invalidInput, 'content must be a string')
      ok(res, await sftp.writeFile(normalizeRemotePath(body.path), body.content))
      return true
    }

    // ------------------------------------------------------------ transfers
    if (route === '/transfer/upload-workspace') {
      const serverId = serverIdOf(body)
      const sftp = await engine.sftpOf(serverId)
      const local = await engine.localPaths.resolveExisting(body)
      const remoteDir = normalizeRemotePath(body.remoteDir, 'remoteDir')
      const task = engine.transfers.create({ kind: 'upload', serverId, source: local.path, target: remoteDir })
      // Started, not awaited: a recursive upload can run for minutes and the panel
      // follows it on the event stream.
      void uploadTree({ sftp, registry: engine.transfers, task, localPath: local.path, remoteDir })
        .catch((error) => console.warn('[dsh-plugin-otools-term] upload failed:', error?.message ?? error))
      ok(res, task.describe())
      return true
    }
    if (route === '/transfer/download-workspace') {
      const serverId = serverIdOf(body)
      const sftp = await engine.sftpOf(serverId)
      const local = await engine.localPaths.resolveTargetDirectory({ workspaceId: body.workspaceId, relative: body.relative })
      const remotePath = normalizeRemotePath(body.path)
      const task = engine.transfers.create({ kind: 'download', serverId, source: remotePath, target: local.path })
      void downloadTree({ sftp, registry: engine.transfers, task, remotePath, localDir: local.path })
        .catch((error) => console.warn('[dsh-plugin-otools-term] download failed:', error?.message ?? error))
      ok(res, task.describe())
      return true
    }
    if (route === '/transfer/cancel') {
      ok(res, engine.transfers.cancel(normalizeId(body.taskId, 'taskId')))
      return true
    }
    if (route === '/transfer/clear') {
      ok(res, { tasks: engine.transfers.clearFinished() })
      return true
    }

    // -------------------------------------------------------------- tunnels
    if (route === '/tunnel/forward/start') {
      const serverId = serverIdOf(body)
      const server = await engine.sshServerOf(serverId)
      const rule = normalizePortForwardRule(body.rule)
      const runtime = await engine.tunnels.startForward(server, rule)
      // Remember it as enabled so the next dsh start brings it back up.
      await engine.store.saveForwarding(serverId, {
        portForwards: mergeRule(server.portForwards, { ...rule, enabled: true }),
      })
      ok(res, runtime)
      return true
    }
    if (route === '/tunnel/forward/stop') {
      const serverId = serverIdOf(body)
      const ruleId = normalizeId(body.ruleId, 'ruleId')
      const stopped = engine.tunnels.stopForward(serverId, ruleId)
      const server = await engine.sshServerOf(serverId)
      await engine.store.saveForwarding(serverId, {
        portForwards: server.portForwards.map((row) => (row.id === ruleId ? { ...row, enabled: false } : row)),
      })
      ok(res, { serverId, ruleId, stopped })
      return true
    }
    if (route === '/tunnel/forward/save') {
      const serverId = serverIdOf(body)
      const rules = Array.isArray(body.rules) ? body.rules.map((row) => normalizePortForwardRule(row)) : []
      ok(res, { server: await engine.store.saveForwarding(serverId, { portForwards: rules }) })
      return true
    }
    if (route === '/tunnel/forward/delete') {
      const serverId = serverIdOf(body)
      const ruleId = normalizeId(body.ruleId, 'ruleId')
      engine.tunnels.stopForward(serverId, ruleId)
      const server = await engine.sshServerOf(serverId)
      ok(res, {
        server: await engine.store.saveForwarding(serverId, {
          portForwards: server.portForwards.filter((row) => row.id !== ruleId),
        }),
      })
      return true
    }
    if (route === '/tunnel/socks/start') {
      const serverId = serverIdOf(body)
      const server = await engine.sshServerOf(serverId)
      const proxy = normalizeSocks5(body.proxy)
      const runtime = await engine.tunnels.startSocks(server, proxy)
      await engine.store.saveForwarding(serverId, { socks5Proxy: { ...proxy, enabled: true } })
      ok(res, runtime)
      return true
    }
    if (route === '/tunnel/socks/stop') {
      const serverId = serverIdOf(body)
      const stopped = engine.tunnels.stopSocks(serverId)
      const server = await engine.sshServerOf(serverId)
      await engine.store.saveForwarding(serverId, { socks5Proxy: { ...server.socks5Proxy, enabled: false } })
      ok(res, { serverId, stopped })
      return true
    }
    if (route === '/tunnel/server/stop') {
      const serverId = serverIdOf(body)
      ok(res, { serverId, stopped: engine.tunnels.stopServer(serverId) })
      return true
    }

    // -------------------------------------------------------------- desktop
    if (route === '/desktop/launch') {
      const server = await engine.serverOf(serverIdOf(body))
      await engine.secrets.load()
      const sendPassword = normalizeFlag(body.sendPassword)
      ok(res, await launchDesktop(server, {
        sendPassword,
        password: sendPassword ? engine.secrets.get(server.id, 'password') : undefined,
      }))
      return true
    }

    // ------------------------------------------------------------------- ai
    if (route === '/ai/start') {
      const kind = normalizeEnum(body.kind, AI_KINDS, 'kind')
      const sessionId = body.sessionId === undefined || body.sessionId === null || body.sessionId === ''
        ? undefined
        : normalizeId(body.sessionId, 'sessionId')
      const context = sessionId === undefined ? { facts: {}, transcript: '', cwd: undefined } : engine.aiContextOf(sessionId)
      const ask = kind === 'command'
        ? normalizeText(body.ask, 'ask', 2_000)
        : (optionalText(body.ask, 'ask', 2_000) ?? '')
      ok(res, engine.jobs.start({
        kind,
        sessionId,
        ask,
        language: body.language === 'en' ? 'en' : 'zh',
        facts: context.facts,
        transcript: kind === 'explain' || normalizeFlag(body.withContext) ? context.transcript : '',
        cwd: optionalRemotePath(body.cwd, 'cwd') ?? context.cwd,
      }))
      return true
    }
    if (route === '/ai/cancel') {
      ok(res, engine.jobs.cancel(normalizeId(body.jobId, 'jobId')))
      return true
    }

    return false
  }

  return { handlePost }
}

/** Replace one rule in a list by id, appending when it is new. */
function mergeRule(rules, rule) {
  const index = rules.findIndex((row) => row.id === rule.id)
  if (index === -1) return [...rules, rule]
  const next = [...rules]
  next[index] = rule
  return next
}
