# DSH Shared Bus Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and execute this plan inline task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build hidden `dsh-plugin-otools-socket`, migrate desktop events onto one shared connection with fallback, replace mobile-bridge v1 with bus v2, and connect MCode through one DSH connection and a safe declarative renderer.

**Architecture:** The socket plugin owns loopback and opt-in external carriers, device identity, catalog, requests and transfer tickets. Plugins register optional Cordis sources; browser and MCode each keep one control connection, while large payloads use temporary channels. Mobile-bridge becomes an admin/session adapter.

**Tech Stack:** Node.js 22 ESM, Cordis, `node:http`, RFC 6455, `node:test`, Tauri/Rust, Vue 3, TypeScript, uni-app, Jest.

**Spec:** `docs/superpowers/specs/2026-09-07-otools-socket-shared-bus-design.md`

## Global Constraints

- Two independent repositories: `dsh-desktop-ultra` and `mcode`; commit each independently.
- Published DSH plugin tarballs stay self-contained; no shared npm runtime dependency or runtime `@deepseek-ai/*` import.
- Shared source lives under `plugins/.shared/`, is copied by `npm run sync:shared`, and is guarded by root drift tests.
- Internal prefix: `/dsh-plugin-otools-socket`; external server exposes only v2 hello/pair/refresh/socket/transfer paths.
- External listening defaults off; enabled default is `0.0.0.0:8790`.
- Bus envelope v2; declarative UI v1; every source has an independent `protocolVersion`.
- Exposure defaults to `internal`; only explicit `paired` sources enter MCode catalog.
- Limits: 256 KiB control frame, 512 KiB catalog UI, 1 MiB per-client control backlog.
- Requests time out at 30 seconds; five failures in 60 seconds open a 30-second per-client/source circuit.
- Pair offers expire in 30 minutes; access tokens in 24 hours; rotating refresh tokens in 90 days.
- Host stores token hashes only; tokens never appear in URL, catalog or logs.
- Transfer tickets are device-bound, one-use, and must start in 60 seconds; revocation kills tickets and sockets.
- Do not migrate `dsh-plugin-mobile-bridge.json` and do not retain `/dsh-mobile-bridge` v1.
- Never execute plugin-provided HTML, JavaScript, expressions or custom renderer code.
- Canvas remains internal and has no MCode page.
- App supports LAN and tunnel; H5 guarantees HTTPS/WSS; mini-programs require approved HTTPS/WSS domains.
- Preserve fallback: shared bus → plugin WebSocket → SSE.
- Every task that changes MCode code or tests also creates a runtime-timestamped note under `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/` in the same commit. Use suffixes: Task 1 `dsh-bus-v2-artifacts`, Task 9 `dsh-bus-v2-transport`, Task 10 `dsh-declarative-plugin-ui`; include protocol/data flow, UI behavior, compatibility, and Android/iOS replication guidance.
- TDD every task: failing focused test, minimal implementation, affected suites, focused commit.

## Wire and source contracts consumed by all three batches

These are planned interfaces to implement, not existing exports. Define them in Task 1 schemas and Task 3 service tests before adapting plugins.

```ts
type Confirmation = 'none' | 'confirm' | 'danger'
interface SourceCommand {
  name: string
  effect: 'read' | 'write'
  confirmation: Confirmation
  input: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false }
}
interface SourceCatalog {
  title: string
  commands: SourceCommand[]
  uiVersion?: 1
  pages?: unknown[]
}
interface SourceRequest { name: string; data: unknown }
interface RequestFrame {
  v: 2; kind: 'request'; source: string; requestId: string; name: string; data: unknown
}
type ResponseFrame =
  | { v: 2; kind: 'response'; source: string; requestId: string; ok: true; data: unknown }
  | { v: 2; kind: 'response'; source: string; requestId: string; ok: false;
      error: { code: string; message: string } }
interface EventFrame { v: 2; kind: 'event'; source: string; name: string; data: unknown }
```

- `catalogFor(transport)` returns source descriptors ordered lexicographically by source ID; revision is a monotonically increasing safe integer for the current process and increments only after successful register/update/dispose. Clients treat it as opaque and do not require continuity across host restarts. `hello` includes a new `serverInstanceId` (UUID per host process); reconnect with a changed instance always discards catalog assembly and source snapshots.
- Subscribe is `{v:2,kind:'subscribe',source}`; unsubscribe has the same shape with its own kind. Baseline is an event with reserved `name:'$snapshot'`; plugin-authored event names starting `$` are rejected. `hello` is connection-level only. On overflow unsubscribe/resubscribe obtains a fresh baseline.
- Request IDs are nonempty strings of at most 128 characters, unique among a connection's pending requests. Reuse while pending is `bad_frame`. Cancel is `{v:2,kind:'cancel',source,requestId}` and only affects that connection's matching request; cancellation of an already settled request is a no-op.
- MCode `request(source,name,data)` resolves only `response.data` on success and rejects a typed error on `ok:false`; plugin `onRequest()` returns business data, never an envelope. The bus owns correlation and error wrapping.
- Unknown command names return `not_found`; unpaired/hidden sources return `forbidden` without catalog details. The complete stable error set is fixed in Task 1 artifacts.
- The service validates declared inputs before dispatch. The input-schema subset supports object/array/string/number/integer/boolean/null, required/properties/additionalProperties, enum and length/range bounds; no arbitrary `$ref` fetching, regular-expression execution or remote schemas.
- UI action declaration is `{command,confirmation,bindings}`. The effective confirmation is the stricter of the command and UI declaration; unknown/missing write confirmation rejects the action. The developer console uses the same action executor. This is a client UX guarantee, not protection against a malicious paired client or dishonest host plugin.
- Catalog descriptors name capabilities; they never grant authority to call an undeclared command. The bus routes generically, with no plugin-ID switch.

**Service test seam:** `new OtoolsSocketService({now,issueTransfer})` exposes `registerSource`, `catalogFor` (returns `{revision,sources}`), `attachClient({id,transport,deviceId,send})`, `dispatchRequest(client,frame)`, and `dispose`. `attachClient` returns a handle with `dispose`; its `send` receives validated plain frames. `dispatchRequest` returns `Promise<void>` after settlement. Real socket adapters use this same seam.

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { OtoolsSocketService } from '../src/host/service.js'

test('a throwing source does not prevent the next source response', async () => {
  const service = new OtoolsSocketService({ now: () => 0 })
  const catalog = { title: 'Example', commands: [{
    name: 'state/read', effect: 'read', confirmation: 'none',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }] }
  const definitions = [
    { id: 'example.bad', onRequest: () => { throw new Error('SECRET') } },
    { id: 'example.good', onRequest: () => ({ count: 2 }) },
  ]
  const registrations = definitions.map(definition => service.registerSource({
    ...definition, protocolVersion: 1, exposure: 'paired', catalog, hello: () => ({}),
  }))
  const frames = []
  const client = service.attachClient({
    id: 'client-a', transport: 'paired', deviceId: 'phone-a',
    send: frame => { frames.push(frame); return true },
  })
  for (const [index, definition] of definitions.entries()) {
    await service.dispatchRequest(client, {
      v: 2, kind: 'request', source: definition.id,
      requestId: String(index), name: 'state/read', data: {},
    })
  }
  const responses = frames.filter(frame => frame.kind === 'response')
  assert.equal(responses[0].error.code, 'internal')
  assert.equal(JSON.stringify(responses).includes('SECRET'), false)
  assert.deepEqual(responses[1].data, { count: 2 })
  registrations.forEach(registration => registration.dispose())
  client.dispose()
  service.dispose()
})
```

## Execution status

This plan is execution-ready at the task boundary: every task names interfaces, owned files, a failing-test phase, implementation boundary, validation and commit. Snippets are examples to place in the named test files, not execution results. Native-device and end-to-end acceptance remain explicit blocking steps rather than inferred from document/build checks.

---

### Task 1: Freeze the v2 protocol artifacts in both repositories

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/src/shared/protocol.js`
- Create: `plugins/dsh-plugin-otools-socket/src/shared/protocol-artifacts/schemas/dsh-bus-envelope-v2.schema.json`
- Create: `plugins/dsh-plugin-otools-socket/src/shared/protocol-artifacts/schemas/dsh-declarative-ui-v1.schema.json`
- Create: `plugins/dsh-plugin-otools-socket/src/shared/protocol-artifacts/golden/valid/control-frames.json`
- Create: `plugins/dsh-plugin-otools-socket/src/shared/protocol-artifacts/golden/invalid/control-frames.json`
- Create: `plugins/dsh-plugin-otools-socket/test/protocol-artifacts.test.mjs`
- Create: `mcode-app/src/agents/dsh/protocol-artifacts/**` as byte-for-byte mirrors
- Create: `mcode-app/tests/agents/dsh/protocolArtifacts.spec.ts`

**Interfaces:**
- Produces: `BUS_VERSION = 2`, `UI_VERSION = 1`, `CONTROL_FRAME_MAX_BYTES = 262144`, `CATALOG_MAX_BYTES = 524288`, `CLIENT_BACKLOG_MAX_BYTES = 1048576`, `REQUEST_TIMEOUT_MS = 30000`.
- Produces: closed `kind` vocabulary `hello|catalog|subscribe|unsubscribe|event|request|response|cancel|overflow|error` and stable error codes `bad_frame|bad_version|frame_too_large|source_unavailable|not_found|forbidden|unauthorized|rate_limited|timeout|cancelled|circuit_open|ticket_unavailable|invalid_input|conflict|internal`.
- Consumes: no earlier task.

- [ ] **Step 1: Write the desktop artifact tests**

Add table-driven `node:test` cases using `encodeControlFrame(decodeControlFrame(json))` (not the RFC 6455 `encodeFrame`). Test every kind, `serverInstanceId` in hello, request-ID bounds/duplicate-pending rejection, reserved source event names, source/catalog ID patterns, UTF-8 byte limits including the complete JSON envelope, and all stable errors (`bad_frame`, `bad_version`, `frame_too_large`, `source_unavailable`, `not_found`, `forbidden`, `unauthorized`, `rate_limited`, `timeout`, `cancelled`, `circuit_open`, `ticket_unavailable`, `invalid_input`, `conflict`, `internal`).

Catalog transport is application-level chunking, not oversized WebSocket messages. `encodeCatalogFrames({revision,sources})` serializes the complete visible catalog (maximum 524288 UTF-8 bytes), splits bytes into chunks of at most 98304 bytes, and base64url-encodes each chunk. Each ordinary v2 frame is `{v:2,kind:'catalog',revision,index,count,encoding:'base64url',data}` and must remain below 262144 bytes. Maximum count is 6. `createCatalogAssembler()` exposes `accept(frame): catalog|null` and `reset()`. Accept contiguous indices from zero for one revision, enforce aggregate decoded size before concatenating, and parse JSON only after completion; retain the previous catalog until atomic replacement. A newer index-zero revision replaces incomplete assembly; disconnect resets it. Duplicate/out-of-order chunks fail `bad_frame`. Assembly expires after 30 seconds. Add valid/invalid golden chunks in both repositories.

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeControlFrame, encodeCatalogFrames, createCatalogAssembler,
} from '../src/shared/protocol.js'

test('catalog chunks respect wire cap and replace atomically', () => {
  const catalog = { revision: 7, sources: [{
    id: 'example.notes', protocolVersion: 1,
    catalog: { title: '例'.repeat(100000) },
  }] }
  const frames = encodeCatalogFrames(catalog)
  assert.ok(frames.length > 1)
  const assembler = createCatalogAssembler()
  for (const frame of frames.slice(0, -1)) {
    assert.ok(Buffer.byteLength(encodeControlFrame(frame)) <= 262144)
    assert.equal(assembler.accept(frame), null)
  }
  assert.deepEqual(assembler.accept(frames.at(-1)), catalog)
})
```

- [ ] **Step 2: Run the focused desktop test and observe failure**

Run: `node --test plugins/dsh-plugin-otools-socket/test/protocol-artifacts.test.mjs`

Expected: FAIL because the package and protocol artifacts do not exist.

- [ ] **Step 3: Implement the pure protocol module and artifacts**

Implement `decodeControlFrame(raw)` as JSON parse + version/kind/required-field/UTF-8-size validation, `encodeControlFrame(frame)` as validation before serialization, and `validateCatalog(catalog)` with its independent byte cap. Keep the module pure: no Cordis, HTTP, DOM, or storage imports.

- [ ] **Step 4: Mirror artifacts into MCode and write Jest acceptance/rejection tests**

The MCode test must read its local artifact directory only, validate the same valid/invalid cases, and pin all constants. Add an explicit byte-for-byte comparison command to the plan's release checklist rather than importing across repositories at runtime.

- [ ] **Step 5: Run both focused suites**

Run:

```powershell
node --test "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-socket/test/protocol-artifacts.test.mjs"
pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- --runTestsByPath tests/agents/dsh/protocolArtifacts.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit in each repository**

```powershell
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" add plugins/dsh-plugin-otools-socket/src/shared plugins/dsh-plugin-otools-socket/test/protocol-artifacts.test.mjs
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" commit -m "feat(socket): pin shared bus v2 artifacts"
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src/agents/dsh/protocol-artifacts mcode-app/tests/agents/dsh/protocolArtifacts.spec.ts
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "test(dsh): mirror bus v2 protocol artifacts"
```

### Task 2: Split the shared RFC 6455 transport from the event envelope

**Files:**
- Modify: `plugins/.shared/host/socket.js`
- Modify: `scripts/sync-shared.mjs`
- Modify: `scripts/shared-sources.test.mjs`
- Modify: `plugins/dsh-plugin-taskboard/test/socket.test.mjs`
- Modify: `plugins/dsh-plugin-canvas/test/socket.test.mjs`
- Modify: `plugins/dsh-plugin-repopanel/test/socket.test.mjs`
- Modify: `plugins/dsh-plugin-automation/test/socket.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/socket.test.mjs`
- Regenerate: corresponding `src/host/socket.js` and `lib/host/socket.js` copies

**Interfaces:**
- Produces: `createSocketHub(ctx, { path, authorize, onOpen, onMessage, onClose, serialize, maxBacklogBytes })` returning `{ broadcast(payload, filter?), send(client, payload), size(), dispose() }`.
- Preserves: `createEventSocket(ctx, { path, hello })` and its `{ broadcast(event,data), size(), dispose() }` result for existing callers.
- Consumes: transport limits supplied through options by the bus plugin. The canonical shared module must not import from `dsh-plugin-otools-socket` or any sibling package; each published consumer remains self-contained.

- [ ] **Step 1: Extend one canonical socket test with raw-hub cases**

Test handshake authorization success/failure, one JSON payload broadcast, client payload delivery to `onMessage`, close cleanup, ping/pong, overflow rejection, and `onOpen` baseline ordering. Keep existing `createEventSocket` tests unchanged to pin compatibility.

- [ ] **Step 2: Run the five socket suites and observe the new test fail**

Run: `node --test plugins/dsh-plugin-canvas/test/socket.test.mjs`

Expected: FAIL because `createSocketHub` is not exported.

- [ ] **Step 3: Extract the transport and reimplement `createEventSocket` as a wrapper**

Move handshake, frame parsing, connection tracking and ping into `createSocketHub`. The wrapper must provide `serialize: JSON.stringify`, send `{event,data}`, and issue `hello()` from `onOpen`; it must preserve fallback when `registerUpgrade` is absent.

Do not promote the current push-only parser directly into a public command parser. New hub mode validates RFC 6455 version 13 and a decoded 16-byte handshake key; client masking; RSV bits; opcode and fragmentation sequence; control frame FIN/125-byte limit; aggregate message limit; and fatal UTF-8 decoding for JSON text. Process upgrade `head` bytes. Reject malformed frames with 1002, invalid UTF-8 with 1007, excessive messages with 1009. Close/error is idempotent; no hello, timer or callback is created after `head` already closed the connection. Keep existing wrapper compatibility separate from the strict new hub policy.

Add raw-byte tests in `plugins/dsh-plugin-canvas/test/socket.test.mjs` using the existing `fakeCtx`, `FakeSocket`, `upgradeRequest` and `maskedFrame` helpers:

```js
test('hub never calls onOpen after a close frame in upgrade head', () => {
  const ctx = fakeCtx()
  let opened = 0
  const hub = createSocketHub(ctx, {
    path: '/test/socket', authorize: () => true,
    onOpen: () => { opened += 1 }, onMessage() {}, onClose() {},
    serialize: JSON.stringify, maxBacklogBytes: 1048576,
  })
  const socket = new FakeSocket()
  const req = upgradeRequest({ 'sec-websocket-version': '13' })
  ctx.registered.handler(req, socket, maskedFrame('', 0x8))
  assert.equal(opened, 0)
  assert.equal(hub.size(), 0)
  hub.dispose()
})
```

Test unmasked text, fragmented text with interleaved ping, invalid continuation, overlong control payload and aggregate overflow before any business dispatch.

- [ ] **Step 4: Sync and run all affected tests**

Run:

```powershell
npm --prefix "D:/Repos/xyito/open/dsh-desktop-ultra" run sync:shared
$plugins = 'taskboard','canvas','repopanel','automation','otools-git'
foreach ($plugin in $plugins) {
  npm --prefix "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-$plugin" test
}
npm --prefix "D:/Repos/xyito/open/dsh-desktop-ultra" test
```

Expected: all PASS; drift guard reports byte-identical copies.

- [ ] **Step 5: Commit**

```powershell
git add plugins/.shared/host/socket.js scripts/sync-shared.mjs scripts/shared-sources.test.mjs plugins/dsh-plugin-*/src/host/socket.js plugins/dsh-plugin-*/lib/host/socket.js plugins/dsh-plugin-*/test/socket.test.mjs
git commit -m "refactor(socket): separate transport hub from event frames"
```

### Task 3: Implement source registration, catalog and request isolation

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/src/host/service.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/control.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/source.js`
- Create: `plugins/dsh-plugin-otools-socket/test/service.test.mjs`
- Create: `plugins/dsh-plugin-otools-socket/test/control.test.mjs`

**Interfaces:**
- Produces: `OtoolsSocketService.registerSource(definition): { emit(name,data,priority?): void, updateCatalog(catalog): void, dispose(): void }`, `catalogFor('internal'|'paired')`, `dispatchRequest(client,frame)`. `dispose()` is idempotent and Cordis callbacks return `() => registration.dispose()`.
- Source definition: `{ id, protocolVersion, exposure='internal', catalog, hello(context), onRequest(request,context) }`.
- Produces local admin facade (never exported as bus commands): `externalState(): {enabled,listening,host,port,error}`, `setExternalEnabled(enabled): Promise<void>`, `pairingOffer(): {code,secret,expiresAt}`, `listDevices(): DeviceSummary[]`, `renameDevice(deviceId,name): Promise<void>`, `revokeDevice(deviceId): Promise<void>`. Disabled listening does not mint an externally usable offer. DeviceSummary contains ID/name/timestamps/revocation status, never credential hashes or plaintext. Tasks 4–6 supply the facade's store/auth/listener dependencies.
- Request context: `{ transport, deviceId, signal, issueTransfer }`.
- Consumes: Task 1 protocol constants and Task 2 `createSocketHub`.

- [ ] **Step 1: Write failing service tests**

Cover duplicate ID rejection, default-internal exposure, paired filtering, complete catalog replacement/revision through `registration.updateCatalog()`, idempotent `registration.dispose()`, `registration.emit()` tagging the owned source, `hello()` before increments, request/response correlation, `cancel` abort, 30-second timeout with a fake clock, safe error redaction, and one source throwing without affecting another.

- [ ] **Step 2: Add failing circuit-breaker and backlog tests**

Assert five timeout/protocol failures inside 60 seconds return `circuit_open` for 30 seconds only for that `(client,source)` pair. Assert low-priority events are dropped with one `overflow`; responses/catalog are never silently dropped.

- [ ] **Step 3: Run focused tests**

Run: `node --test plugins/dsh-plugin-otools-socket/test/service.test.mjs plugins/dsh-plugin-otools-socket/test/control.test.mjs`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement minimal service and control dispatcher**

Use a `Map` for sources and pending request controllers. `emit` is bound to the registration generation; a disposed handle throws `source_unavailable` and cannot publish through a replacement registration with the same ID. No public publish-by-ID method is exposed. Validate source IDs with `^[a-z0-9][a-z0-9._-]{1,127}$`; clone/validate catalog metadata and increment revision on register/unregister/update. Dispatch only declared command names. Unknown exceptions become `{code:'internal',message:'插件请求失败'}`; diagnostics must redact credentials.

```js
// Actual plugin attachment pattern; the returned value is not a disposer.
ctx.inject(['otoolsSocket'], socketCtx => {
  const registration = socketCtx.otoolsSocket.registerSource(definition)
  const unsubscribe = store.subscribe(change => {
    registration.emit('change', { revision: change.revision })
  })
  return () => {
    unsubscribe()
    registration.dispose()
  }
})
```

Source `hello()` runs behind a per-subscription bounded event queue. Capture live events while the snapshot resolves, then flush them after the baseline; queue overflow sends `overflow` and retries snapshot rather than claiming lossless delivery. Timeouts/cancel settle the request exactly once; late resolutions cannot emit another response. An AbortSignal is cooperative: synchronous infinite loops and process OOM are not isolated by this design. Never describe these in-process plugins as sandboxed.

- [ ] **Step 5: Run focused tests and commit**

Run the Step 3 command; expected PASS.

```powershell
git add plugins/dsh-plugin-otools-socket/src/host/service.js plugins/dsh-plugin-otools-socket/src/host/control.js plugins/dsh-plugin-otools-socket/src/host/source.js plugins/dsh-plugin-otools-socket/test/service.test.mjs plugins/dsh-plugin-otools-socket/test/control.test.mjs
git commit -m "feat(socket): add dynamic source catalog and request isolation"
```

### Task 4: Implement pairing, rotating credentials and revocation

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/src/host/auth.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/store.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/config.js`
- Create: `plugins/dsh-plugin-otools-socket/test/auth.test.mjs`
- Create: `plugins/dsh-plugin-otools-socket/test/store.test.mjs`
- Reference behavior: `plugins/dsh-plugin-mobile-bridge/src/host/auth.js`, `store.js`, `config.js`

**Interfaces:**
- Produces: `PairingOffers`, `pair({code,secret,name})`, `authenticateAccess(token)`, `refresh(refreshToken)`, `revoke(deviceId)`, `listDevices()`.
- Produces persisted ledger `dsh-plugin-otools-socket.json` with only hashes and expiry timestamps.
- Constants: pair TTL 30 minutes, access TTL 24 hours, refresh TTL 90 days, ten failed pair attempts per minute.

- [ ] **Step 1: Write failing auth tests**

Pin one-use offer consumption, expiry, throttle, 256-bit tokens, constant-time matching, access expiry, refresh rotation (old refresh immediately fails), revoked device rejection, and no plaintext token in serialized ledger.

Export `mintDevice(name,now)` returning `{tokens:{accessToken,refreshToken},record}`. Record fields include `tokenHash`, `refreshHash`, `accessExpiresAt`, `refreshExpiresAt`, `deviceId`, `name`, `createdAt`, `revokedAt`. Add this concrete test before implementation:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mintDevice } from '../src/host/auth.js'

test('issued credentials have explicit expiry and are absent from persisted record', () => {
  const { tokens, record } = mintDevice('phone', 1000)
  assert.equal(record.accessExpiresAt, 1000 + 86400000)
  assert.equal(record.refreshExpiresAt, 1000 + 7776000000)
  assert.equal(record.revokedAt, null)
  const persisted = JSON.stringify(record)
  assert.equal(persisted.includes(tokens.accessToken), false)
  assert.equal(persisted.includes(tokens.refreshToken), false)
  assert.match(record.tokenHash, /^[a-f0-9]{64}$/)
  assert.match(record.refreshHash, /^[a-f0-9]{64}$/)
})
```

Pair/refresh/revoke must serialize on the ledger write queue. Do not respond with newly minted plaintext tokens until the atomic disk write succeeds. Concurrent refreshes using one token have exactly one winner; failed persistence does not invalidate the previous durable record. Server closes/re-authenticates an existing control socket when its access credential expires; expiry checking only at handshake is insufficient.

- [ ] **Step 2: Write failing store tests**

Pin atomic write/rename, corrupt-ledger quarantine, schema normalization, restart persistence of device hashes, and fresh in-memory pairing offer after restart. Explicitly assert no attempt to read `dsh-plugin-mobile-bridge.json`.

- [ ] **Step 3: Run focused tests, implement and rerun**

Run: `node --test plugins/dsh-plugin-otools-socket/test/auth.test.mjs plugins/dsh-plugin-otools-socket/test/store.test.mjs`

Expected before implementation: FAIL; after implementing by adapting the mobile-bridge patterns with explicit expiries and rotation: PASS.

- [ ] **Step 4: Commit**

```powershell
git add plugins/dsh-plugin-otools-socket/src/host/auth.js plugins/dsh-plugin-otools-socket/src/host/store.js plugins/dsh-plugin-otools-socket/src/host/config.js plugins/dsh-plugin-otools-socket/test/auth.test.mjs plugins/dsh-plugin-otools-socket/test/store.test.mjs
git commit -m "feat(socket): add expiring paired device credentials"
```

### Task 5: Implement external listener and one-use transfer tickets

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/src/host/tickets.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/http.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/net.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/carriers/listener.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/carriers/websocket.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/routes.js`
- Create: `plugins/dsh-plugin-otools-socket/test/routes.test.mjs`
- Create: `plugins/dsh-plugin-otools-socket/test/tickets.test.mjs`
- Create: `plugins/dsh-plugin-otools-socket/test/socket.test.mjs`

**Interfaces:**
- Produces routes `/hello`, `/pair`, `/session/refresh`, `/socket`, `/transfer/:ticket` under `/dsh-plugin-otools-socket`.
- Produces context-bound `issueTransfer({kind:'upload'|'download'|'binary-ws',contentType,maxBytes,idleTimeoutMs,maxDurationMs,onStart}): {url,kind,expiresAt,contentType,maxBytes}`. Device/source IDs are bound by the service, never supplied by the plugin. `onStart(context)` receives `{kind,deviceId,sourceId,contentType,maxBytes,signal,request}` plus one carrier: upload `{body:AsyncIterable<Uint8Array>}`, download `{setResponse({status?,headers?,size?});write(Uint8Array);end()}`, or binary WebSocket `{socket:{sendBinary,sendText,close,onBinary,onText,onClose}}`. Authentication and atomic ticket consumption complete before the callback.
- Consumes Tasks 2–4 service, auth and ticket invalidation callbacks.

- [ ] **Step 1: Write failing external route/security tests**

Use a real `node:http` server. Assert listener is absent by default; `/hello` exposes protocol/pairing state but no catalog; every stateful path rejects missing/invalid tokens; CORS allows configured H5 origins without cookies; token query parameters are rejected; control socket accepts only `dsh-bus-v2` plus encoded-token subprotocol.

- [ ] **Step 2: Write failing ticket tests**

Cover atomic first-consumer win, wrong-device rejection, start-after-60-seconds rejection, upload byte limit, download completion cleanup, binary WebSocket start, disconnect cleanup, and device revocation invalidating unused and active tickets.

- [ ] **Step 3: Implement isolated listener and routes**

Adapt the existing mobile-bridge listener shutdown pattern, but register only the new external paths. Keep the loopback DSH server and LAN listener as separate carriers. Return stable JSON envelopes and never serialize an exception stack.

**Transfer authentication and wire contract (also consumed by batch two):**

- Return `{url,kind,expiresAt,contentType,maxBytes}`; the URL contains only the opaque ticket. HTTP consumers send `Authorization: Bearer <accessToken>`. Binary sockets send `dsh-transfer-v1` and `dsh-token.<base64url(UTF8(accessToken))>` subprotocols. Server echoes only the non-secret protocol. A ticket alone is insufficient.
- Use fetch + Blob for H5 downloads, not an authenticated anchor URL; uni upload/download sends the authorization header. Never redirect authenticated transfer requests to a different origin. URL origin must equal the selected connection's origin.
- Authenticate, verify device/source/kind/expiry, then atomically consume the ticket before calling the handler. Wrong-device attempts do not consume the intended device's ticket. Failed started transfers require a newly issued ticket; there is no reuse/retry of consumed tickets.
- Upload accepts raw bytes or multipart with exactly one `file` part; all other parts and duplicate files are rejected. Parse multipart incrementally with bounded headers (16 KiB), count decoded file bytes against `maxBytes`, and test boundaries split across chunks. Do not buffer whole uploads or trust filenames as host paths.
- Bind `issueTransfer` to the request context's device and source; plugins cannot supply a different device ID. Require explicit `idleTimeoutMs` and `maxDurationMs`, constrained to 1 second–1 hour and 1 second–24 hours respectively. Both clocks, source disposal and device revocation abort active handlers.
- For the first binary terminal protocol, server binary output frames are `[uint64BE startByteOffset][raw bytes]`; client binary frames are raw input. Resize uses a bounded text frame `{kind:'resize',cols,rows}`, columns/rows integer 1–1000. Replay is tagged by byte offsets, never by decoding/re-encoding UTF-8. Control-channel JSON parsing is not reused for binary frames.

Create `test/tickets.test.mjs` against `TicketStore({now,isDeviceActive})`. Its `issue(spec)` returns `{ticket,expiresAt}`; `consume(ticket,{deviceId,sourceId,kind})` returns the bound specification or throws a stable code:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { TicketStore } from '../src/host/tickets.js'

test('wrong device cannot consume; correct device gets only one start', () => {
  const tickets = new TicketStore({ now: () => 1000, isDeviceActive: () => true })
  const issued = tickets.issue({
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
    maxBytes: 1024, idleTimeoutMs: 10000, maxDurationMs: 60000,
  })
  const identity = { deviceId: 'phone-a', sourceId: 'example.files', kind: 'download' }
  assert.throws(() => tickets.consume(issued.ticket, {
    ...identity, deviceId: 'phone-b',
  }), { code: 'forbidden' })
  assert.equal(tickets.consume(issued.ticket, identity).maxBytes, 1024)
  assert.throws(() => tickets.consume(issued.ticket, identity), { code: 'ticket_unavailable' })
})
```

Add expiry, inactive-device, source-removal and two competing consumers to this test file; routes tests exercise the real streamed handler and header/subprotocol paths.

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
node --test plugins/dsh-plugin-otools-socket/test/routes.test.mjs plugins/dsh-plugin-otools-socket/test/tickets.test.mjs plugins/dsh-plugin-otools-socket/test/socket.test.mjs
```

Expected: PASS.

```powershell
git add plugins/dsh-plugin-otools-socket/src/host plugins/dsh-plugin-otools-socket/test
git commit -m "feat(socket): expose authenticated external control and transfers"
```

### Task 6: Package the hidden infrastructure plugin and install it first

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/package.json`
- Create: `plugins/dsh-plugin-otools-socket/cordis.patch.yml`
- Create: `plugins/dsh-plugin-otools-socket/src/index.js`
- Create: `plugins/dsh-plugin-otools-socket/src/host/sdk.js`
- Create: `plugins/dsh-plugin-otools-socket/scripts/build.mjs`
- Create: `plugins/dsh-plugin-otools-socket/scripts/check.mjs`
- Create: `plugins/dsh-plugin-otools-socket/README.md`
- Create: `plugins/dsh-plugin-otools-socket/LICENSE`
- Create: `plugins/dsh-plugin-otools-socket/test/entry.test.mjs`
- Modify: `scripts/pack-plugins.mjs`
- Modify: `scripts/bundled-plugins.test.mjs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/plugins.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces Cordis service `ctx.otoolsSocket` and infrastructure manifest metadata `{hidden:true,infrastructure:true}`.
- Consumes Tasks 2–5.

- [ ] **Step 1: Write plugin entry tests**

Using a fake Cordis-like context, assert `apply()` provides exactly one `otoolsSocket`, registers internal `/dsh-plugin-otools-socket/socket` only after `webServer` is available, starts no LAN listener by default, and disposes sources/sockets/listener in reverse order.

- [ ] **Step 2: Write packaging/visibility tests before Rust changes**

Extend `scripts/bundled-plugins.test.mjs` to require socket first in all three manifests, exactly one infrastructure plugin, no infrastructure plugin in user-selectable status/prompt lists, and rejection of install/remove/choice IPC for infrastructure IDs.

- [ ] **Step 3: Run tests and observe failure**

Run:

```powershell
node --test plugins/dsh-plugin-otools-socket/test/entry.test.mjs
npm test
```

Expected: FAIL for missing package and manifest metadata.

- [ ] **Step 4: Implement package entry and infrastructure installer semantics**

Use plain `ctx.provide('otoolsSocket', service)`; do not import Cordis at runtime. Add `hidden` and `infrastructure` to Rust `Bundled`, install infrastructure after DSH entry setup but before optional plugin settlement, log failure without aborting startup, and omit it from prompt/status/remove surfaces while retaining diagnostics.

- [ ] **Step 5: Build and run desktop/Rust validation**

Run:

```powershell
npm --prefix plugins/dsh-plugin-otools-socket run check
npm --prefix plugins/dsh-plugin-otools-socket test
npm test
npm run typecheck
npm run pack:plugins
npm run rust:fmt:check
npm run rust:check
npm run rust:test
```

Expected: all PASS; stable tarball exists under `plugins/.pack`.

- [ ] **Step 6: Commit**

```powershell
git add plugins/dsh-plugin-otools-socket scripts/pack-plugins.mjs scripts/bundled-plugins.test.mjs src-tauri/tauri.conf.json src-tauri/src/plugins.rs src-tauri/src/main.rs
git commit -m "feat(socket): install hidden shared bus infrastructure"
```

### Task 7: Provide the browser Cordis bus service and migrate five panel streams

**Files:**
- Create: `plugins/dsh-plugin-otools-socket/src/client/index.js`
- Create: `plugins/dsh-plugin-otools-socket/src/client/bus-client.js`
- Create: `plugins/dsh-plugin-otools-socket/scripts/wrap-client.mjs`
- Create: `plugins/dsh-plugin-otools-socket/test/client.test.mjs`
- Create: `plugins/.shared/client/panel-channel.js` (optional-service attachment and fallback only; no shared-socket ownership)
- Modify: `plugins/dsh-plugin-otools-socket/package.json` (`exports['./client']`, `dsh.client: {inject:[],platform:'web',immediately:true}`) and `scripts/build.mjs`
- Modify: `scripts/sync-shared.mjs`, `scripts/shared-sources.test.mjs`
- Modify: five consuming plugins' `scripts/wrap-client.mjs`
- Modify: Taskboard/RepoPanel/Automation `src/client/index.js`, Canvas `src/client/state.js` and `src/client/index.js`, otools-git `src/client/api.js` and `src/client/index.js`
- Modify: five plugins' `src/index.js` and `src/host/routes.js`
- Create: each consuming plugin's `test/client-socket.test.mjs`
- Regenerate: affected `lib/**`

**Interfaces:**
- The infrastructure browser entry calls `ctx.provide('otoolsSocket', client)` exactly once. `client.subscribe(source,{onReady,onEvent,onUnavailable})` returns an idempotent unsubscribe function; `onReady(snapshot)` fires only after that source's baseline arrives, not merely on WebSocket open.
- `openPanelChannel(ctx,{source,startFallback,onFrame,onOpen,onClose,graceMs=2500})` uses nested `ctx.inject(['otoolsSocket'], ...)`. `startFallback()` returns a disposer for the existing own-WebSocket → SSE chain.
- Consumer top-level `inject` and manifest `dsh.client.inject` remain empty: the latter lists package dependencies, not optional Cordis service names. No global-symbol singleton or copied shared transport in consumers.

- [ ] **Step 1: Write provider tests before implementation**

Use injected `socketFactory` to count physical sockets; five subscriptions must create one. Test first/last subscription, baseline-before-event ordering, reconnect and disposal. Create `createBrowserBusClient({socketFactory,url,clock})` in `src/client/bus-client.js`; the injected clock exposes `setTimeout/clearTimeout/now` for deterministic tests.

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserBusClient } from '../src/client/bus-client.js'

test('five sources share the provider socket', () => {
  let opened = 0
  const socketFactory = () => {
    opened += 1
    return { readyState: 0, addEventListener() {}, send() {}, close() {} }
  }
  const client = createBrowserBusClient({ socketFactory, url: 'ws://localhost/socket' })
  const stops = ['a','b','c','d','e'].map(source => client.subscribe(source, {
    onReady() {}, onEvent() {}, onUnavailable() {},
  }))
  assert.equal(opened, 1)
  stops.forEach(stop => stop())
  client.dispose()
})
```

- [ ] **Step 2: Run the provider test and observe missing export failure**

Run: `node --test plugins/dsh-plugin-otools-socket/test/client.test.mjs`.

- [ ] **Step 3: Implement provider and classic-script build**

Keep connection/reconnect/request/catalog state only in `bus-client.js`; `src/client/index.js` owns creation and Cordis cleanup. Build `lib/client.js` using the existing module-loader factory format and `node:vm.Script` syntax validation. Transport is lazy: no subscriptions/requests means no socket.

- [ ] **Step 4: Test optional attachment and late takeover in each consumer**

Fake Cordis activation plus fake timers must cover: provider absent for 2500 ms starts one fallback; provider present but source not ready leaves fallback active; source baseline closes fallback once; service unload starts fallback; stale callbacks do nothing; panel dispose cancels timer and nested subscription. Fallback-to-shared transitions invoke existing full refetch before accepting increments.

- [ ] **Step 5: Implement host registration and bounded event projection**

Each plugin registers one internal source. Keep the returned registration handle and call `registration.emit(name,data)` from its store/operation subscription; cleanup calls both unsubscribe and `registration.dispose()`. Retain existing desktop HTTP and fallback payloads. For shared frames, Canvas/Taskboard changes send compact revision invalidations, not potentially multi-MiB notes/prompts. otools-git sends bounded operation summaries/log deltas, not its accumulated 4,000-line log. Shared consumers refetch through existing HTTP where required; never silently discard an oversized mutation without invalidation.

- [ ] **Step 6: Implement consumer helper and run focused/full tests**

Only `panel-channel.js` is copied/inlined into consumers. It manages optional service/fallback lifecycle and contains no bus `new WebSocket`. Run provider tests and each consumer's `test/client-socket.test.mjs`, then:

```powershell
npm run sync:shared
foreach ($name in 'taskboard','canvas','repopanel','automation','otools-git','otools-socket') {
  npm --prefix "plugins/dsh-plugin-$name" run check
  if ($LASTEXITCODE -ne 0) { throw "check failed: $name" }
  npm --prefix "plugins/dsh-plugin-$name" test
  if ($LASTEXITCODE -ne 0) { throw "tests failed: $name" }
}
npm test
```

- [ ] **Step 7: Review and commit only affected paths**

```powershell
git add plugins/.shared/client/panel-channel.js scripts/sync-shared.mjs scripts/shared-sources.test.mjs
foreach ($name in 'taskboard','canvas','repopanel','automation','otools-git','otools-socket') {
  git add -- "plugins/dsh-plugin-$name"
}
git diff --cached --check
git commit -m "refactor(plugins): consume the shared browser Cordis service"
```

### Task 8: Convert mobile-bridge into admin UI and session source

**Files:**
- Modify: `plugins/dsh-plugin-mobile-bridge/src/index.js`
- Create: `plugins/dsh-plugin-mobile-bridge/src/host/source.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/host/stream.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/host/routes.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/host/http.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/host/carriers/webserver.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/shared/protocol.js`
- Modify: `plugins/dsh-plugin-mobile-bridge/src/client/index.js`
- Delete from `src` and generated `lib`: `host/auth.js`, `host/store.js`, `host/config.js`, `host/net.js`, `host/carriers/listener.js`, `host/carriers/websocket.js`
- Create: `plugins/dsh-plugin-mobile-bridge/test/source.test.mjs`
- Rewrite: route/entry/protocol/client tests for delegated admin and no-v1 behavior

**Interfaces:**
- Produces paired source ID `dsh.session`, with session/workspace/model requests and projected session/approval/question events.
- Consumes `ctx.otoolsSocket` admin methods `externalState()`, `setExternalEnabled()`, `pairingOffer()`, `listDevices()`, `renameDevice()`, `revokeDevice()` and `registerSource()`.

- [ ] **Step 1: Write failing no-v1/delegation tests**

Assert the plugin starts no listener, owns no credential ledger, registers no `/dsh-mobile-bridge/ws|events|pair|session/refresh`, and delegates loopback admin operations to a fake `otoolsSocket`. Assert missing infrastructure produces an explicit admin state rather than throwing.

- [ ] **Step 2: Write failing session-source tests**

Pin source catalog and request names, reuse of existing narrow `bridge.js` methods, stream projection through `source.emit`, disposer cleanup, and paired exposure. Assert no token/session secret appears in source snapshots or errors.

- [ ] **Step 3: Implement the adapter and update the panel**

Keep panel/admin mount and loopback-only admin routes. Remove external ownership. Display enable toggle, listener URLs, QR, device list and infrastructure failure from the delegated service. Keep session business projection, but publish it over bus frames.

- [ ] **Step 4: Delete obsolete modules, rebuild and run tests**

Run:

```powershell
npm --prefix plugins/dsh-plugin-mobile-bridge run check
npm --prefix plugins/dsh-plugin-mobile-bridge test
```

Expected: PASS and no generated v1 carrier files in `lib/`.

- [ ] **Step 5: Commit**

```powershell
git add -A plugins/dsh-plugin-mobile-bridge
git commit -m "refactor(mobile-bridge): delegate identity and transport to shared bus"
```

### Task 9: Replace MCode bridge v1 with bus v2 transport and durable pairing

**Files:**
- Replace: `mcode-app/src/agents/dsh/protocol.ts`
- Replace: `mcode-app/src/agents/dsh/bridgeGateway.ts` with `mcode-app/src/agents/dsh/busGateway.ts` and update all imports/tests
- Modify: `mcode-app/src/agents/dsh/driver.ts`, `capabilities.ts`, `acpTranslation.ts`
- Create: `mcode-app/src/agents/dsh/transport/types.ts`
- Create: `mcode-app/src/agents/dsh/transport/browser.ts`
- Create: `mcode-app/src/agents/dsh/transport/uni.ts`
- Create: `mcode-app/src/agents/dsh/transport/index.ts`
- Create: `mcode-app/src/agents/dsh/busAuthClient.ts`
- Create: `mcode-app/src/agents/dsh/busClient.ts`
- Create: `mcode-app/src/agents/dsh/busClientRegistry.ts`
- Create: `mcode-app/src/agents/dsh/credentialStore.ts`
- Create: `mcode-app/src/agents/dsh/errors.ts`
- Create: `mcode-app/src/uni_modules/mcode-secure-store/**` for Android Keystore and iOS Keychain UTS adapters; Harmony intentionally uses labelled platform-storage fallback until a provider is separately selected and approved
- Modify: `mcode-app/src/services/connectionSchema.ts`, `connectionContext.ts`, `connectionMigration.ts`
- Modify: target-aware gateway reconstruction in `src/api/acp.ts` and `src/services/conversation/globalConversationSync.ts`
- Modify/add: focused tests under `mcode-app/tests/agents/dsh` and connection service tests

**Interfaces:**
- Produces `DshBusClient.connect()`, `catalog()`, `onCatalog(listener)`, `subscribe(source,listener)`, `request<T>(source,name,data?,{signal,timeoutMs}?)`.
- Produces `DshBusSocketAdapter.connect({url,protocols})` for browser and uni runtimes.
- Produces `DshCredentialStore` with `read/write/remove/securityLevel`.
- Consumes Tasks 1 and 6 external v2 endpoints.

- [ ] **Step 1: Replace protocol tests with v2 golden behavior**

Delete v1 route/frame expectations and pin bus v2 constants, token subprotocol, base URL normalization, request correlation, cancel/timeout, catalog replacement, source event dispatch, overflow callback and reconnect subscription replay.

- [ ] **Step 2: Add browser/uni adapter tests**

Inject fake browser `WebSocket` and `uni.connectSocket`; assert identical open/message/close behavior, binary rejection on control channel, stale callback suppression, and platform-specific actionable errors.

- [ ] **Step 3: Add pair/refresh/credential tests**

Assert scan fields survive normalization (`candidates`, pair material), pair atomically persists rotated credentials before clearing one-use fields, refresh retries exactly once and persists rotation before reconnect, failure requires re-pair, and security-level fallback is visible. Native adapter tests pin Android Keystore and iOS Keychain; H5/Harmony/mini-program tests pin platform-storage fallback and warning. Do not migrate v1 records silently; mark them incompatible.

- [ ] **Step 4: Implement transport, secure credential adapters, auth client, registry and target-aware reconstruction**

Acquire one registry-owned bus client per stable DSH connection ID and expose the same instance to ACP session translation and the Plugins tab. Preserve target identity in remote descriptors; do not reconstruct DSH as generic `DirectGateway`. Native targets store tokens through the UTS secure-store adapter; only H5/mini-program may use platform storage and must report `platform-storage`.

- [ ] **Step 5: Run focused and full MCode tests**

Run:

Native security acceptance is separate from Jest/build gates. The first implementation must provide Android Keystore and iOS Keychain. Harmony has no accepted provider in this repository yet: mark `securityLevel:'platform-storage'`, show the same warning as H5/mini-program, and create an explicit follow-up only after a native provider is selected and tested; do not invent a `mcode-secure-store` Harmony implementation in this task. Android/iOS records include OS/runtime versions and verify: tokens survive restart through the native provider, ordinary connection storage contains only a credential reference, removal deletes secrets, failed secure writes do not silently fall back to ordinary storage, and rotation persists before reconnect. No Android/iOS device/provider available means BLOCKED, not PASS. H5/Harmony/mini-program fallback is explicitly labelled `platform-storage`.

Focused DSH tests select a directory with a test pattern, not `--runTestsByPath`:

```powershell
pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- tests/agents/dsh
pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- --runTestsByPath tests/services/connectionSchema.spec.ts tests/services/connectionContext.spec.ts tests/services/connectionMigration.spec.ts
pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit
pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" exec vue-tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit MCode**

```powershell
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src/agents/dsh mcode-app/src/services mcode-app/src/api/acp.ts mcode-app/tests
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "feat(dsh): replace mobile bridge with shared bus v2"
```

### Task 10: Add the MCode Plugins tab, safe declarative renderer and developer console

**Files:**
- Create: `mcode-app/src/agents/dsh/ui/schema.ts`
- Create: `mcode-app/src/agents/dsh/ui/jsonPointer.ts`
- Create: `mcode-app/src/agents/dsh/ui/actions.ts`
- Create: `mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue` for the base node recursion/allowlist
- Create: `mcode-app/src/components/dsh/DshDeclarativeRenderer.vue` as the page-level data/action shell that delegates nodes to `DshDeclarativeNodeRenderer.vue`
- Create: `mcode-app/src/pages/connection-detail/components/ConnectionPluginsTab.vue`
- Create: `mcode-app/src/pages/connection-detail/components/DshDeveloperConsole.vue`
- Modify: `mcode-app/src/services/connectionDetail.ts`
- Modify: `mcode-app/src/pages/connection-detail/index.vue`
- Modify: `mcode-app/src/pages/connection-detail/connectionDetailPresentation.ts`
- Modify: `mcode-app/src/pages/connection-detail/components/ConnectionInfoTab.vue`
- Create: `mcode-app/src/services/developerModePreference.ts`
- Modify: `mcode-app/src/pages/settings/index.vue`
- Modify: `mcode-app/src/App.vue`
- Modify: `mcode-app/package.json` to add `typecheck: vue-tsc --noEmit -p tsconfig.json` and `build:app: uni build -p app`
- Modify: `mcode-app/README.md` so documented validation matches scripts
- Create/modify: tests for schema rejection, JSON Pointer, confirmation and page contracts

**Interfaces:**
- Consumes Task 9 `DshBusClient` and UI v1 schema from Task 1.
- Produces allowlisted renderer nodes, `executeDeclaredAction()` enforcing `none|confirm|danger`, conditional Plugins tab and redacted console.

- [ ] **Step 1: Write pure schema/pointer/action tests**

Pin allowlisted node types, JSON Pointer escaping, equality/existence/capability conditions, required operation metadata, and rejection of `html`, scripts, expressions, unrestricted dynamic component names and unknown UI versions. Assert remote metadata cannot lower `danger` to `confirm` or `none`.

- [ ] **Step 2: Write page contract tests**

Assert Plugins tab appears only for DSH, catalog replacement updates cards, selecting a page invokes only declared requests, source removal closes its page, developer console defaults hidden, and all tokens/secrets/Authorization values are redacted.

- [ ] **Step 3: Implement base renderer, scripts and connection wiring**

Start with foundation components only: page/tabs/section/status/key-value/badge/Markdown/empty, basic form controls, buttons, confirmation and progress. Business-specific Kanban/Diff/etc. belong to later plans. Add the exact `typecheck` and `build:app` scripts named in Files; do not leave README-only commands.

- [ ] **Step 4: Implement lifecycle handling**

Notify the bus registry on App foreground/background; foreground triggers immediate reconnect evaluation. Show token presence and secure-storage level without values in connection info.

- [ ] **Step 5: Run tests and platform builds**

Run Jest, `vue-tsc`, `pnpm build:h5`, `pnpm exec uni build -p app`, and `pnpm build:mp-weixin`. Expected: PASS.

- [ ] **Step 6: Commit MCode**

```powershell
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src mcode-app/tests mcode-app/package.json mcode-app/README.md
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "feat(dsh): add declarative plugin catalog to connection detail"
```

### Appendix A: reusable validation commands for later tasks

Later plans invoke these named blocks rather than abbreviating “full gates.” Run from PowerShell.

```powershell
function Invoke-Native([string]$Label, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE" }
}
function Test-MCode {
  $app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
  Invoke-Native 'MCode Jest' { pnpm --dir $app run test:unit }
  Invoke-Native 'MCode types' { pnpm --dir $app exec vue-tsc --noEmit -p tsconfig.json }
  Invoke-Native 'MCode H5' { pnpm --dir $app run build:h5 }
  Invoke-Native 'MCode App' { pnpm --dir $app exec uni build -p app }
  Invoke-Native 'MCode Weixin' { pnpm --dir $app run build:mp-weixin }
}
function Test-DesktopPlugin([string]$Name) {
  $path = "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-$Name"
  Invoke-Native "$Name check" { npm --prefix $path run check }
  Invoke-Native "$Name tests" { npm --prefix $path test }
}
function Test-DesktopRoot {
  $root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
  Invoke-Native 'desktop types' { npm --prefix $root run typecheck }
  Invoke-Native 'desktop tests' { npm --prefix $root test }
}
```

When a task says `Test-MCode`, `Test-DesktopPlugin <name>` or `Test-DesktopRoot`, use these exact definitions. They do not replace native-device acceptance or the final Rust/packaging gate.

### Task 11: Run the foundation cross-repository acceptance gate

**Files:**
- Modify: desktop `README.md`, `PLUGINS.md`, `PUBLISH.md`, `.github/workflows/ci.yml`
- Create/update: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/2026-09-08-dsh-bus-v2.md` as required by `AGENTS.md`
- Add: coordinated-release artifact drift command and counterpart SHA inputs; ordinary per-repository CI remains independently runnable

**Interfaces:**
- Consumes all prior tasks.
- Produces a documented, testable foundation release candidate.

- [ ] **Step 1: Add the protocol-artifact drift gate**

Compare the two artifact directories byte-for-byte with explicit counterpart SHAs in coordinated release CI; do not compare moving `main` branches in ordinary single-repo PR CI.

```powershell
git diff --no-index --exit-code -- "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-socket/src/shared/protocol-artifacts" "D:/Repos/xyito/lingyun/mcode/mcode-app/src/agents/dsh/protocol-artifacts"
```

Expected: exit 0 and no diff.

- [ ] **Step 2: Run complete desktop validation**

Run the following from the desktop repository in PowerShell; every failing native exit stops the gate. A regenerated-lib diff compares the working tree with the index only after intended outputs are reviewed/staged. It does not prove tests passed.

```powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'desktop typecheck failed' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'desktop tests failed' }
foreach ($name in 'taskboard','canvas','repopanel','automation','otools-git','longread','otools-term','otools-dbm','mobile-bridge','otools-socket') {
  npm --prefix "plugins/dsh-plugin-$name" run check
  if ($LASTEXITCODE -ne 0) { throw "check failed: $name" }
  npm --prefix "plugins/dsh-plugin-$name" test
  if ($LASTEXITCODE -ne 0) { throw "tests failed: $name" }
}
foreach ($script in 'build','rust:fmt:check','rust:check','rust:test') {
  npm run $script
  if ($LASTEXITCODE -ne 0) { throw "gate failed: $script" }
}
git diff --exit-code -- ':(glob)plugins/dsh-plugin-*/lib/**'
if ($LASTEXITCODE -ne 0) { throw 'unreviewed generated output changes' }
```

The `:(glob)` prefix is intentional: Git's ordinary pathspec wildcard does not have the shell's segment semantics. Inspect any changed output before staging; never use checkout/reset simply to make this gate green.

- [ ] **Step 3: Run complete MCode validation**

Run these commands in PowerShell with absolute repository paths:

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit
if ($LASTEXITCODE -ne 0) { throw 'MCode Jest failed' }
pnpm --dir $app exec vue-tsc --noEmit -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw 'MCode typecheck failed' }
pnpm --dir $app run build:h5
if ($LASTEXITCODE -ne 0) { throw 'H5 build failed' }
pnpm --dir $app exec uni build -p app
if ($LASTEXITCODE -ne 0) { throw 'App build failed' }
pnpm --dir $app run build:mp-weixin
if ($LASTEXITCODE -ne 0) { throw 'Weixin build failed' }
```

Run native packaging/device gates separately. Build success alone does not verify secure storage, terminal rendering, network permissions or mini-program legal domains.

- [ ] **Step 4: Perform a real smoke test**

Start desktop, verify one browser control socket for five migrated panels, enable external listening, scan from MCode, observe catalog/session source, disconnect/reconnect network, then revoke the device and verify control plus a live transfer close immediately. Record exact tested platform and addresses in the architecture note without secrets.

- [ ] **Step 5: Commit documentation/CI in each repository**

Use focused `docs:`/`ci:` commits. Do not tag or publish in this task.
