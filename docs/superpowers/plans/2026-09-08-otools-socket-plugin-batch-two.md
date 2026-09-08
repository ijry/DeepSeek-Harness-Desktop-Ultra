# DSH Mobile Plugin Batch Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and execute this plan inline task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Longread, otools-term, and otools-dbm complete mobile-reachable workflows while stabilizing reusable reader, terminal, file-tree, SQL-editor, and editable data-grid contracts without claiming unverified native terminal parity.

**Architecture:** Each desktop plugin registers one optional `paired` source against the foundation bus and reuses its existing store/engine/runtime; JSON control frames carry bounded metadata and temporary authenticated channels carry books, terminal bytes, files, imports, exports, and oversized database results. MCode adds source-neutral declarative components: readers and SQL editors work on every target, while terminal transport is cross-platform but terminal rendering is H5/xterm first and remains explicitly unavailable on a target until a real non-DOM renderer passes native acceptance.

**Tech Stack:** Node.js 22 ESM, Cordis, `node:test`, ssh2, xterm.js, Vue 3, TypeScript, uni-app, Jest, SQLite (`node:sqlite`), existing DB drivers.

**Spec:** `docs/superpowers/specs/2026-09-07-otools-socket-shared-bus-design.md`

**Prerequisites:** Complete `docs/superpowers/plans/2026-09-08-otools-socket-foundation.md` and `docs/superpowers/plans/2026-09-08-otools-socket-plugin-batch-one.md`; consume their bus v2, declarative UI v1, action-confirmation, and transfer-ticket contracts exactly.

## Global Constraints

- Keep `dsh-desktop-ultra` and `mcode` changes and commits independent.
- Register source IDs `dsh-plugin-longread`, `dsh-plugin-otools-term`, and `dsh-plugin-otools-dbm` with `protocolVersion: 1` and explicit `exposure: 'paired'`.
- Never add a source-ID switch to MCode; every renderer extension is a public UI v1 component and executes no plugin HTML, JavaScript, expression, template, or custom renderer code.
- Complete JSON control frames stay at or below 262144 UTF-8 bytes; complete visible catalog stays at or below 524288 UTF-8 bytes; large payloads use foundation transfer tickets.
- Transfer tickets are device/source-bound and one-use, must start within 60 seconds, and die on source disposal, timeout, disconnect, or device revocation; a failed start requires a newly issued ticket.
- Terminal output uses binary WebSocket frames `[uint64BE startByteOffset][raw bytes]`; client input is raw binary and resize is bounded JSON text. Never base64 terminal bytes into control events.
- SFTP, book imports, database imports/exports/backups/dictionaries, and oversized query results use temporary authenticated channels with explicit byte limits, progress, cancellation, idle timeout, and maximum duration.
- Never expose DB/SSH credentials, private keys, access/refresh tokens, connection strings, arbitrary desktop host paths, or exception stacks in snapshots, responses, events, tickets, URLs, task metadata, or logs.
- Destructive SQL/data/file/restore/sync execution and public tunnel exposure use `danger`; `SourceCatalog` command identity and parsed SQL type determine risk, never untrusted display labels.
- Mobile never claims to launch a desktop-local RDP/VNC client. Local terminal `__local__` remains excluded absent a separate reviewed security decision.
- Preserve all existing desktop HTTP/WebSocket/SSE behavior. One source adapter shares the same store/engine/runtime; it never creates a second connection pool, task manager, scheduler, or ledger.
- Published plugin tarballs remain self-contained; shared code is build-time copied only. Run plugin build/check/tests and review regenerated `lib/**` for CRLF/autocrlf drift.
- MCode validation includes Jest, `vue-tsc`, H5, App, and Weixin builds. Builds prove compilation only; they do not prove native secure storage, socket behavior, terminal rendering, IME handling, or approved mini-program domains.
- H5 terminal rendering may use xterm. App, Harmony, and mini-program terminal rendering require a reviewed non-DOM/native renderer plus device acceptance; until then the UI must show `terminal_renderer_unavailable` while preserving server, connection, SFTP, transfer, tunnel, and task management.
- Every task that changes MCode code/tests creates a runtime-timestamped `docs/mcode-architecture-notes/` note in the same MCode commit, covering architecture, protocol/data flow, UI/compatibility and Android/iOS replication. Use task suffixes: `dsh-reader-transfer`, `dsh-longread-workflow`, `dsh-terminal-file-tree`, `dsh-term-workflow`, `dsh-sql-data-grid`, `dsh-dbm-workflow`, and final `dsh-plugin-batch-two`.
- TDD every task: write a focused failing test, observe the specified failure, implement minimally, run affected/full gates, then commit only during execution.

---

**Transfer-handler contract inherited from foundation:** `onStart(context)` is fixed before this plan executes. `context` is `{kind,deviceId,sourceId,contentType,maxBytes,signal,request}` plus exactly one carrier: upload `{body:AsyncIterable<Uint8Array>}`, download `{setResponse({status?,headers?,size?}); write(Uint8Array); end()}`, or binary WebSocket `{socket:{sendBinary(bytes),sendText(text),close(code?,reason?),onBinary(fn),onText(fn),onClose(fn)}}`. Ticket ownership is already authenticated and atomically consumed before `onStart`; handlers cannot choose a new device/source. An exception aborts/closes the carrier and never makes the ticket reusable. Batch-two tests use this exact shape.

## Fixed Public Source Contracts

The following names are fixed command strings, not HTTP paths. All object schemas set `additionalProperties: false`; all list cursors bind the source revision and stale cursors fail `conflict`. A page is bounded by both item count and encoded response bytes, and a single value that cannot fit returns a transfer descriptor instead of truncating silently.

**Longread:** `library/read`, `chapter/read`, `progress/update`, `settings/update`, `book/import`, `book/delete`; events `library/changed`, `progress/changed`, `settings/changed`. `library/read` accepts `{}` and returns metadata/TOC/settings/progress only. `chapter/read` accepts `{bookId:string,chapterIndex:integer,cursor?:integer,maxChars?:integer}` with `maxChars` 256–65536 (default 32768), and returns `{bookId,chapterIndex,chapterStart,chapterTitle,cursor,nextCursor,text,progressOffset,done}` under the control cap. `cursor`/`nextCursor` are chapter-relative page positions; `chapterStart` and persisted `progressOffset` are absolute offsets in the normalized full book text, so `chapterStart + cursor` maps a rendered character to stable progress and changing `turnChars` cannot move the reader. `progress/update` accepts `{bookId,chapterIndex,offset}` with the same book-global offset. `settings/update` accepts the existing bounded settings patch. `book/import` accepts `{name,size,mime}` and returns an upload ticket capped at 134217728 bytes; import completes only after streamed bytes pass the existing TXT/EPUB import validation. `book/delete` accepts `{bookId}` and is `danger`; import is `confirm`; other commands are `none`.

**otools-term:** expose typed commands for `state/read`, `server/list`, `server/read`, `server/save`, `server/delete`, `connection/connect`, `connection/disconnect`, `host-key/accept`, `host-key/forget`, `session/list`, `terminal/open`, `terminal/attach`, `terminal/close`, `sftp/home`, `sftp/list`, `sftp/stat`, `sftp/search`, `sftp/read`, `sftp/write`, `sftp/mkdir`, `sftp/create-file`, `sftp/rename`, `sftp/delete`, `sftp/chmod`, `sftp/upload`, `sftp/download`, `workspace/list`, `workspace/upload`, `workspace/download`, `task/list`, `task/cancel`, `task/clear`, `tunnel/read`, `tunnel/forward/start`, `tunnel/forward/stop`, `tunnel/forward/save`, `tunnel/forward/delete`, `tunnel/socks/start`, `tunnel/socks/stop`, `tunnel/server/stop`, `known-host/list`, `ai/availability`, `ai/job/list`, `ai/start`, `ai/cancel`, `favorite/update`, and `prefs/update`. Server results contain only redacted records and secret-presence booleans. `terminal/attach` accepts `{sessionId,offset}` and returns a binary-WebSocket ticket plus `{startOffset,endOffset,overflowed}`; replay and live bytes retain original byte offsets. SFTP editor text stays in control only while its complete encoded envelope is below 262144 bytes; the existing 4194304-byte editor ceiling is a domain maximum, and larger control responses switch to a transfer ticket earlier. Upload accepts at most 2147483648 bytes. `workspace/list` returns `{id,title}` only; `workspace/upload` and `workspace/download` accept a registered `workspaceId` plus contained `relative` path and never return its resolved host path. Remote delete, public tunnel bind/delete, server delete, and host-key forget are `danger`; credential/server save, connect, host-key acceptance, terminal open, SFTP write/rename/chmod, workspace transfers, and tunnel start/save are `confirm`; reads, input carried on the authenticated binary socket, close/stop/cancel are `none`. Exclude `/desktop/launch`, raw workspace host paths, SSH-config host-path import, and `__local__`.

**otools-dbm:** expose typed source names grouped as connection (`connection/list|read|create|update|delete|open|close|active`), SQL (`sql/execute|workbench|dashboard|explain`), catalog (`catalog/databases|schemas|tables|views|procedures|view-definition|procedure-definition|stats`), grid (`grid/read|save`), structure (`structure/table|all|create-sql|table/create|table/drop|column/add|column/modify|column/delete|comment/update|index/create|index/drop`), Redis (`redis/key/read|tree/read|key/set|key/delete`), artifacts (`artifact/export-table|export-tables|backup|dictionary|download`), imports (`import/database-sql|table-sql|table-data|restore`), backup/sync (`backup-plan/list|save|run|storage`, `sync/preview|run|logs`), tasks (`task/list|clear|cancel|retry`), plugin state, and AI commands matching existing host capabilities. Exclude `dbm_fs_*`, `upload_save_image`, `copy_exported_file`, arbitrary host path parameters, and any desktop dialog/reveal command. Upload commands accept a ticket-owned temporary-file token, never `filePath`; artifact commands return task IDs and download tickets, never `exportPath`/`outputPath`. Query/grid pages return typed columns, primary-key metadata, rows, `{cursor,nextCursor,encodedBytes,done}` and switch to download when a single page cannot fit. `grid/save` accepts `{added,modified:[{original,current}],deleted,validate_only?}` after the source converts the public serialized-key model; it preserves the existing atomic transaction and refuses updates/deletes without every primary-key part. `task/list`/events are redacted views and tasks remain process-memory-only, so reconnect within the same desktop process restores a snapshot but desktop restart does not; never imply durable resume. Reads are `none`; ordinary mutations are `confirm`; connection deletion, table/column/index drop, row/Redis deletion, `sql/execute|workbench` (maximum static risk), restore, backup/sync execution, and task retry of destructive work are `danger`.

## Planned File Map

- MCode `src/services/dshPlugins/{transferChannel,binaryChannel}.ts`: target-neutral authenticated temporary-channel clients; no presentation state.
- MCode `src/services/declarativeUi/{reader,terminal,fileTree,sqlEditor,dataGrid}.ts`: pure public node state, validation, cursor, and mutation models.
- MCode `src/components/declarative/Declarative*.vue`: thin target-aware views that emit only declared actions.
- Each plugin `src/shared/source.js`: command catalog, schemas, risk metadata, source constants, and safe projection helpers.
- Each plugin `src/host/source.js`: maps source requests/events onto the existing domain runtime; no HTTP self-calls.
- Term/DBM `src/host/source-transfer.js`: temporary-channel handlers and cleanup only.
- DBM `src/host/runtime.js`: the one lifecycle owner shared by desktop routes and source registration.

### Task 1: Add authenticated transfer and reader primitives to MCode

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/dshPlugins/transferChannel.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/reader.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/declarative/DeclarativeReader.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/services/dshPluginTransfer.spec.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/declarative/readerPresentation.spec.ts`

**Interfaces:**
- Consumes: foundation transfer descriptor `{url,kind,expiresAt,contentType,maxBytes}`, selected connection origin/access token, and `executeDeclaredAction()`.
- Foundation transfer `onStart(context)` is the exact carrier contract fixed above; source implementations do not invent a second shape.
- Produces: `uploadTransfer(ticket,file,{connectionOrigin,now,signal,onProgress})`, `downloadTransfer(ticket,{connectionOrigin,now,signal,onProgress})`, `createReaderState(payload)`, and public UI node `reader`. Transfer helpers never auto-retry: callers request a fresh ticket after an explicit failure or deliberate user restart.

- [ ] **Step 1: Write failing transfer-client tests**

```ts
import { uploadTransfer } from '@/services/dshPlugins/transferChannel'

test('never reuses or automatically replaces a failed transfer ticket', async () => {
  const used: string[] = []
  const fetchImpl = jest.fn(async (url: string) => {
    used.push(url)
    return new Response('', { status: 409 })
  })
  await expect(uploadTransfer(
    { url: 'https://dsh.test/transfer/first', kind: 'upload', expiresAt: 60_000,
      contentType: 'application/octet-stream', maxBytes: 8 },
    new Uint8Array([1, 2]),
    { accessToken: 'secret', connectionOrigin: 'https://dsh.test', now: () => 0,
      fetchImpl, signal: new AbortController().signal },
  )).rejects.toMatchObject({ code: 'ticket_unavailable' })
  expect(used).toEqual(['https://dsh.test/transfer/first'])
  expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret')
  expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('?token=')
})
```

Add cases for H5 fetch/Blob download, uni `uploadFile`/`downloadFile` authorization headers, raw and exactly-one-`file` multipart modes, declared-size/maxBytes rejection before start, progress monotonicity, abort, wrong-origin rejection, expiry, redacted errors, and all transport/HTTP failures surfacing after exactly one ticket attempt.

- [ ] **Step 2: Run transfer tests and observe failure**

Run: `pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- --runTestsByPath tests/services/dshPluginTransfer.spec.ts`

Expected: FAIL with `Cannot find module '@/services/dshPlugins/transferChannel'`.

- [ ] **Step 3: Implement the minimal transfer client**

```ts
export interface TransferTicket {
  url: string
  kind: 'upload' | 'download'
  expiresAt: number
  contentType: string
  maxBytes: number
}
export interface TransferProgress { loaded: number; total?: number }

export async function uploadTransfer(
  ticket: TransferTicket,
  file: Blob | Uint8Array | UniApp.ChooseFileSuccessCallbackResult['tempFiles'][number],
  options: { accessToken: string; connectionOrigin: string; now: () => number;
    signal: AbortSignal; onProgress?: (p: TransferProgress) => void; fetchImpl?: typeof fetch },
): Promise<{ ok: true }> {
  const valid = validateTransfer(ticket, file, options)
  await uploadOnce(valid, file, options)
  return { ok: true }
}
```

Implement the following helpers in `transferChannel.ts` rather than leaving them implicit:

```ts
function validateTicket(ticket: TransferTicket, options: {
  connectionOrigin: string; now: () => number
}, expected: TransferTicket['kind']) {
  const url = new URL(ticket.url, options.connectionOrigin)
  if (url.origin !== new URL(options.connectionOrigin).origin) throw transferError('forbidden')
  if (ticket.kind !== expected || options.now() >= ticket.expiresAt) {
    throw transferError('ticket_unavailable')
  }
  if (!Number.isSafeInteger(ticket.maxBytes) || ticket.maxBytes < 0) {
    throw transferError('invalid_input')
  }
  return { ...ticket, url: url.toString() }
}
function transferError(code: string, message = code) {
  return Object.assign(new Error(message), { code })
}
```

`uploadTransfer()` selects browser fetch for `Blob|Uint8Array`; when the platform file is represented only by a temp path, call injected/default `uni.uploadFile({name:'file',header:{Authorization}})`, register progress and abort once, and require a 2xx status in its callback. `downloadTransfer()` selects authenticated fetch→Blob in H5 or injected/default `uni.downloadFile({header:{Authorization}})`, verifies 2xx, registers progress/abort, and returns `{blob}` or `{tempFilePath}`. Both helpers mark the local ticket object consumed before opening the request so the same object cannot be attempted twice; failures always escape. Do not add an internal reissue callback. Tests inject `fetchImpl`, `uploadFileImpl`, `downloadFileImpl`, `URLImpl` and `saveBlob` so Node/Jest never depends on a real browser or file picker.

- [ ] **Step 4: Write failing pure reader tests**

```ts
import { applyChapterPage, createReaderState } from '@/services/declarativeUi/reader'

test('restores an absolute offset independently of turn size', () => {
  const state = createReaderState({ bookId: 'bk', chapterIndex: 2, progressOffset: 7 })
  const next = applyChapterPage(state, {
    bookId: 'bk', chapterIndex: 2, chapterStart: 0, chapterTitle: 'Two', cursor: 0,
    nextCursor: 11, text: 'alpha\nbeta', progressOffset: 7, done: false,
  })
  expect(next.text).toBe('alpha\nbeta')
  expect(next.progressOffset).toBe(7)
  expect(next.nextCursor).toBe(11)
})

test('keeps saved progress global while pages expose chapter-relative cursors', () => {
  const next = applyChapterPage(createReaderState({ bookId: 'bk', chapterIndex: 2,
    progressOffset: 1007 }), {
    bookId: 'bk', chapterIndex: 2, chapterStart: 1000, chapterTitle: 'Two',
    cursor: 0, nextCursor: 11, text: 'alpha\nbeta', progressOffset: 1007, done: false,
  })
  expect(next.chapterCursor).toBe(7)
  expect(next.progressOffset).toBe(1007)
})
```

Add TOC order, duplicate/out-of-order cursor rejection, bounded append, import/empty/error states, settings projection, stale-book reset, and text-only rendering tests. Assert strings containing `<script>` remain literal text and never reach `v-html`.

- [ ] **Step 5: Implement the reader model/component and register the node**

`DeclarativeReader.vue` reads catalog bindings, requests the next `chapter/read` page only when its current cursor matches, saves `{bookId,chapterIndex,offset}`, uses `transferChannel` for import, and emits `book/delete` through the foundation danger-confirmation executor. It never imports Longread-specific source IDs or types.

- [ ] **Step 6: Run MCode gates**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit -- --runTestsByPath tests/services/dshPluginTransfer.spec.ts tests/components/declarative/readerPresentation.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'reader/transfer focused tests failed' }
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

Expected: all commands exit 0. These build results do not verify real file-picker permissions or native transfer cancellation; record those separately in Task 10.

- [ ] **Step 7: Commit MCode**

```powershell
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src/services/dshPlugins/transferChannel.ts mcode-app/src/services/declarativeUi/reader.ts mcode-app/src/components/declarative/DeclarativeReader.vue mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue mcode-app/tests/services/dshPluginTransfer.spec.ts mcode-app/tests/components/declarative/readerPresentation.spec.ts
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "feat(dsh-ui): add reader and transfer primitives"
```

### Task 2: Register the Longread paired source with stable progress

**Files:**
- Create: `plugins/dsh-plugin-longread/src/shared/source.js`
- Create: `plugins/dsh-plugin-longread/src/host/source.js`
- Modify: `plugins/dsh-plugin-longread/src/index.js`
- Modify: `plugins/dsh-plugin-longread/src/host/store.js`
- Modify: `plugins/dsh-plugin-longread/src/host/library.js`
- Modify: `plugins/dsh-plugin-longread/src/shared/protocol.js`
- Create: `plugins/dsh-plugin-longread/test/source.test.mjs`
- Create: `plugins/dsh-plugin-longread/test/source-transfer.test.mjs`
- Modify: `plugins/dsh-plugin-longread/test/entry.test.mjs`
- Modify: `plugins/dsh-plugin-longread/test/routes.test.mjs`
- Modify: `plugins/dsh-plugin-longread/test/host.test.mjs`
- Regenerate: `plugins/dsh-plugin-longread/lib/**`

**Interfaces:**
- Consumes: foundation `registerSource()` and request-bound `issueTransfer()`; existing `LibraryStore`, `addBook`, `deleteBook`, `setProgress`, and `updateSettings`.
- Produces: `LONGREAD_SOURCE_ID`, `LONGREAD_CATALOG`, `createLongreadSource({store,filePool,now})`, `registerLongreadSource(ctx,options)`, and ledger schema v2 progress `{chapterIndex,offset,updatedAt}`.

- [ ] **Step 1: Write failing catalog, paging, and lifecycle tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLongreadSource } from '../src/host/source.js'

test('chapter/read pages by absolute character cursor below the control cap', async () => {
  const text = '甲'.repeat(70000)
  const book = { id: 'bk', title: 'Book', chapters: [{ title: 'One', start: 100, end: 100 + text.length }] }
  const store = {
    revision: 1,
    async load() {},
    get: id => id === 'bk' ? book : undefined,
    chapterText: async (id, chapter) => id === 'bk' && chapter === 0 ? text : undefined,
  }
  const source = createLongreadSource({ store, filePool: { paths: async () => [] }, now: () => 10 })
  const first = await source.onRequest({ name: 'chapter/read', data: {
    bookId: 'bk', chapterIndex: 0, cursor: 0, maxChars: 32768,
  } }, {})
  assert.equal(first.cursor, 0)
  assert.equal(first.chapterStart, 100)
  assert.equal(first.nextCursor, 32768)
  assert.equal(first.text.length, 32768)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 262144)
})
```

Assert the exact six-command inventory and confirmation levels; metadata-only `library/read`; `paired`/protocol v1; source registration without `webServer`; late socket injection; source/store disposal; compact revision events; and no prose, host path, stack, or import bytes in snapshots/events.

- [ ] **Step 2: Run the focused source test and observe failure**

Run: `node --test "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-longread/test/source.test.mjs"`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/host/source.js`.

- [ ] **Step 3: Write migration and stable-offset tests**

Use a fixture whose selected chapter body is `第一章\n\n甲甲\n\n乙乙\n\n丙丙` after a non-heading `front\n\n` prefix, whose v1 progress has `turnIndex:1`, and whose v1 settings use `turnChars:2`. The first group is `甲甲`, the second begins at `乙乙`, so the migrated full-book offset is `chapter.start + chapterText.indexOf('乙乙')`, not a multiplication estimate.

```js
it('migrates v1 turnIndex to the nearest paragraph-backed full-book offset once', async () => {
  const chapterText = '第一章\n\n甲甲\n\n乙乙\n\n丙丙'
  const prefix = 'front\n\n'
  const fullText = prefix + chapterText
  const book = {
    id: 'bk', title: 'Book', format: 'txt',
    chapters: [{ title: '第一章', start: prefix.length, end: fullText.length }],
  }
  await mkdir(textDir, { recursive: true })
  await writeFile(join(textDir, 'bk.txt'), fullText, 'utf8')
  await writeFile(ledger, JSON.stringify({ schemaVersion: 1, revision: 0,
    seeded: false, books: [book],
    progress: { bk: { chapterIndex: 0, turnIndex: 1, updatedAt: 9 } },
    settings: { ...defaultSettings(), turnChars: 2 } }))
  const store = new LibraryStore({ file: ledger, textDir })
  await store.load()
  const expectedOffset = book.chapters[0].start + chapterText.indexOf('乙乙')
  assert.deepEqual(store.snapshot().progress.bk, {
    chapterIndex: 0, offset: expectedOffset, updatedAt: 9,
  })
  await updateSettings(store, { turnChars: 1200 })
  assert.equal(store.snapshot().progress.bk.offset, expectedOffset)
})
```

Migration computes an honest nearest reconstructable book-global offset by loading that chapter text, calling `paragraphsOf(chapterText)` and `groupTurns(paragraphs, oldSanitizedSettings.turnChars)`, clamping `turnIndex`, then locating the first paragraph of that group in the original chapter text with a forward-only cursor. Persist `chapter.start + localMatch`: the stored offset points to that paragraph's first character in normalized full-book text (or `chapter.end` when the old index was past the last group). Heading/indent normalization makes this approximate, so test a nonzero chapter start and repeated paragraph text and document the limitation. New writes never persist `turnIndex`. Keep v1 books/text readable and bump `LIBRARY_SCHEMA_VERSION` to 2.

- [ ] **Step 4: Write upload-ticket tests**

Use a fake `issueTransfer` whose `onStart({stream,filename,signal})` feeds raw chunks to a bounded accumulator. Assert `book/import` issues `kind:'upload'`, `contentType:'application/octet-stream'`, `maxBytes:134217728`, `idleTimeoutMs:30000`, `maxDurationMs:600000`; empty/oversize/wrong type fail; the one-use handler calls `addBook` once; abort leaves no ledger row; source disposal aborts active import; successful import emits `library/changed` only after ledger commit.

- [ ] **Step 5: Write and implement the source and mutation notification seam**

Add `LibraryStore.subscribe(listener): () => void`; first test one callback per committed mutation, no callback on aborted mutation, unsubscribe/idempotent cleanup, and the exact fixed kind. Extend `mutate(mutator,{kind,bookId}={})` so a committed mutation publishes exactly one `{revision,kind,bookId,snapshot}` after persistence. `addBook`, `deleteBook`, `setProgress`, `updateSettings`, and `seedSample` pass fixed kinds `library|progress|settings` rather than inferring changes by diffing snapshots. `registerLongreadSource` maps those kinds to `library/changed`, `progress/changed`, and `settings/changed`; desktop routes continue calling the same library functions and require no SSE. Source `chapter/read` slices `store.chapterText()` directly and never calls `planChapter()`, because the public reader renders prose rather than desktop camouflage turns.

```js
export function createLongreadSource({ store, now = Date.now }) {
  return {
    id: 'dsh-plugin-longread', protocolVersion: 1, exposure: 'paired', catalog: LONGREAD_CATALOG,
    hello: async () => ({ revision: store.revision }),
    async onRequest(request, context) {
      switch (request.name) {
        case 'library/read': await store.load(); return store.snapshot()
        case 'chapter/read': return readChapterPage(store, request.data)
        case 'progress/update': return setProgress(store, { ...request.data, now })
        case 'settings/update': return updateSettings(store, request.data)
        case 'book/import': return issueBookImport(context, store, request.data, now)
        case 'book/delete': return { removed: await deleteBook(store, request.data.bookId) }
        default: throw sourceError('not_found', 'unknown Longread command')
      }
    },
  }
}
```

- [ ] **Step 6: Update route tests for schema v2 compatibility**

Desktop `/progress` may continue accepting `{turnIndex}` for existing browser compatibility, but it translates through the current chapter plan into a full-book absolute offset before `setProgress`; its response and ledger use `offset`. Add a route regression proving desktop resume remains correct after a settings change.

- [ ] **Step 7: Run Longread gates**

```powershell
$plugin = 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-longread'
npm --prefix $plugin run check
if ($LASTEXITCODE -ne 0) { throw 'Longread check failed' }
npm --prefix $plugin test
if ($LASTEXITCODE -ne 0) { throw 'Longread tests failed' }
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' diff --check -- plugins/dsh-plugin-longread
if ($LASTEXITCODE -ne 0) { throw 'Longread diff check failed' }
```

Expected: all exit 0; generated `lib/**` contains the source adapter and no runtime cross-plugin import.

- [ ] **Step 8: Commit desktop**

```powershell
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" add plugins/dsh-plugin-longread
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" commit -m "feat(longread): expose paired reader source"
```

### Task 3: Prove the Longread cross-repository vertical slice

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/agents/dsh/fixtures/longreadCatalog.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/longreadPluginFlow.spec.ts`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/reader.ts` when the flow exposes a generic reader contract defect
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/dshPlugins/transferChannel.ts` when the flow exposes a generic transfer contract defect
- Modify: `plugins/dsh-plugin-longread/src/host/source.js` when the flow exposes a Longread adapter contract defect

**Interfaces:**
- Consumes: Tasks 1–2 exact contracts.
- Produces: no new production interface; this is the cross-repository contract gate.

- [ ] **Step 1: Write the complete flow test**

Build a fake `DshBusClient` plus fake upload endpoint. Pair/catalog selection is simulated at the bus boundary, then exercise `library/read → book/import → chapter/read` twice → `progress/update → settings/update → reconnect snapshot → book/delete`. Assert page envelopes are below 262144 bytes, reconnect restores the same full-book absolute offset after `turnChars` changes, a failed upload attempts its ticket exactly once and a later explicit user retry calls `book/import` for a fresh ticket, delete invokes danger confirmation, and no code branches on `dsh-plugin-longread`.

- [ ] **Step 2: Run the focused flow and both affected suites**

```powershell
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/longreadPluginFlow.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'Longread MCode flow failed' }
npm --prefix 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-longread' test
if ($LASTEXITCODE -ne 0) { throw 'Longread plugin suite failed' }
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit
if ($LASTEXITCODE -ne 0) { throw 'MCode suite failed' }
```

Expected: PASS. This automated gate does not prove OS file-picker access; Task 10 records native import tests.

- [ ] **Step 3: Commit only contract fixes and the fixture/test**

Commit independently in whichever repository actually changed; do not combine repository histories.

### Task 4: Add binary-channel, terminal, and file-tree primitives to MCode

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/dshPlugins/binaryChannel.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/terminal.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/fileTree.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/declarative/DeclarativeTerminal.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/declarative/DeclarativeFileTree.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/services/dshPluginBinaryChannel.spec.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/declarative/terminalPresentation.spec.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/declarative/fileTreePresentation.spec.ts`

**Interfaces:**
- Consumes: foundation binary ticket authentication (`dsh-transfer-v1`, token subprotocol), Task 1 transfer client, and declared actions.
- Produces: `openBinaryChannel()`, `decodeTerminalOutputFrame()`, `spliceTerminalBytes()`, public `terminal` and `file-tree` nodes, and stable `terminal_renderer_unavailable` capability state.

- [ ] **Step 1: Write failing binary protocol tests**

```ts
import { decodeTerminalOutputFrame, spliceTerminalBytes } from '@/services/dshPlugins/binaryChannel'

test('trims replay/live overlap without decoding terminal bytes', () => {
  const live = new Uint8Array([0,0,0,0,0,0,0,3, 0x82,0xac,0x21])
  const frame = decodeTerminalOutputFrame(live)
  expect(frame.offset).toBe(3n)
  expect([...spliceTerminalBytes({ expectedOffset: 5n, frame })]).toEqual([0x21])
})
```

Add uint64 big-endian bounds, gaps returning `overflow`, exact overlap, split UTF-8 byte preservation, browser and uni socket open/message/close normalization, binary-only output, raw input, bounded resize text, token absence from URL/logs, abort, stale callback suppression, and ticket reissue-on-new-attach rather than reuse.

- [ ] **Step 2: Run the binary test and observe failure**

Run: `pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- --runTestsByPath tests/services/dshPluginBinaryChannel.spec.ts`

Expected: FAIL with missing `binaryChannel` module.

- [ ] **Step 3: Implement transport separately from rendering**

`openBinaryChannel` exposes `{send(bytes),resize(cols,rows),close(),onBytes,onOverflow}` and never imports xterm. Browser uses `WebSocket.binaryType='arraybuffer'`; uni uses `uni.connectSocket` with array-buffer enabled. Control transport remains object-only. Close/abort disposes all callbacks and buffers.

- [ ] **Step 4: Write and implement terminal presentation tests**

H5 `DeclarativeTerminal.vue` lazy-imports existing xterm lifecycle patterns from `ProjectTerminalPanel.vue`, writes raw chunks to xterm, sends resize/input through `binaryChannel`, and disposes fit/search/listeners. For non-H5 compilation paths it renders an explicit unavailable panel with server/session facts and keeps declared close/reconnect actions; it does not import DOM/xterm code.

```ts
test.each(['app-plus', 'app-harmony', 'mp-weixin'])(
  '%s does not claim terminal rendering support', target => {
    expect(terminalCapabilities(target)).toEqual({
      transport: true, renderer: false, reason: 'terminal_renderer_unavailable',
    })
  },
)
```

Do not implement a textarea pretending to be a terminal. A future native renderer can change the capability only with Task 6 device evidence.

- [ ] **Step 5: Write and implement file-tree tests**

Test normalized POSIX display paths, lazy list/search, stable node IDs, parent/child updates after create/rename/delete, 4 MiB editor threshold, text/binary distinction, upload/download progress/cancel, and danger confirmation for deletion. The component emits fixed declared command names and never resolves a desktop path locally.

- [ ] **Step 6: Run MCode tests/typecheck/builds**

Use Task 1 Step 6 commands plus the three focused files. Expected: all automated gates pass; non-H5 builds must show a compiled unsupported state, not terminal parity.

- [ ] **Step 7: Commit MCode**

```powershell
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src/services/dshPlugins/binaryChannel.ts mcode-app/src/services/declarativeUi/terminal.ts mcode-app/src/services/declarativeUi/fileTree.ts mcode-app/src/components/declarative/DeclarativeTerminal.vue mcode-app/src/components/declarative/DeclarativeFileTree.vue mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue mcode-app/tests/services/dshPluginBinaryChannel.spec.ts mcode-app/tests/components/declarative/terminalPresentation.spec.ts mcode-app/tests/components/declarative/fileTreePresentation.spec.ts
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "feat(dsh-ui): add terminal transport and file tree nodes"
```

### Task 5: Register otools-term against its existing engine

**Files:**
- Create: `plugins/dsh-plugin-otools-term/src/shared/source.js`
- Create: `plugins/dsh-plugin-otools-term/src/host/source.js`
- Create: `plugins/dsh-plugin-otools-term/src/host/source-transfer.js`
- Modify: `plugins/dsh-plugin-otools-term/src/index.js`
- Modify: `plugins/dsh-plugin-otools-term/src/host/engine.js`
- Modify: `plugins/dsh-plugin-otools-term/src/host/terminals.js`
- Modify: `plugins/dsh-plugin-otools-term/src/host/events.js`
- Create: `plugins/dsh-plugin-otools-term/test/source.test.mjs`
- Create: `plugins/dsh-plugin-otools-term/test/source-transfer.test.mjs`
- Modify: `plugins/dsh-plugin-otools-term/test/entry.test.mjs`
- Modify: `plugins/dsh-plugin-otools-term/test/host.test.mjs`
- Regenerate: `plugins/dsh-plugin-otools-term/lib/**`

**Interfaces:**
- Consumes: the one `TermEngine`, request-bound `issueTransfer`, `SessionRegistry` byte offsets/ring replay, `SftpFace`, and transfer registry.
- Produces: `TERM_SOURCE_ID`, `TERM_CATALOG`, `createTermSource({engine})`, `registerTermSource(ctx,{engine})`, and ticket handlers for terminal attach/SFTP upload/download.

- [ ] **Step 1: Write exact catalog and exclusion tests**

Pin every command from Fixed Public Source Contracts, its input schema/effect/confirmation, and public node bindings. Assert no `desktop/launch`, `__local__`, workspace path, SSH-config file, password, passphrase, key body/path, host filesystem path, or arbitrary route name enters the catalog or snapshot. Assert source registration remains optional and desktop routes still mount without `otoolsSocket`.

- [ ] **Step 2: Run source tests and observe failure**

Run: `node --test "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-term/test/source.test.mjs"`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/host/source.js`.

- [ ] **Step 3: Add real SSH terminal attach tests**

Extend the existing `test/ssh-server.mjs` harness. Open an SSH terminal through `createTermSource`, issue `terminal/attach` at offset 0, invoke the binary ticket handler, and assert its first server frame starts with offset 0; send raw `hello\r`, observe `ECHO hello`; send `{kind:'resize',cols:100,rows:30}`, observe `SIZE 100x30`; disconnect and reattach at the prior end offset without duplicate bytes. Force ring eviction and assert `{overflowed:true,startOffset>requestedOffset}`. Abort/revoke closes the socket but leaves the host session only according to the declared close action.

- [ ] **Step 4: Add real SFTP transfer tests**

Using the same SSH server, test lazy list/stat/search/read; determine control eligibility from the complete encoded response (always below 262144 bytes), with the existing 4194304-byte editor cap remaining an upper domain limit; larger responses return a download ticket. Stream raw upload chunks to a normalized remote path; download one file and a directory tar; reject `..`; enforce 2147483648 declared/streamed upload cap without allocating 2 GiB; cancel mid-stream; revoke/dispose; verify task progress contains remote display paths but no local host paths. Add `workspace/list` redaction and real recursive `workspace/upload|download` cases using `{workspaceId:'ws1',relative:'subdir'}`; assert containment, symlink policy, progress, cancellation, and absence of the resolved absolute path from public frames.

- [ ] **Step 5: Write tests and implement a raw session-listener seam**

Add `SessionRegistry.attachBytes(sessionId,{offset,onBytes,onOverflow,onClose}): disposer` backed by a new per-session listener set. Extend the real terminal test to pause attach between listener registration and replay emission, inject one chunk, and assert every byte appears exactly once and in offset order. `SessionRegistry.onOutput` appends to the ring, updates `bytesOut`, calls those listeners synchronously with the original `{offset,buffer}`, and then feeds the unchanged desktop `EventHub`. Attach flushes the desktop hub, computes retained replay start, reports overflow when the requested offset predates retained bytes, registers the live listener before emitting replay, and deduplicates overlap by offset so bytes arriving during attach are neither lost nor repeated. `finish` notifies and removes listeners; close/dispose clears them. Existing desktop hub/socket behavior remains unchanged. `source-transfer.js` converts callbacks to foundation binary frames and maps client binary/text frames to `sessions.write/resize`.

- [ ] **Step 6: Implement source request mapping**

Map fixed names directly to existing `TermEngine`, store, SFTP, workspace containment, tunnel, transfer, and AI methods. Create the engine once in `src/index.js`, then pass the same object to `registerTermRoutes` and `registerTermSource`; only the owner disposes it. Project `EventHub` changes into compact source events without terminal bytes. Reject `LOCAL_SERVER_ID` in source validation even though desktop `openTerminal()` still accepts it.

- [ ] **Step 7: Run term gates**

```powershell
$plugin = 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-term'
npm --prefix $plugin run check
if ($LASTEXITCODE -ne 0) { throw 'otools-term check failed' }
npm --prefix $plugin test
if ($LASTEXITCODE -ne 0) { throw 'otools-term tests failed' }
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' diff --check -- plugins/dsh-plugin-otools-term
if ($LASTEXITCODE -ne 0) { throw 'otools-term diff check failed' }
```

Expected: all exit 0; the existing desktop WebSocket/SSE/HTTP tests remain green and one engine owns every session/connection/task/tunnel.

- [ ] **Step 8: Commit desktop**

```powershell
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" add plugins/dsh-plugin-otools-term
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" commit -m "feat(term): expose paired terminal and file source"
```

### Task 6: Validate terminal/SFTP reachability without claiming native renderer parity

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/agents/dsh/fixtures/termCatalog.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/termPluginFlow.spec.ts`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/terminal.ts` for generic terminal contract defects exposed by the flow
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/fileTree.ts` for generic tree contract defects exposed by the flow
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/dshPlugins/binaryChannel.ts` or `transferChannel.ts` for generic channel defects exposed by the flow
- Modify: `plugins/dsh-plugin-otools-term/src/host/source.js` or `source-transfer.js` for term adapter defects exposed by the flow

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: an automated H5 contract gate and separate per-target acceptance records; it does not change support status by itself.

- [ ] **Step 1: Write the automated source-neutral flow**

Use fake control + binary endpoints to execute server list/connect → SSH terminal open/attach/replay/input/resize/overflow/reconnect → SFTP list/read/edit/upload/download/delete → tunnel/AI/task lifecycle → revoke. Assert RDP/VNC rows expose management facts but no launch action; local shell is absent; revoke closes control, binary socket, and HTTP transfers; non-H5 capability remains `renderer:false`.

- [ ] **Step 2: Run automated desktop and MCode gates**

```powershell
npm --prefix 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-term' test
if ($LASTEXITCODE -ne 0) { throw 'term plugin tests failed' }
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/termPluginFlow.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'term MCode flow failed' }
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit
if ($LASTEXITCODE -ne 0) { throw 'MCode tests failed' }
```

Expected: PASS. This proves protocol behavior and H5 renderer logic under Jest, not native rendering.

- [ ] **Step 3: Run H5 real-browser acceptance**

Against the real SSH harness or a disposable SSH host, record browser/OS/xterm versions and verify ANSI cursor motion, color, alternate screen, resize, CJK/IME input, paste, replay splice, network reconnect, transfer cancellation, and device revoke. Only this target may be marked supported by the current plan if all results pass.

- [ ] **Step 4: Record App Android, App iOS, Harmony, and Weixin separately**

For each target record device/OS, uni runtime, socket transport result, renderer backend, ANSI/alternate-screen/resize/IME/replay results, and revoke result. With the planned implementation the honest expected renderer result is `BLOCKED — no reviewed non-DOM renderer`; `uni.connectSocket` success records transport only. Keep terminal controls unavailable and leave connection/SFTP/tunnel/task features enabled. Do not write “full parity” or PASS for terminal rendering.

- [ ] **Step 5: Commit only automated fixtures/fixes**

Commit MCode and desktop changes independently. Native acceptance records belong in the existing architecture/support documentation updated in Task 10, not in generated test output.

### Task 7: Add a cross-platform SQL editor and byte-paged editable grid

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/sqlEditor.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/dataGrid.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/declarative/DeclarativeSqlEditor.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/declarative/DeclarativeDataGrid.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/declarative/sqlEditorPresentation.spec.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/declarative/dataGridPresentation.spec.ts`

**Interfaces:**
- Consumes: declared action executor and Task 1 downloads.
- Produces: public `sql-editor` and `data-grid` nodes, `serializeGridKey()`, `createGridDraft()`, `buildGridChangeSet()`, and byte-cursor page merge.

- [ ] **Step 1: Write failing SQL editor tests**

```ts
import { selectionStatement } from '@/services/declarativeUi/sqlEditor'

test('executes the selected SQL without requiring a DOM editor', () => {
  expect(selectionStatement('select 1;\nselect 2;', { start: 10, end: 19 }))
    .toBe('select 2')
})
```

Test text/selection, execute/workbench/explain actions, empty selection fallback, bounded SQL, statement-risk metadata display, server error mapping, and textarea availability on H5/App/Harmony/Weixin. Optional H5 highlighting may decorate the textarea but cannot be required for execution.

- [ ] **Step 2: Write failing grid identity/change-set tests**

```ts
import { buildGridChangeSet, serializeGridKey } from '@/services/declarativeUi/dataGrid'

test('uses typed composite keys and omits unchanged drafts', () => {
  const original = { tenant_id: null, id: 7, name: 'Ada' }
  expect(serializeGridKey(original, ['tenant_id', 'id']))
    .toBe('[{"t":"null"},{"t":"number","v":7}]')
  expect(buildGridChangeSet({ primaryKey: ['tenant_id', 'id'], originals: [original],
    drafts: new Map([[serializeGridKey(original, ['tenant_id', 'id']), { ...original }]]),
    added: [], deleted: new Set() })).toEqual({ added: [], modified: [], deleted: [] })
})
```

Add null/string/number/boolean key disambiguation, duplicate-key rejection, original/current preservation, changed-fields-only draft UI, cancel discarding edits, no-primary-key refusal for update/delete while retaining read visibility, typed null/binary/date display, next-cursor byte paging, horizontal/vertical window calculations, and oversized-result download state.

- [ ] **Step 3: Run focused tests and observe failure**

Run: `pnpm --dir "D:/Repos/xyito/lingyun/mcode/mcode-app" run test:unit -- --runTestsByPath tests/components/declarative/sqlEditorPresentation.spec.ts tests/components/declarative/dataGridPresentation.spec.ts`

Expected: FAIL for missing SQL/grid modules.

- [ ] **Step 4: Implement pure models**

```ts
export type GridScalar = null | string | number | boolean
export interface GridChangeSet<Row> {
  added: Row[]
  modified: Array<{ original: Row; current: Row }>
  deleted: Row[]
}
export function assertEditable(primaryKey: string[]): void {
  if (primaryKey.length === 0) throw new Error('primary_key_required')
}
export function serializeGridKey(row: Record<string, unknown>, primaryKey: string[]): string {
  assertEditable(primaryKey)
  return JSON.stringify(primaryKey.map(name => taggedScalar(row[name])))
}
```

The renderer never constructs SQL. It sends original/current/deleted row values through the public contract; Task 8 validates keys against real table metadata and calls existing atomic `saveTableData`.

- [ ] **Step 5: Implement cross-platform components**

Use a native textarea and ordinary scroll views/sheets; do not copy DBM CodeMirror, Element Plus, or DOM-only grid components. Fetch pages sequentially by opaque byte cursor, preserve previous rows until replacement, and cancel stale page requests on query change.

- [ ] **Step 6: Run MCode gates and commit**

Run Task 1 Step 6 commands. Expected: all exit 0. Commit:

```powershell
git -C "D:/Repos/xyito/lingyun/mcode" add mcode-app/src/services/declarativeUi/sqlEditor.ts mcode-app/src/services/declarativeUi/dataGrid.ts mcode-app/src/components/declarative/DeclarativeSqlEditor.vue mcode-app/src/components/declarative/DeclarativeDataGrid.vue mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue mcode-app/tests/components/declarative/sqlEditorPresentation.spec.ts mcode-app/tests/components/declarative/dataGridPresentation.spec.ts
git -C "D:/Repos/xyito/lingyun/mcode" commit -m "feat(dsh-ui): add SQL editor and editable data grid"
```

### Task 8: Share one DBM runtime and register its complete paired source

> **Ordering requirement:** Run Step 1 first on the untouched checkout. If it reports a missing tool, restore the repository's pinned dependencies, rerun Step 1, and record the baseline before editing any Task 8 production or test file.

**Files:**
- Create: `plugins/dsh-plugin-otools-dbm/src/host/runtime.js`
- Create: `plugins/dsh-plugin-otools-dbm/src/host/source.js`
- Create: `plugins/dsh-plugin-otools-dbm/src/host/source-transfer.js`
- Create: `plugins/dsh-plugin-otools-dbm/src/shared/source.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/index.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/routes.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/engines/sql-engine.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/tasks.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/exporter.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/importer.js`
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/dictionary.js`
- Create: `plugins/dsh-plugin-otools-dbm/test/runtime.test.mjs`
- Create: `plugins/dsh-plugin-otools-dbm/test/source.test.mjs`
- Create: `plugins/dsh-plugin-otools-dbm/test/source-transfer.test.mjs`
- Create: `plugins/dsh-plugin-otools-dbm/test/source-sqlite.test.mjs`
- Modify: `plugins/dsh-plugin-otools-dbm/test/commands.test.mjs`
- Modify: `plugins/dsh-plugin-otools-dbm/test/security.test.mjs`
- Regenerate: `plugins/dsh-plugin-otools-dbm/lib/**` (including `lib/webview/**`)

**Interfaces:**
- Consumes: existing `buildCommands(context)`, connection/task/store/scheduler classes, SQLite driver, exporter/importer/dictionary functions, and foundation `issueTransfer`.
- Produces: `createDbmRuntime({ai,emit})`, `createDbmSource({runtime})`, `classifySqlRisk(sql,{dbType})`, byte-cursor query/grid paging, upload-token import, and ticket-based artifact download.

- [ ] **Step 1: Capture the untouched DBM typecheck baseline**

```powershell
$plugin = 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-dbm'
$before = Join-Path $env:TEMP 'dsh-dbm-typecheck-before.txt'
npm --prefix $plugin run typecheck 2>&1 | Tee-Object -FilePath $before
$beforeExit = $LASTEXITCODE
$beforeDiagnostics = Get-Content $before |
  ForEach-Object { $_ -replace '\\','/' -replace '^[A-Za-z]:/[^:]+/plugins/dsh-plugin-otools-dbm/','' } |
  Where-Object { $_ -match 'error TS\d+:' } | Sort-Object -Unique
$beforeDiagnostics | Set-Content (Join-Path $env:TEMP 'dsh-dbm-typecheck-before.normalized.txt')
Set-Content (Join-Path $env:TEMP 'dsh-dbm-typecheck-before.exit.txt') $beforeExit
"beforeExit=$beforeExit diagnostics=$($beforeDiagnostics.Count)"
```

On the inspected checkout this exits 1 before compilation because `vue-tsc` is absent from `node_modules` (`npm ls vue-tsc --depth=0` reports `(empty)` and `node_modules/.bin/vue-tsc.cmd` does not exist), so no source diagnostic baseline exists yet. Restore the package-lock's pinned dependencies with `npm --prefix $plugin ci`, then rerun this step before editing; do not install an ad-hoc version. An exit-0 baseline requires exit 0 after changes; otherwise the exact normalized diagnostics are the maximum allowed post-change set.

- [ ] **Step 2: Write the shared-runtime ownership test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbmRuntime } from '../src/host/runtime.js'
import { createDbmRouteHandler } from '../src/host/routes.js'
import { createDbmSource } from '../src/host/source.js'

test('routes and source share one runtime and dispose every owner once', async () => {
  const counts = { connections: 0, tasks: 0, scheduler: 0, tunnels: 0 }
  const store = {}
  const runtime = createDbmRuntime({ ai: {}, emit: () => {}, factories: {
    connectionStore: () => store,
    connectionManager: () => ({ closeAll: async () => { counts.connections += 1 } }),
    taskManager: () => ({ disposeAll: () => { counts.tasks += 1 } }),
    scheduler: () => ({ start() {}, stop() { counts.scheduler += 1 } }),
    pluginStateStore: () => ({}), backupPlanStore: () => ({}), syncLogStore: () => ({}),
    buildCommands: () => ({}),
    closeTunnels: async () => { counts.tunnels += 1 },
  } })
  const routes = createDbmRouteHandler({ runtime })
  const source = createDbmSource({ runtime })
  assert.equal(routes.runtime, runtime)
  assert.equal(source.runtime, runtime)
  await runtime.dispose()
  await runtime.dispose()
  assert.deepEqual(counts, { connections: 1, tasks: 1, scheduler: 1, tunnels: 1 })
})
```

Run: `node --test "D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-dbm/test/runtime.test.mjs"`

Expected before implementation: FAIL with missing `runtime.js`.

- [ ] **Step 3: Extract the actual one-owner runtime**

```js
export function createDbmRuntime({ ai = {}, emit = () => {}, factories = defaultFactories } = {}) {
  const store = factories.connectionStore()
  const context = {
    store, connections: factories.connectionManager({ store }),
    tasks: factories.taskManager({ emit }), state: factories.pluginStateStore(),
    plans: factories.backupPlanStore(), syncLogs: factories.syncLogStore(), emit, ai,
  }
  const scheduler = factories.scheduler(context)
  const commands = factories.buildCommands(context)
  scheduler.start()
  let disposed = false
  return { context, commands, get disposed() { return disposed }, async dispose() {
    if (disposed) return
    disposed = true
    scheduler.stop(); context.tasks.disposeAll()
    await context.connections.closeAll(); await factories.closeTunnels()
  } }
}
```

Define `defaultFactories` in `runtime.js` from the existing classes/functions; injection exists only for deterministic ownership tests. Refactor `registerDbmRoutes(ctx,{runtime})` to own only HTTP/SSE clients and never dispose the runtime, and expose a pure `createDbmRouteHandler({runtime})` test seam. `src/index.js` creates one runtime, passes it to routes and source optional injections, and registers one Cordis cleanup that calls `runtime.dispose()`.

- [ ] **Step 4: Write exact source inventory/redaction tests**

Compare the catalog to the fixed DBM groups and to `buildCommands`: every exposed mapping names one existing capability; excluded `dbm_fs_*`, `upload_save_image`, `copy_exported_file`, and host-path parameters are absent. Assert connection results use `redactConnection`; task/event projection strips `result_path`, `file_path`, `export_path`, credentials, URLs with tokens, and absolute paths while retaining `{id,name,task_type,status,progress,created_at,updated_at,duration,error_message,safeMetadata}`. Assert unknown source names fail `not_found`, source disposal leaves desktop routes usable, reconnect in the same runtime returns current in-memory tasks, and a fresh runtime starts with none.

- [ ] **Step 5: Write parsed SQL risk tests**

```js
import { classifySqlRisk } from '../src/shared/source.js'

for (const [sql, expected] of [
  ['SELECT * FROM users', 'none'],
  ['WITH x AS (SELECT 1) SELECT * FROM x', 'none'],
  ['INSERT INTO t VALUES (1)', 'confirm'],
  ['UPDATE t SET n = 1 WHERE id = 2', 'confirm'],
  ['DELETE FROM t WHERE id = 2', 'danger'],
  ['DROP TABLE t', 'danger'],
  ['TRUNCATE TABLE t', 'danger'],
  ["SELECT 'DROP TABLE t'", 'none'],
]) test(`${sql} => ${expected}`, () => assert.equal(classifySqlRisk(sql, { dbType: 'sqlite' }), expected))
```

Use existing `splitStatements` only to find statement boundaries; add a conservative token scanner in `src/shared/source.js` that skips quoted strings, quoted identifiers, dollar bodies, and comments, tracks parenthesis depth, and classifies top-level keywords. For `WITH`, scan through CTE bodies to the outer statement (`SELECT` → `none`, `INSERT|UPDATE` → `confirm`, `DELETE` → `danger`). Read-only allowlist is `SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|TABLE`; SQLite `PRAGMA` is `none` only for an explicit read allowlist with no assignment/call argument, otherwise `danger`. `SELECT` containing known side-effect forms or any unknown/ambiguous token pattern is `danger`. The strongest statement wins and catalog labels cannot lower it. Because foundation confirmation is command-level, declare `sql/execute|workbench` at their maximum static risk `danger`; MCode shows the SQL preview/target in that standard danger dialog before dispatch. Keep `classifySqlRisk` server-side for audit metadata and to reject any future narrower alias that is declared below the parsed risk; do not add a new request-confirmation handshake outside the foundation contract.

- [ ] **Step 6: Write byte-page tests with explicit parameters/results**

Create `test/source-sqlite.test.mjs` with a real temporary SQLite database and source request context. Seed:

```sql
CREATE TABLE people (
  tenant_id TEXT,
  id INTEGER,
  name TEXT NOT NULL,
  payload BLOB,
  PRIMARY KEY (tenant_id, id)
);
```

Insert 5000 narrow rows plus one row whose `payload` is `zeroblob(300000)`. Call `grid/read` with `{connectionId,tableName:'people',cursor:null,maxRows:5000,maxBytes:196608}`. Expected first result: `rows.length < 5000`, `encodedBytes <= 196608`, non-null opaque `nextCursor`, `primaryKey:['tenant_id','id']`, no partial row. Follow cursors until `done:true`; expect exactly 5001 distinct keys. Query the 300000-byte cell alone with `sql/execute` and expect `{delivery:'download',transfer:{kind:'download',maxBytes:...}}`, not a truncated `0x…` control value. Also execute two SELECT statements and assert each result page has its own byte cursor.

To make that result possible, add `SqlEngine.runRaw(sql,options)` returning the driver's unnormalized `{columns,rows,rowCount,executionTime}` under the existing row-count cap, and `SqlEngine.tableDataRaw(...)` mirroring `tableData` pagination/count without normalizing page cells. Existing `run()`/`tableData()` delegate to these seams and preserve desktop results; only the source pager consumes raw rows, normalizes cells page-by-page, and streams a raw oversized `Buffer`/`Uint8Array` through a download ticket before `formatBuffer` can truncate it. Test desktop `run()` still emits the current 64 KiB preview while source download hashes to the original 300000 bytes.

- [ ] **Step 7: Write actual atomic grid-change tests**

Send:

```js
await source.onRequest({ name: 'grid/save', data: {
  connectionId, tableName: 'people',
  changes: {
    added: [{ tenant_id: 'a', id: 6000, name: 'new', payload: null }],
    modified: [{
      original: { tenant_id: 'a', id: 1, name: 'old', payload: null },
      current: { tenant_id: 'a', id: 1, name: 'changed', payload: null },
    }],
    deleted: [{ tenant_id: 'a', id: 2 }], validate_only: false,
  },
} }, context)
```

Expected `{inserted:1,updated:1,deleted:1}` and one committed transaction. Add null/string/number composite-key parts, unchanged modification omitted before dispatch, missing key rejection, keyless table refusal, duplicate insert rollback, `validate_only` no-write, and proof that the adapter never accepts a serialized key as SQL or builds a WHERE clause itself.

- [ ] **Step 8: Write import/export/backup/dictionary transfer tests**

Import request parameters are typed metadata (`connectionId`, database/schema/table, format, mappings) plus upload ticket; the ticket handler streams into an adapter-owned random temp file, passes that path internally to existing importer, and deletes it on completion/error/abort. Export/backup/dictionary task results retain internal paths only inside runtime state; `artifact/download {taskId}` validates task ownership/status and streams the file through a download ticket. Test 16 KiB multipart header cap/boundary splits via foundation tests, DBM byte caps, progress, cancel, retry, revocation, missing artifact, and redacted task snapshots.

- [ ] **Step 9: Implement the source adapter and byte cursor**

The cursor is base64url JSON containing source revision, result index, and next row offset; sign or bind it to an in-memory result handle so callers cannot substitute connection/table/SQL. Before adding each whole row, measure `Buffer.byteLength(JSON.stringify(candidate),'utf8')`; stop before 196608 default bytes and always leave room below the 262144 envelope cap. If one row cannot fit, serialize the complete result to a bounded temporary download and return a ticket. Never rely on row count alone.

- [ ] **Step 10: Run focused DBM tests and full plugin/typecheck gates**

```powershell
$plugin = 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-dbm'
node --test "$plugin/test/runtime.test.mjs" "$plugin/test/source.test.mjs" "$plugin/test/source-transfer.test.mjs" "$plugin/test/source-sqlite.test.mjs"
if ($LASTEXITCODE -ne 0) { throw 'DBM focused source tests failed' }
npm --prefix $plugin run check
if ($LASTEXITCODE -ne 0) { throw 'DBM check failed' }
npm --prefix $plugin test
if ($LASTEXITCODE -ne 0) { throw 'DBM tests failed' }
npm --prefix $plugin run typecheck 2>&1 | Tee-Object -FilePath (Join-Path $env:TEMP 'dsh-dbm-typecheck-after.txt')
$afterExit = $LASTEXITCODE
$afterDiagnostics = Get-Content (Join-Path $env:TEMP 'dsh-dbm-typecheck-after.txt') |
  ForEach-Object { $_ -replace '\\','/' -replace '^[A-Za-z]:/[^:]+/plugins/dsh-plugin-otools-dbm/','' } |
  Where-Object { $_ -match 'error TS\d+:' } | Sort-Object -Unique
$beforeDiagnostics = Get-Content (Join-Path $env:TEMP 'dsh-dbm-typecheck-before.normalized.txt')
$beforeExit = [int](Get-Content (Join-Path $env:TEMP 'dsh-dbm-typecheck-before.exit.txt'))
$newDiagnostics = Compare-Object $beforeDiagnostics $afterDiagnostics -PassThru |
  Where-Object { $_.SideIndicator -eq '=>' }
if ($beforeExit -eq 0 -and $afterExit -ne 0) { throw 'DBM typecheck regressed from green' }
if ($newDiagnostics.Count -gt 0) { throw "new DBM type diagnostics:`n$($newDiagnostics -join "`n")" }
```

Expected: focused/check/test exit 0 and no new normalized type diagnostics. If baseline diagnostics remain, print their exact count and report them as remaining failures. Review generated `lib/**`, including `lib/webview/**`; do not call an unchanged failure green.

- [ ] **Step 11: Commit desktop**

```powershell
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" add plugins/dsh-plugin-otools-dbm
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" diff --cached --check
git -C "D:/Repos/xyito/open/dsh-desktop-ultra" commit -m "feat(dbm): expose paired database source"
```

### Task 9: Prove the DBM mobile vertical slice with SQLite

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/agents/dsh/fixtures/dbmCatalog.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/dbmPluginFlow.spec.ts`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/sqlEditor.ts` for generic SQL contract defects exposed by the flow
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/declarativeUi/dataGrid.ts` for generic grid contract defects exposed by the flow
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/dshPlugins/transferChannel.ts` for generic transfer defects exposed by the flow
- Modify: `plugins/dsh-plugin-otools-dbm/src/host/source.js` or `source-transfer.js` for DBM adapter defects exposed by the flow

**Interfaces:**
- Consumes: Tasks 7–8.
- Produces: deterministic cross-repository flow evidence, no new production API.

- [ ] **Step 1: Write the complete fake-bus MCode flow**

Exercise connection list/open → catalog tree → `sql/execute` read → byte-paged `grid/read` → edit sheet → `grid/save` → export/download → upload/import → backup/task snapshot → reconnect within the same desktop process. Assert typed null/binary display, opaque cursor forwarding, standard command-level danger confirmation with SQL preview/target for `sql/execute|workbench`, danger prompts for DELETE/DROP/restore, no host paths, oversized download, cancel/revoke, no source-ID branch, and an empty task snapshot after a simulated desktop-process restart.

- [ ] **Step 2: Run the real SQLite source and MCode flow together**

```powershell
node --test 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-dbm/test/source-sqlite.test.mjs'
if ($LASTEXITCODE -ne 0) { throw 'real DBM SQLite source flow failed' }
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/dbmPluginFlow.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'DBM MCode flow failed' }
```

Expected results are those pinned in Task 8 Steps 5–7 and Task 9 Step 1; both commands exit 0.

- [ ] **Step 3: Run affected full suites/builds**

Run DBM check/test/typecheck comparison and Task 1 MCode gates. Expected: no new failures; App/H5/Weixin builds do not prove real database network reachability.

- [ ] **Step 4: Commit contract fixtures/fixes independently**

Use focused commits in each changed repository; never put desktop and MCode files in one commit.

### Task 10: Run seven-source acceptance and document exact support boundaries

**Files:**
- Modify: `plugins/dsh-plugin-longread/README.md`
- Modify: `plugins/dsh-plugin-otools-term/README.md`
- Modify: `plugins/dsh-plugin-otools-dbm/README.md`
- Modify: `PLUGINS.md`
- Modify: the existing MCode DSH architecture/support document required by `D:/Repos/xyito/lingyun/mcode/AGENTS.md`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/agents/dsh/fixtures/allPairedSources.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/allPluginCatalogs.spec.ts`

**Interfaces:**
- Consumes: foundation, batch one, and Tasks 1–9.
- Produces: documented release-candidate support matrix and reproducible gates; no tag or publication.

- [ ] **Step 1: Run complete desktop gates**

```powershell
$repo = 'D:/Repos/xyito/open/dsh-desktop-ultra'
npm --prefix $repo run typecheck
if ($LASTEXITCODE -ne 0) { throw 'desktop typecheck failed' }
npm --prefix $repo test
if ($LASTEXITCODE -ne 0) { throw 'desktop tests failed' }
foreach ($name in 'taskboard','canvas','repopanel','automation','otools-git','longread','otools-term','otools-dbm','mobile-bridge','otools-socket') {
  npm --prefix "$repo/plugins/dsh-plugin-$name" run check
  if ($LASTEXITCODE -ne 0) { throw "check failed: $name" }
  npm --prefix "$repo/plugins/dsh-plugin-$name" test
  if ($LASTEXITCODE -ne 0) { throw "tests failed: $name" }
}
npm --prefix $repo run pack:plugins
if ($LASTEXITCODE -ne 0) { throw 'plugin packing failed' }
foreach ($script in 'build','rust:fmt:check','rust:check','rust:test') {
  npm --prefix $repo run $script
  if ($LASTEXITCODE -ne 0) { throw "gate failed: $script" }
}
git -C $repo diff --exit-code -- ':(glob)plugins/dsh-plugin-*/lib/**'
if ($LASTEXITCODE -ne 0) { throw 'unreviewed generated lib drift' }
```

Run the DBM baseline comparison from Task 8 separately; if baseline diagnostics remain, report them verbatim as a blocker rather than overriding this gate.

- [ ] **Step 2: Run complete MCode gates**

Use Task 1 Step 6 commands and the full seven-source fixture suite. Expected: all automated commands exit 0 and fixture rendering contains no source-ID conditionals.

- [ ] **Step 3: Run real Longread, SFTP, and DBM transfer acceptance**

On each available target, record target/runtime/device and connection URL class without secrets. Import a TXT and EPUB, page/read/save/reconnect/delete; upload/download/cancel an SFTP file; execute a SQLite read/edit plus export/download and import/cancel. During every large transfer send a small control request and verify it responds without waiting for transfer completion.

- [ ] **Step 4: Run terminal acceptance using Task 6's matrix**

H5 must pass the real xterm checks before support is documented. Android/iOS/Harmony/Weixin terminal transport and renderer are separate columns. If no reviewed non-DOM renderer exists, document renderer `unsupported/unverified`, not parity; keep verified file/connection functions listed separately.

- [ ] **Step 5: Revoke during every channel kind**

Revoke the device during Longread upload, SFTP upload/download, DB artifact download/import, and terminal binary stream. Expected: control socket, HTTP transfer, and binary socket close; consumed tickets cannot restart; refresh fails; UI returns to re-pair; host domain operation reports cancellation/cleanup without leaking temp paths.

- [ ] **Step 6: Document the final limitations exactly**

State: Canvas has no mobile page; mobile cannot launch desktop RDP/VNC; local shell is not exposed; H5 cannot downgrade an HTTPS page to LAN HTTP/WS; mini-program HTTPS/WSS domains need platform registration; App/Harmony/mini-program terminal rendering is unavailable until a non-DOM renderer passes device acceptance; successful builds or `uni.connectSocket` alone are not parity evidence. List DBM typecheck baseline diagnostics if any and mark unavailable native devices/domains as BLOCKED.

- [ ] **Step 7: Commit documentation/tests in each repository**

Use focused `test:`/`docs:` commits in their respective repositories. Do not tag, publish, create a release, or claim unsupported native acceptance.

## Execution Readiness

The automated implementation tasks are execution-ready once the prerequisite plans are implemented. No implementation, tests, builds, or device acceptance were run while authoring this document. The following are explicit safety constraints or acceptance blockers, not unspecified coding work:

- SQL safety requires the conservative scanner and static-max-risk catalog described in Task 8; `splitStatements` alone is not a semantic parser, so ambiguous statements deliberately remain `danger`.
- DBM lossless oversized-cell delivery requires the Task 8 `SqlEngine.runRaw`/`tableDataRaw` seams; existing `run()` truncates binary display values above 64 KiB and cannot be used as the source stream.
- Longread v1 migration uses the paragraph/group reconstruction specified in Task 2. Because old ledgers contain only a turn index, heading/whitespace normalization makes the result nearest-reconstructable rather than exact and tests preserve that wording.
- Workspace transfers remain in scope only through registered `workspaceId` and contained `relative` paths. Before Task 5 implementation, add Windows junction and POSIX symlink escape cases to `source-transfer.test.mjs`; resolve each existing path with `realpath`, resolve the nearest existing parent before creating a destination, and reject any result outside the registered workspace. Never return the resolved path.
- Non-H5 terminal renderer delivery is deliberately unavailable in this plan. Android/iOS/Harmony and mini-program acceptance requires a separately reviewed non-DOM renderer; transport builds do not satisfy rendering parity.
- DBM baseline capture occurs before Task 8. Run the lockfile-pinned `npm ci` if the local `vue-tsc` binary is absent, then execute the normalized comparison; dependency restoration failure is BLOCKED, not a skipped typecheck.

Proceed task-by-task. Mark unavailable native renderer/device/domain or unrestored DBM dependencies BLOCKED at their acceptance step; do not weaken or skip the gate.
