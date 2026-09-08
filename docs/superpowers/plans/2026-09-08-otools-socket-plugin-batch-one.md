# DSH Mobile Plugin Batch One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Taskboard, RepoPanel, Automation, and otools-git complete mobile workflows through public source and declarative UI contracts.

**Architecture:** Each desktop plugin registers one explicit `paired` source with versioned commands, a bounded snapshot, compact revisioned events, and a public declarative catalog. HTTP routes and the source adapter call the same transport-neutral operation service; MCode renders reusable Kanban, collection, tree, Diff, log, and form nodes without source-ID branches.

**Tech Stack:** Node.js 22 ESM, Cordis `otoolsSocket`, `node:test`, Vue 3, TypeScript, uni-app, Jest.

**Spec:** `docs/superpowers/specs/2026-09-07-otools-socket-shared-bus-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-09-08-otools-socket-foundation.md` in both repositories, including foundation Tasks 1, 3, 6, 9, and 10. The imports named below are planned foundation exports, not current-main files.

## Global Constraints

- Work in two independent repositories: desktop `D:/Repos/xyito/open/dsh-desktop-ultra` and MCode `D:/Repos/xyito/lingyun/mcode`; commit each independently.
- Use only foundation `ctx.otoolsSocket.registerSource()` and declarative UI v1; never add business switches to bus core.
- All four sources explicitly use `exposure: 'paired'`; Canvas remains `internal`.
- Every source fixes `protocolVersion: 1`, command names, closed input schemas, response byte bounds, and catalog tests.
- Renderer nodes are public and third-party usable; no source-ID branches, private plugin pages, remote HTML, JavaScript, templates, or expressions.
- Never expose arbitrary HTTP, Git argv, repository filesystem root/path selection, Git config key, environment, author override, `noVerify`, `allowEmpty`, or a benign command carrying a `force` selector.
- Every command declares `effect: 'read'|'write'` and `confirmation: 'none'|'confirm'|'danger'`; destructive, force, push, discard, trust, and delete forms cannot suppress confirmation.
- Effective UI confirmation is the stricter of catalog command metadata and the action declaration.
- Control frames remain at most 256 KiB. Catalog UI remains at most 512 KiB. Page/chunk large text by UTF-8 bytes; use foundation transfer tickets for binary or file-like payloads; never silently truncate a detail.
- Cursor-bearing adapters encode the source snapshot revision. A stale cursor fails with `conflict`; the client restarts at the first page.
- One source failure cannot close the shared connection or affect another source. Source errors expose stable codes and safe messages, never paths, stacks, tokens, passwords, or Authorization values.
- Preserve every existing desktop HTTP route and behavior. HTTP and source adapters call shared operation functions, not one another.
- Published plugin tarballs remain self-contained. Every desktop task runs the plugin build and commits regenerated `lib/**` with its `src/**` change.
- Every MCode task that changes code or tests also creates a concise, runtime-timestamped note under `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/`; each task below supplies its exact topic suffix and complete note text, and its commit command captures the generated path.
- Validate MCode with Jest, `vue-tsc`, H5, App, and Weixin builds after renderer changes.
- TDD each reviewable task: add the shown failing test, run the exact focused command and observe the stated failure, implement minimally, run affected/full gates, then commit.

---

## Shared Adapter Types and Bounds

Create one local `src/shared/source.js` per plugin. Do not create a runtime shared package. Each module exports its source ID, protocol version, command catalog, and bounded schema constants. Use the foundation shapes verbatim:

```js
const command = (name, effect, confirmation, properties, required = []) => ({
  name,
  effect,
  confirmation,
  input: {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  },
})

// Adapter entry: onRequest returns business data, not a response envelope.
ctx.inject(['otoolsSocket'], (socketCtx) => {
  const registration = socketCtx.otoolsSocket.registerSource({
    id: SOURCE_ID,
    protocolVersion: 1,
    exposure: 'paired',
    catalog: SOURCE_CATALOG,
    hello: () => operations.snapshot(),
    onRequest: ({ name, data }, requestContext) => operations.execute(name, data, requestContext),
  })
  const unsubscribe = operations.subscribe((event) => {
    registration.emit(event.name, event.data, event.priority)
  })
  return () => {
    unsubscribe()
    registration.dispose()
  }
})
```

All list cursors use this JSON payload encoded as base64url; command services reject malformed cursors and a revision mismatch with source code `conflict`:

```js
export function encodeCursor({ revision, offset }) {
  return Buffer.from(JSON.stringify({ revision, offset }), 'utf8').toString('base64url')
}

export function decodeCursor(value, revision) {
  if (value === undefined) return 0
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw Object.assign(new Error('cursor is invalid'), { code: 'invalid_input' })
  }
  if (!Number.isInteger(parsed?.offset) || parsed.offset < 0) {
    throw Object.assign(new Error('cursor offset is invalid'), { code: 'invalid_input' })
  }
  if (parsed.revision !== revision) {
    throw Object.assign(new Error('cursor revision is stale'), { code: 'conflict' })
  }
  return parsed.offset
}
```

Use these batch-one bounds in command schemas and result builders:

| Constant | Exact value | Applies to |
|---|---:|---|
| `LIST_LIMIT_DEFAULT` | 50 | Taskboard, RepoPanel, Automation list commands |
| `LIST_LIMIT_MAX` | 100 | Taskboard board and RepoPanel lists |
| `RUN_LIST_LIMIT_MAX` | 200 | Automation `run/list` |
| `BULK_ITEMS_MAX` | 100 | Taskboard bulk commands |
| `TEXT_PAGE_MAX_BYTES` | 196608 | Git Diff/log/text chunks and Automation run output chunks |
| `LOG_SNAPSHOT_MAX_ROWS` | 200 | Git reconnect operation log snapshot |
| `SOURCE_EVENT_MAX_BYTES` | 32768 | Adapter-authored event data before the bus envelope |
| `PATH_ITEMS_MAX` | 500 | Typed Git path-list mutations; paths are repository-relative only |

Every adapter test defines `utf8Bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')` and asserts bounded results/events against these constants.

## Exact RepoPanel Command Contract

RepoPanel keeps the existing forge behavior and only replaces transport syntax. Parameters are exact; result shapes deliberately mirror the current operation-layer values except where this table removes a large body or secret.

| Command | Effect / confirmation | Exact input | Exact success result |
|---|---|---|---|
| `workspace/list` | read / none | `{}` | `{items:[{id,title}]}`; filesystem paths are omitted |
| `repo/read` | read / none | `{workspaceId}` | `{workspace:{id,title},remote:null|{provider,host,ownerRepo,webUrl,supported}}`; no local path or token |
| `identity/read` | read / none | `{workspaceId}` | `null|{login,name,avatarUrl}` from the current forge client |
| `label/list` | read / none | `{workspaceId}` | `{items:[{name,color,description}]}` |
| `item/list` | read / none | `{workspaceId,tab,state,search?,labels?,assignedToMe?,sort?,cursor?,limit?}` | `{revision,items:[ItemSummary],links,nextCursor}`; `tab:'issues'|'prs'`, `state:'open'|'closed'|'all'`, `sort:'newest'|'oldest'|'recently_updated'|'least_recently_updated'`, distinct labels max 50, limit 1–100; `ItemSummary` omits body |
| `item/count` | read / none | same filters as `item/list` except cursor/limit | `{count:number|null}` |
| `item/read` | read / none | `{workspaceId,kind,number}` | `{item:ItemDetail,link:null|TaskLink}`; `kind:'issue'|'pr'`, positive integer number; full body only here |
| `comment/list` | read / none | `{workspaceId,number,cursor?,limit?}` | `{items:[Comment],nextCursor}`; limit 1–100; comments only here, not in `item/read` |
| `settings/read` | read / none | `{scope?}` | `{scope:'global'|workspaceId,own:null|PanelSettings,effective:PanelSettings,language}` |
| `credential/list` | read / none | `{}` | `{hosts:string[],env:string[]}`; metadata only |
| `comment/create` | write / confirm | `{workspaceId,number,body}` | created forge comment; body 1–65536 chars |
| `item/set-state` | write / confirm | `{workspaceId,kind,number,action}` | updated item; `action:'close'|'reopen'` |
| `issue/create` | write / confirm | `{workspaceId,title,body?,labels?}` | created issue; title 1–256, body ≤65536, distinct labels max 50 |
| `task/start` | write / confirm | `{workspaceId,kind,number,scenario?,writeback?,instruction?}` | `{outcome:'created'|'duplicate',task,link}`; scenario is `fix|plan_first|review_fix|review_only`; no caller `force` field—duplicate is returned, not overridden remotely |
| `settings/update` | write / confirm | `{scope?,settings}` | `{scope:'global'|workspaceId,own:null|PanelSettings,effective:PanelSettings}`; `settings:null` is allowed only for a workspace and removes its override |
| `credential/save` | write / confirm | `{host,token}` | `{hosts:string[],env:string[]}`; token never returned/emitted/logged |
| `credential/delete` | write / danger | `{host}` | `{hosts:string[],env:string[]}` |

`ItemSummary` is exactly `{kind:'issue'|'pr',number,title,state,author,updatedAt,htmlUrl,labels,isDraft?,commentsCount?}`; `ItemDetail` is the existing forge item projected to those fields plus `{body,createdAt,assignees,milestone,baseBranch?,headBranch?,mergeable?}`; `Comment` is `{id,author,body,createdAt,updatedAt,htmlUrl?}`. `TaskLink` is the existing stored link projected to `{taskId,status,taskTitle,scenario,writeback,url}`. Unknown provider fields are dropped at the operation boundary.

`PanelSettings` is exactly `{defaultIssueScenario,defaultPrScenario,writebackDefault,scenarioPrompts}` as normalized by existing `normalizePanelSettings()`. RepoPanel preserves current source error codes `invalid_input`, `not_found`, `no_remote`, `unsupported_host`, `no_account`, `forge_error`, `forbidden`, `rate_limited`, and `internal`; add `conflict` to `src/shared/source.js` for stale source cursors without changing the legacy HTTP protocol constants. Messages crossing the bus must replace local filesystem paths and credential details with safe text.

## Exact Automation Command Contract

| Command | Effect / confirmation | Exact input | Exact success result |
|---|---|---|---|
| `automation/read` | read / none | `{id?}` | with no id: `{revision,settings,automations:[AutomationSummary],engine}`; with id: `{automation}` or `not_found`; summaries omit prompt text |
| `template/list` | read / none | `{}` | `{items:AUTOMATION_TEMPLATES}` |
| `workspace/list` | read / none | `{}` | `{items:[{id,title}]}`; paths omitted |
| `schedule/preview` | read / none | `{kind,cron?,intervalMinutes?,count?}` | existing `{valid,text,next,message?}`; kind `manual|interval|cron`, count 1–10 |
| `run/list` | read / none | `{automationId,cursor?,limit?}` | `{revision,items:[RunSummary],nextCursor}`; limit 1–200; no output/error body |
| `run/read` | read / none | `{id,field?,cursor?}` | `{run:RunSummary,chunk?,nextCursor?}`; `field:'output'|'error'` pages UTF-8 text at 196608 bytes; without field returns summary only |
| `automation/create` | write / confirm | `{draft}` | `{automation}` after existing `normalizeDraft()` |
| `automation/update` | write / confirm | `{id,ifVersion,draft}` | `{automation}`; `ifVersion` positive integer required |
| `automation/enable` | write / confirm | `{id,ifVersion}` | `{automation}` |
| `automation/disable` | write / none | `{id,ifVersion}` | `{automation}` |
| `automation/delete` | write / danger | `{id,ifVersion}` | `{id}`; cancels a live run first, preserving current route behavior |
| `automation/run` | write / danger | `{id}` | `{run:null|RunSummary}` |
| `run/cancel` | write / confirm | `{runId}` | `{run:RunSummary}` |
| `settings/update` | write / confirm | `{settings}` | `{settings}` after existing `normalizeSettings()` |

`draft` is the existing closed semantic shape `{name,prompt,schedule,action,enabled?,usePreamble?,catchUp?,overlap?,note?,workspaceId?}`. `schedule` is `{kind:'manual'}|{kind:'interval',intervalMinutes}|{kind:'cron',cron}`; `action` is `{kind:'headless',timeoutMinutes?}|{kind:'taskboard'}`; overlap is exactly `skip|cancel`. The schema enumerates these fields and forbids extra properties. `AutomationSummary` is exactly `{id,name,schedule,action,enabled,usePreamble,catchUp,overlap,note?,workspaceId?,version,createdAt,updatedAt,nextRunAt?,failureCount?}` with `prompt` removed. `RunSummary` is exactly `{id,automationId,automationName?,status,trigger,createdAt,startedAt?,finishedAt?,durationMs?,workspaceId?,errorPreview?,outputPreview?}`; previews are the existing bounded settlement previews, while full `output` and `error` are available only through `run/read`. Events are only `automation/changed` with `{revision,kind,id?}` and `run/settled` with `{revision,run:RunSummary}`; current runner output is settlement-only, so this plan does not invent live stdout.

## Exact otools-git Command Contract

Every Git command identifies a repository by `workspaceId`. The service resolves it through the existing workspace registry; no source command accepts `root`, absolute worktree paths, arbitrary Git paths outside a resolved repository, argv, environment, or an arbitrary config key. Results are existing domain records with filesystem roots/binary paths and credential values removed. Fixed reads:

| Command | Confirmation | Exact input |
|---|---|---|
| `repo/list` | none | `{}` |
| `preferences/read` | none | `{workspaceId?}` | `{revision,preferences}`; `preferences` is `PrefsStore.snapshot()` with only the requested workspace override plus global keys |
| `repo/status` | none | `{workspaceId,untracked?,ignored?}` with `untracked:'all'|'normal'|'no'` | existing `readStatus()` result without `root`; `{name,branch,detached,upstream,ahead,behind,oid,shortOid,headSubject,headAuthor,headDate,unborn,stashCount,repoState,groups,counts}` |
| `repo/children` | none | `{workspaceId}` | `{submodules:[{path,url?,branch?,status?}],worktrees:[{id,branch?,head?,locked?,prunable?}]}`; absolute worktree paths are replaced by source-scoped opaque IDs |
| `conflict/read` | none | `{workspaceId,path}` | existing `{base?,ours?,theirs?}` conflict stages |
| `file/read` | none | `{workspaceId,path}` | `{text,encoding:'utf8',truncated:false}` or `{binary:true,bytes}`; if UTF-8 text exceeds 196608 bytes return `{cursor,chunk,nextCursor}` pages |
| `diff/summary` | none | `{workspaceId,source}` with `source:{kind:'worktree'|'staged'|'head'}|{kind:'commit',rev}|{kind:'range'|'two-dot',from,to}` | `{files:[{path,origPath?,status,similarity?,additions,deletions,binary,image}],stat}` |
| `diff/read` | none | `{workspaceId,source,path,origPath?,context?,ignoreWhitespace?,ignoreBlankLines?,wordDiff?,cursor?}` | `{lines:[{kind,text,oldNo?,newNo?}],binary,empty,truncated,chunkCursor?,nextCursor?}`; existing classified lines, paged by encoded UTF-8 bytes |
| `diff/image` | none | `{workspaceId,source,path,origPath?}`; returns transfer descriptor, never inline base64 | `{before?:TransferDescriptor,after?:TransferDescriptor}` where each descriptor is `{url,kind:'download',expiresAt,contentType,maxBytes}` |
| `history/list` | none | `{workspaceId,cursor?,limit?,branch,includeRemote?,path?,filters?}`; limit is one of `50|100|200|500` | `{rows:[HistoryRow],hasMore,nextCursor?}` from existing `readHistory()`; cursor replaces exposed numeric offset |
| `history/tips` | none | `{workspaceId,includeRemote?}` | `{branches:Record<string,string>,tags:Record<string,string>}` |
| `commit/read` | none | `{workspaceId,rev,cursor?}` | `{commit:HistoryRow,diff?:{lines,binary,empty,truncated},nextCursor?}`; commit metadata plus paged commit Diff |
| `file/history` | none | `{workspaceId,path,limit?}` | `{rows:[HistoryRow]}` |
| `file/blame` | none | `{workspaceId,path,rev?}` | `{rows:[{oid,shortOid,author,date,summary,line,text}]}` |
| `branch/list` | none | `{workspaceId,includeRemote?}` | `{items:[BranchRow]}`; `BranchRow` is current `listBranches()` output without `worktreePath`, replaced by `worktreeId?` |
| `branch/mergeable` | none | `{workspaceId}` | `{items:string[]}` |
| `tag/list` | none | `{workspaceId}` | `{items:[{name,oid,target,shortTarget,annotated,subject,tagger?,date}]}` |
| `stash/list` | none | `{workspaceId}` | `{items:[{ref,index,message,branch?,oid?,date?}]}` |
| `stash/files` | none | `{workspaceId,ref}` | `{items:[{path,origPath?,status,additions,deletions,binary,image}]}` |
| `stash/diff` | none | `{workspaceId,ref,path?,cursor?}` | `{lines:[{kind,text,oldNo?,newNo?}],binary,empty,truncated,chunkCursor?,nextCursor?}` |
| `remote/list` | none | `{workspaceId}` | `{items:[{name,fetchUrl?,pushUrl?,url?,host?}]}` |
| `remote/branches` | none | `{workspaceId,remote}` | `{items:string[]}` |
| `push/defaults` | none | `{workspaceId}` | `{localBranch,remote?,targetBranch,trackingRef?,hasTracking,remotes:[{name,fetchUrl?,pushUrl?,url?,host?}]}` |
| `pull/defaults` | none | `{workspaceId}` | `{remote?,sourceBranch?,trackingRef?,localBranch?,remotes:[{name,fetchUrl?,pushUrl?,url?,host?}]}` |
| `config/read` | none | `{workspaceId}`; only existing `EDITABLE_KEYS` | `{entries:Record<EditableKey,{local?,global?,effective?}>}` |
| `identity/read` | none | `{workspaceId}` | current `{localName?,localEmail?,globalName?,globalEmail?,useGlobal,effectiveName?,effectiveEmail?,configured}` |
| `credential/list` | none | `{}`; host/source metadata only | `{hosts:string[],env:string[]}` |
| `operation/list` | none | `{}` | `{items:[OperationSummary]}`; summary omits `root`, `command`, full log, partial, and credential-bearing result text |
| `operation/read` | none | `{id,cursor?}`; log rows paged/bounded | `{operation:OperationSummary,rows:string[],partial?,truncated,nextCursor?}`; partial/log page ≤196608 bytes |
| `install/read` | none | `{}`; omit `binaryPath` | `{installed,version,os,tooOld?,message}` |
| `ai/availability` | none | `{}` | existing availability object, with no provider credential values |
| `ssh/inspect` | none | `{host,port?}` | `{host,port,displayHost?,status,keyType?,fingerprint?,entry?}`; omit `knownHostsPath` |

Fixed mutations and risks:

| Command | Confirmation | Exact input | Exact success result |
|---|---|---|---|
| `preferences/update` | none | `{workspaceId?,patch}`; keys are the existing preference allowlist only | `{revision,preferences}` |
| `index/stage` | none | `{workspaceId,paths}` | `{staged:number}` |
| `index/stage-all` | none | `{workspaceId}` | `{ok:true}` |
| `index/unstage` | none | `{workspaceId,paths}` | `{unstaged:number}` |
| `index/unstage-all` | none | `{workspaceId}` | `{ok:true}` |
| `conflict/resolve` | confirm | `{workspaceId,paths,side}` with `side:'ours'|'theirs'|'union'|'mark'` | `{resolved:number,side?:'ours'|'theirs'|'union'}` |
| `commit/create` | confirm | `{workspaceId,message,signoff?}` | `{oid,shortOid,subject}` |
| `commit/amend` | danger | `{workspaceId,message,signoff?}`; separate from normal commit | `{oid,shortOid,subject}` |
| `ai/commit-message` | none | `{workspaceId,style?,language?,hint?,source?}` | `{operation:OperationSummary}` |
| `branch/create` | confirm | `{workspaceId,name,startPoint?,checkout?}` | `{name,checkedOut}` |
| `branch/create-force` | danger | `{workspaceId,name,startPoint?,checkout?}`; no `force` field | `{name,checkedOut}` |
| `branch/checkout` | confirm | `{workspaceId,name,newBranch?,detach?,track?}` | `{ok:true}` |
| `branch/checkout-force` | danger | `{workspaceId,name,newBranch?,detach?,track?}`; no `force` field | `{ok:true}` |
| `branch/rename` | confirm | `{workspaceId,from,to}` | `{name}` |
| `branch/rename-force` | danger | `{workspaceId,from,to}`; no `force` field | `{name}` |
| `branch/delete` | danger | `{workspaceId,names}`; non-force only | `{deleted:string[]}` |
| `branch/delete-force` | danger | `{workspaceId,names}`; invokes existing delete with `force:true` | `{deleted:string[]}` |
| `branch/set-upstream` | confirm | `{workspaceId,branch,upstream?}` | `{branch,upstream?}` |
| `branch/delete-remote` | danger | `{workspaceId,remote,branch}` | `{operation:OperationSummary}` |
| `merge/run` | confirm | `{workspaceId,ref,mode,noCommit?,message?}` | `{ok,conflict}` |
| `rebase/run` | danger | `{workspaceId,ref,onto?,autostash?}` | `{ok,conflict}` |
| `sequencer/run` | danger | `{workspaceId,operation,action}`; `operation:'merge'|'rebase'|'cherry-pick'|'revert'`, `action:'continue'|'abort'|'skip'|'quit'` with existing merge restrictions | `{ok,conflict}` |
| `reset/soft` | danger | `{workspaceId,ref}` | `{mode:'soft'}` |
| `reset/mixed` | danger | `{workspaceId,ref}` | `{mode:'mixed'}` |
| `reset/keep` | danger | `{workspaceId,ref}` | `{mode:'keep'}` |
| `reset/hard` | danger | `{workspaceId,ref}` | `{mode:'hard'}` |
| `cherry-pick/run` | danger | `{workspaceId,revs,noCommit?,mainline?}` | `{ok,conflict}` |
| `revert/run` | danger | `{workspaceId,revs,noCommit?,mainline?}` | `{ok,conflict}` |
| `tag/create` | confirm | `{workspaceId,name,target?,message?,sign?}` | `{name}` |
| `tag/create-force` | danger | `{workspaceId,name,target?,message?,sign?}`; no `force` field | `{name}` |
| `tag/delete` | danger | `{workspaceId,names}` | `{deleted:string[]}` |
| `tag/delete-remote` | danger | `{workspaceId,remote,names}` | `{operation:OperationSummary}` |
| `stash/create` | confirm | `{workspaceId,message?,includeUntracked?,keepIndex?,paths?}` | `{noChanges:boolean}` |
| `stash/create-all` | danger | `{workspaceId,message?,includeUntracked?,keepIndex?,paths?}`; invokes existing create with `all:true` | `{noChanges:boolean}` |
| `stash/apply` | confirm | `{workspaceId,ref,restoreIndex?}` | `{ok,conflict}` |
| `stash/pop` | danger | `{workspaceId,ref,restoreIndex?}` | `{ok,conflict}` |
| `stash/branch` | confirm | `{workspaceId,ref,branch}` | `{branch}` |
| `stash/clear` | danger | `{workspaceId}` | `{ok:true}` |
| `remote/add` | confirm | `{workspaceId,name,url}` | `{name,url}` |
| `remote/rename` | confirm | `{workspaceId,from,to}` | `{name}` |
| `remote/remove` | danger | `{workspaceId,name}` | `{removed:string}` |
| `remote/set-url` | confirm | `{workspaceId,name,url,which?}` with `which:'both'|'fetch'|'push'` | `{name,url}` |
| `fetch/run` | none | `{workspaceId,remote?,all?,prune?,tags?}` | `{operation:OperationSummary}` |
| `pull/run` | confirm | `{workspaceId,remote?,branch?,mode?,autostash?,prune?,tags?}` | `{operation:OperationSummary}` |
| `push/run` | danger | `{workspaceId,remote,localBranch?,remoteBranch?,setUpstream?,followTags?,tags?,dryRun?}` | `{operation:OperationSummary}` |
| `push/force-with-lease` | danger | `{workspaceId,remote,localBranch?,remoteBranch?,setUpstream?,followTags?,tags?,dryRun?}`; no `forceMode` field | `{operation:OperationSummary}` |
| `push/force` | danger | `{workspaceId,remote,localBranch?,remoteBranch?,setUpstream?,followTags?,tags?,dryRun?}`; no `forceMode` field | `{operation:OperationSummary}` |
| `remote/prune` | confirm | `{workspaceId,remote}` | `{operation:OperationSummary}` |
| `submodule/update` | confirm | `{workspaceId,path?,recursive?,remote?}` | `{operation:OperationSummary}` |
| `submodule/update-force` | danger | `{workspaceId,path?,recursive?,remote?}`; no `force` field | `{operation:OperationSummary}` |
| `submodule/add` | confirm | `{workspaceId,url,path,branch?}` | `{operation:OperationSummary}` |
| `submodule/remove` | danger | `{workspaceId,path}` | `{removed:string}` |
| `submodule/sync` | confirm | `{workspaceId,path?}` | `{ok:true}` |
| `worktree/add` | confirm | `{workspaceId,relativePath,mode,branch?,startPoint?}`; adapter resolves below an approved workspace-owned worktree parent | `{worktreeId}` |
| `worktree/add-force` | danger | `{workspaceId,relativePath,mode,branch?,startPoint?}`; no `force` field | `{worktreeId}` |
| `worktree/remove` | danger | `{workspaceId,worktreeId}`; ID must come from `repo/children` | `{removed:worktreeId}` |
| `worktree/remove-force` | danger | `{workspaceId,worktreeId}`; invokes existing remove with `force:true` | `{removed:worktreeId}` |
| `worktree/lock` | confirm | `{workspaceId,worktreeId,lock?,reason?}` | `{worktreeId,locked}` |
| `worktree/prune` | danger | `{workspaceId}` | `{ok:true}` |
| `identity/update-local` | confirm | `{workspaceId,name?,email?}` | `{identity}` |
| `identity/update-global` | danger | `{name?,email?}` | `{identity}` |
| `config/update-local` | confirm | `{workspaceId,entries:[{key,value?}]}`; key enum is `EDITABLE_KEYS` | `{entries:[{key,scope:'local',value?}]}` |
| `config/update-global` | danger | `{workspaceId,entries:[{key,value?}]}`; key enum is `EDITABLE_KEYS` | `{entries:[{key,scope:'global',value?}]}` |
| `safe-directory/add` | danger | `{workspaceId,workspaceIds}`; resolves only known workspaces | `{added:number}` |
| `credential/save` | confirm | `{host,username,password}`; result metadata only | `{hosts,env}` |
| `credential/delete` | danger | `{host}` | `{hosts,env}` |
| `ssh/trust` | danger | `{host,port?}` | `{host,port,displayHost?,status:'trusted',keyType?,fingerprint?,entry?}` |
| `operation/cancel` | confirm | `{id}` | `{operation:OperationSummary}` |
| `index/discard` | danger | `{workspaceId,tracked?,untracked?,staged?}` | `{discarded:number}` |
| `index/discard-all` | danger | `{workspaceId,includeUntracked?,includeIgnored?}` | `{ok:true}` |

`HistoryRow` is the existing `parseRecord()` projection `{hash,shortHash,parents,authorName,authorEmail,authorDate,committerName,committerEmail,committerDate,subject,body,refs}`. `BranchRow` is exactly the current `listBranches()` projection with `worktreePath` removed and optional `worktreeId` substituted. `OperationSummary` is `{id,kind,title,status,percent,phase,truncated,startedAt,finishedAt,error?,cancelable}`; its error is reduced to `{code,message,dubious?}` after path/credential redaction. `TransferDescriptor` is the foundation `issueTransfer()` return shape. Every mutation result uses the exact projection in its table row. Fields named `output`, `root`, absolute host paths, `command`, credentials, and raw network text never cross the source boundary.

All `paths`, `names`, `revs`, `entries`, and `workspaceIds` arrays are nonempty and bounded (`paths` at most 500; other arrays at most 100); normalize each through the current protocol/config allowlists. `commit/create` and `commit/amend` intentionally omit `allowEmpty`, `noVerify`, `resetAuthor`, `authorName`, and `authorEmail`. Normal and force commands call the existing primitive with the fixed boolean chosen by the command name.

---

### Task 1: Add public Kanban and neutral collection primitives to MCode

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/agents/dsh/ui/nodes/{types,kanban,collections}.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeKanban.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeVirtualList.vue`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeFilters.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/DshDeclarativeRenderer.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/agents/dsh/ui/schema.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/dsh/declarative/kanbanPresentation.spec.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/pluginRendererContract.spec.ts`
- Create at execution time using Step 6: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-public-kanban-collections.md`

**Interfaces:**
- Consumes foundation `executeDeclaredAction()` and `DshBusClient.request()`.
- Produces UI v1 nodes `kanban`, `virtual-list`, `filters`, `search`, and `bulk-actions` in the existing foundation schema namespace.
- `KanbanModel` consumes declared columns/items and returns ordered groups plus an explicit unmatched group; action bindings remain data, never executable expressions.

- [ ] **Step 1: Write the failing Kanban model tests**

```ts
import { groupKanban, serializeFilterValues } from '@/agents/dsh/ui/nodes/kanban'

test('preserves declared order and retains unknown-column cards', () => {
  const cards = [
    { key: '2', column: 'done', title: 'B' },
    { key: '1', column: 'todo', title: 'A' },
    { key: '3', column: 'removed', title: 'C' },
  ]
  const result = groupKanban([
    { id: 'todo', title: 'Todo' },
    { id: 'done', title: 'Done' },
  ], cards)
  expect(result.groups.map(group => group.items.map(item => item.key))).toEqual([['1'], ['2']])
  expect(result.unmatched).toEqual([cards[2]])
})

test('serializes only declared filter fields', () => {
  expect(serializeFilterValues(
    [{ name: 'state', kind: 'select' }, { name: 'query', kind: 'search' }],
    { state: 'open', query: 'bug', injected: 'drop-me' },
  )).toEqual({ state: 'open', query: 'bug' })
})
```

- [ ] **Step 2: Write the failing renderer/action contract tests**

Jest uses `testEnvironment:'node'` and the repository intentionally has no `@vue/test-utils`; do not add that dependency. Test public renderer wiring by scanning the `.vue` source and test behavior in pure TypeScript. Put the executable tests below in `pluginRendererContract.spec.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { resolveActionConfirmation } from '@/agents/dsh/ui/actions'
import { validateUiNode } from '@/agents/dsh/ui/schema'
import { buildDeclaredActionRequest } from '@/agents/dsh/ui/nodes/collections'

const renderer = fs.readFileSync(
  path.resolve(__dirname, '../../../src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue'),
  'utf8',
)

test('registers public collection nodes without source-id branches', () => {
  for (const name of ['kanban', 'virtual-list', 'filters', 'search', 'bulk-actions']) {
    expect(renderer).toContain(name)
  }
  expect(renderer).not.toContain('dsh-plugin-taskboard')
})

test('rejects duplicate IDs and keeps effective danger risk', () => {
  expect(() => validateUiNode({
    type: 'kanban',
    columns: [{ id: 'todo', title: 'Todo' }, { id: 'todo', title: 'Again' }],
    itemsPointer: '/items',
  })).toThrow()
  expect(resolveActionConfirmation({
    command: { effect: 'write', confirmation: 'danger' },
    action: { confirmation: 'none' },
  })).toBe('danger')
})

test('binds only declared fields', () => {
  expect(buildDeclaredActionRequest(
    { command: 'task/bulk-move', bindings: { items: '/selected', status: '/target' } },
    { selected: [{ id: '1', expectedVersion: 2 }], target: 'done', injected: 'drop' },
  )).toEqual({
    command: 'task/bulk-move',
    data: { items: [{ id: '1', expectedVersion: 2 }], status: 'done' },
  })
})
```

The Kanban pure model test from Step 1 covers unmatched cards; add pure collection-state cases for empty, next-cursor, and truncated states. Source scanning pins the component registry and visible unsupported-column label; pure action tests pin the exact one-command/declared-field request that the components emit.

- [ ] **Step 3: Run focused tests and observe failure**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit -- --runTestsByPath tests/components/dsh/declarative/kanbanPresentation.spec.ts tests/pages/connection-detail/pluginRendererContract.spec.ts
```

Expected: FAIL because the node model/components and schema node types do not exist.

- [ ] **Step 4: Implement the minimal public nodes**

```ts
export interface KanbanColumn { id: string; title: string }
export interface KanbanItem {
  key: string
  column: string
  title: string
  subtitle?: string
  badges?: Array<{ text: string; tone?: string }>
  data?: unknown
}

export function groupKanban(columns: KanbanColumn[], items: KanbanItem[]) {
  const groups = columns.map(column => ({ ...column, items: [] as KanbanItem[] }))
  const byId = new Map(groups.map(group => [group.id, group]))
  const unmatched: KanbanItem[] = []
  for (const item of items) (byId.get(item.column)?.items ?? unmatched).push(item)
  return { groups, unmatched }
}
```

Keep grouping/filter/action mapping in pure TypeScript. Vue wrappers render and emit only. Do not import Taskboard types. Add schema cases to the existing foundation `src/agents/dsh/ui/schema.ts`; do not create a second UI schema validator.

- [ ] **Step 5: Run focused and full MCode validation**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit -- --runTestsByPath tests/components/dsh/declarative/kanbanPresentation.spec.ts tests/pages/connection-detail/pluginRendererContract.spec.ts
pnpm --dir $app run test:unit
pnpm --dir $app exec vue-tsc --noEmit -p tsconfig.json
pnpm --dir $app run build:h5
pnpm --dir $app exec uni build -p app
pnpm --dir $app run build:mp-weixin
```

Expected: all PASS.

- [ ] **Step 6: Write the architecture note and commit MCode**

```powershell
$repo = 'D:/Repos/xyito/lingyun/mcode'
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-public-kanban-collections.md"
@'
# DSH public Kanban and collection nodes

Adds source-neutral Kanban, virtual-list, filter, search, and bulk-action UI v1 nodes. Pure TypeScript models own grouping and field serialization; Vue components only render and emit declared actions. Unknown columns remain visible, command risk cannot be downgraded, and native clients can reproduce the same ordered grouping/action contract without plugin-specific branches.
'@ | Set-Content -Path (Join-Path $repo $note) -Encoding utf8
git -C $repo add mcode-app/src/agents/dsh/ui mcode-app/src/components/dsh mcode-app/tests/components/dsh mcode-app/tests/pages/connection-detail $note
git -C $repo commit -m 'feat(dsh-ui): add public kanban and collection nodes'
```

### Task 2: Register the complete Taskboard paired source

**Files:**
- Create: `plugins/dsh-plugin-taskboard/src/shared/source.js`
- Create: `plugins/dsh-plugin-taskboard/src/host/operations.js`
- Create: `plugins/dsh-plugin-taskboard/src/host/source.js`
- Modify: `plugins/dsh-plugin-taskboard/src/index.js`
- Modify: `plugins/dsh-plugin-taskboard/src/host/routes.js`
- Modify: `plugins/dsh-plugin-taskboard/src/host/store.js`
- Create: `plugins/dsh-plugin-taskboard/test/source.test.mjs`
- Create: `plugins/dsh-plugin-taskboard/test/entry.test.mjs`
- Modify: `plugins/dsh-plugin-taskboard/test/protocol.test.mjs`
- Modify: `plugins/dsh-plugin-taskboard/test/host.test.mjs`
- Regenerate: `plugins/dsh-plugin-taskboard/lib/**`

**Interfaces:**
- Produces source `dsh-plugin-taskboard`, protocol v1, paired exposure, and commands `board/read`, `workspace/list`, `task/read`, `task/create`, `task/update`, `task/comment`, `task/move`, `task/reject`, `task/delete`, `task/bulk-move`, `task/bulk-delete`.
- `board/read` input is `{cursor?,limit?,workspaceId?,query?,includeCanceled?}`; limit 1–100/default 50. Result is `{revision,items:TaskSummary[],nextCursor?}` with summaries only. `task/read` is `{id}` and returns `{task}` with the full current record.
- `task/create` accepts `{draft:{title,description?,prompt?,workspaceId?}}`; `task/update` accepts `{id,expectedVersion,patch:{title?,description?,prompt?,workspaceId?}}`; all nested objects are closed schemas.
- `task/comment` accepts `{id,expectedVersion,text}` with 1–4000 characters. The source adds a version guard even though the legacy HTTP composer does not send one; both call the same internal operation with the guard optional for HTTP and required for source.
- `task/move` accepts `{id,expectedVersion,status}` where status is `todo|queued|preparing|running|awaiting_input|review|failed|done|canceled` (the user source never accepts `merging`). `task/reject` accepts `{id,expectedVersion,reason?}` and maps `reason` to the existing optional rejection comment. `task/delete` is `{id,expectedVersion}`.
- Bulk move is `{items:[{id,expectedVersion}],status}` with the same status enum. Bulk delete is `{items:[{id,expectedVersion}]}`. Both accept 1–100 distinct IDs, validate every row/transition/deletion guard against one revision, then commit once; any stale or invalid row rejects the whole call.
- Results: workspace list `{items:[{id,title}]}`; create/update/comment/move/reject return `{task}` with the full current record; delete returns `{id}`; bulk returns `{revision,items:[TaskSummary]}`. `TaskSummary` is the existing `summarizeTask()` shape.
- Emits `task/changed` with `{revision,kind,tasks:[TaskSummary]}`; never full prompt/comments.

- [ ] **Step 1: Write the failing command/catalog tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_CATALOG, TASKBOARD_COMMANDS } from '../src/shared/source.js'

test('taskboard catalog fixes command names and risks', () => {
  assert.deepEqual(Object.fromEntries(TASKBOARD_COMMANDS.map(row => [row.name, row.confirmation])), {
    'board/read': 'none', 'workspace/list': 'none', 'task/read': 'none',
    'task/create': 'none', 'task/update': 'none', 'task/comment': 'none',
    'task/move': 'confirm', 'task/reject': 'confirm', 'task/delete': 'danger',
    'task/bulk-move': 'confirm', 'task/bulk-delete': 'danger',
  })
  assert.equal(SOURCE_CATALOG.uiVersion, 1)
  assert.equal(JSON.stringify(SOURCE_CATALOG).includes('dsh-plugin-taskboard'), false)
})
```

Add concrete request tests using a temporary `TaskStore`: create two versioned tasks, assert `board/read` omits `prompt` and comments, `task/read` includes them, and `task/bulk-delete` with one stale version leaves both tasks present and rejects `{code:'conflict'}`.

- [ ] **Step 2: Add lifecycle, bound, and error tests**

Use a fake context with `inject()` and fake `otoolsSocket.registerSource()`. Assert registration works without `webServer`, disposer unsubscribes and disposes only its source, a 300 KiB prompt does not enter snapshot/event, a malformed/stale cursor fails safely, event JSON is ≤32768 bytes, and thrown errors do not contain the ledger path or stack.

- [ ] **Step 3: Run the focused test and observe failure**

```powershell
node --test 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-taskboard/test/source.test.mjs'
```

Expected: FAIL because `src/shared/source.js`, `src/host/operations.js`, and `src/host/source.js` do not exist.

- [ ] **Step 4: Implement one operation service and atomic bulk writes**

Move transport-neutral route bodies into `createTaskboardOperations({store,workspaces,now})`. `routes.js` maps HTTP payloads to methods; `source.js` maps command data to the same methods. Add one queued `store.mutateMany()` transaction that validates every `(id,expectedVersion)` against one ledger snapshot, mutates a clone, increments revision once, persists once, then swaps state and emits one `LedgerChange`; never loop public single-item mutation methods.

- [ ] **Step 5: Run plugin and desktop validation**

```powershell
$root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
npm --prefix "$root/plugins/dsh-plugin-taskboard" run check
npm --prefix "$root/plugins/dsh-plugin-taskboard" test
npm --prefix $root test
```

Expected: all PASS and regenerated `lib/**` present.

- [ ] **Step 6: Commit desktop**

```powershell
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' add plugins/dsh-plugin-taskboard
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' commit -m 'feat(taskboard): expose complete paired kanban source'
```

### Task 3: Validate the Taskboard mobile vertical slice

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/fixtures/dsh-plugins/taskboard.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/taskboardPluginWorkflow.spec.ts`
- Test-authorized follow-up files after the Step 2 failure identifies a contract mismatch: MCode UI v1 renderer files from Task 1 and Taskboard source/catalog files from Task 2
- Create using Step 5: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-taskboard-workflow.md`

**Interfaces:**
- Consumes Tasks 1–2.
- Produces a neutral fixture-driven reference workflow with no source-ID branching.
- Tests use pure `validateCatalog`, `buildPageModel`, `buildDeclaredActionRequest`, and `reducePluginEvent` helpers from the foundation/batch-one UI service; Jest does not mount Vue components.

- [ ] **Step 1: Write the end-to-end declarative workflow test**

```ts
import { buildPageModel, reducePluginEvent } from '@/agents/dsh/ui/runtime'
import { buildDeclaredActionRequest } from '@/agents/dsh/ui/nodes/collections'
import { taskboardFixture, taskboardResponses } from '../../fixtures/dsh-plugins/taskboard'

it('executes the complete Taskboard fixture through public runtime helpers', () => {
  const neutral = { ...taskboardFixture, id: 'example.board' }
  const page = buildPageModel(neutral, 'board', taskboardResponses)
  expect(page.nodes.find(node => node.type === 'kanban')?.columns).toHaveLength(4)

  const cases = [
    ['task/read', { id: 'task-1' }],
    ['task/create', { draft: { title: 'New task', workspaceId: 'ws-1' } }],
    ['task/update', { id: 'task-1', expectedVersion: 1, patch: { title: 'Renamed' } }],
    ['task/comment', { id: 'task-1', expectedVersion: 2, text: 'Checked' }],
    ['task/reject', { id: 'task-1', expectedVersion: 3, reason: 'Please revise' }],
    ['task/bulk-move', { items: [{ id: 'task-1', expectedVersion: 4 }], status: 'done' }],
    ['task/bulk-delete', { items: [{ id: 'task-1', expectedVersion: 5 }] }],
  ] as const
  expect(cases.map(([command, data]) => buildDeclaredActionRequest(
    neutral.actions[command], data,
  ))).toEqual(cases.map(([command, data]) => ({ command, data })))
  expect(neutral.commands.find(row => row.name === 'task/bulk-move')?.confirmation).toBe('confirm')
  expect(neutral.commands.find(row => row.name === 'task/bulk-delete')?.confirmation).toBe('danger')

  expect(reducePluginEvent(page, { kind: 'overflow', source: neutral.id }))
    .toEqual({ refresh: { command: 'board/read', data: {} } })
  expect(reducePluginEvent(page, { kind: 'source-removed', source: neutral.id }))
    .toEqual({ close: true })
})
```

The fixture exports complete catalog, response, and action maps as ordinary TypeScript objects. It includes four columns, a detail record, create/update/comment/move/reject/bulk actions, and a stale revision. Repeat the assertions with the production source ID and neutral source ID to prove the runtime has no ID branch.

- [ ] **Step 2: Run the focused test and observe failure**

```powershell
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/taskboardPluginWorkflow.spec.ts
```

Expected: FAIL until the fixture and any missing generic renderer plumbing exist.

- [ ] **Step 3: Make only contract-level fixes and rerun**

Do not add `if (sourceId === 'dsh-plugin-taskboard')`. Express any failure-driven renderer correction in UI v1 schema/types and keep the neutral-ID assertion. A green test requires only the fixture/test deliverable; a red test authorizes the narrow file listed above that owns the mismatched contract.

- [ ] **Step 4: Run both repository suites**

```powershell
npm --prefix 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-taskboard' test
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/taskboardPluginWorkflow.spec.ts
```

- [ ] **Step 5: Write the MCode note and commit the test deliverable; commit a desktop correction only when Step 2 produced one**

```powershell
$repo = 'D:/Repos/xyito/lingyun/mcode'
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-taskboard-workflow.md"
@'
# DSH Taskboard catalog workflow

Pins the mobile Taskboard vertical slice to public UI v1 nodes and declared bus actions. The fixture covers versioned CRUD, confirmed bulk moves, dangerous bulk deletes, revision refresh after overflow, and the same behavior under a neutral source ID. Native clients should treat overflow as a fresh board read and must preserve command confirmation metadata.
'@ | Set-Content -Path (Join-Path $repo $note) -Encoding utf8
git -C $repo add mcode-app/tests/fixtures/dsh-plugins/taskboard.ts mcode-app/tests/pages/connection-detail/taskboardPluginWorkflow.spec.ts $note
# Add any generic renderer files actually changed, then:
git -C $repo commit -m 'test(dsh-ui): cover taskboard catalog workflow'
```

When Step 2 required a Taskboard catalog correction, stage only the corrected desktop files and commit them separately as `fix(taskboard): align mobile catalog contract`. Never create an empty correction commit.

### Task 4: Add public tree, unified Diff, and bounded log nodes

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/agents/dsh/ui/nodes/{tree,diff,log}.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/{DshDeclarativeTree,DshDeclarativeDiff,DshDeclarativeLog}.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/dsh/declarative/DshDeclarativeNodeRenderer.vue`
- Modify: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/agents/dsh/ui/schema.ts`
- Reuse: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/components/GitDiffViewer.vue`
- Reuse: `D:/Repos/xyito/lingyun/mcode/mcode-app/src/services/projectGit.ts` (`buildGitDiffView`), not `projectFiles.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/components/dsh/declarative/{treePresentation,diffPresentation,logPresentation}.spec.ts`
- Create at execution time using Step 5: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-public-tree-diff-log.md`

**Interfaces:**
- Tree maps lazy expansion to one declared request and stable node IDs.
- Diff accepts `{kind:'unified',text}` or `{kind:'files',files}` and maps unified text through existing `buildGitDiffView()` into `GitDiffViewer` input.
- Log accepts `{rows,cursor,truncated}` plus append deltas, retains at most the declaration's `maxRows` (hard schema maximum 1000), deduplicates cursors, and renders plain text.

- [ ] **Step 1: Write the failing pure-model tests**

```ts
import { mergeLogPage } from '@/agents/dsh/ui/nodes/log'
import { toGitDiffFiles } from '@/agents/dsh/ui/nodes/diff'

test('unified and structured diffs normalize to the same public view', () => {
  const unified = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
  const parsed = toGitDiffFiles({ kind: 'unified', text: unified })
  expect(toGitDiffFiles({ kind: 'files', files: parsed })).toEqual(parsed)
})

test('log append deduplicates cursor and keeps the newest bounded rows', () => {
  const first = mergeLogPage({ rows: [], seenCursors: new Set() }, { cursor: '1', rows: ['a', 'b'] }, 3)
  const duplicate = mergeLogPage(first, { cursor: '1', rows: ['a', 'b'] }, 3)
  expect(duplicate.rows).toEqual(['a', 'b'])
  const next = mergeLogPage(duplicate, { cursor: '2', rows: ['c', 'd'] }, 3)
  expect(next.rows).toEqual(['b', 'c', 'd'])
})
```

Add tree tests asserting only declared fields enter the lazy request, binary Diff renders a transfer state, and log text is escaped rather than interpreted as markup.

- [ ] **Step 2: Run focused tests and observe failure**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit -- --runTestsByPath tests/components/dsh/declarative/treePresentation.spec.ts tests/components/dsh/declarative/diffPresentation.spec.ts tests/components/dsh/declarative/logPresentation.spec.ts
```

Expected: FAIL for missing node modules/components/schema cases.

- [ ] **Step 3: Implement pure adapters and thin components**

Import `buildGitDiffView` from `@/services/projectGit`. Do not copy `parse-diff`, project navigation, file creation/preview, forge controls, or Git command logic into public nodes.

- [ ] **Step 4: Run full MCode validation**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit
pnpm --dir $app exec vue-tsc --noEmit -p tsconfig.json
pnpm --dir $app run build:h5
pnpm --dir $app exec uni build -p app
pnpm --dir $app run build:mp-weixin
```

Expected: all PASS.

- [ ] **Step 5: Write the architecture note and commit MCode**

```powershell
$repo = 'D:/Repos/xyito/lingyun/mcode'
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-public-tree-diff-log.md"
@'
# DSH public tree, Diff, and log nodes

Adds source-neutral lazy trees, unified/structured Diff normalization, and bounded append-only logs to declarative UI v1. Unified Diff reuses projectGit's parser and GitDiffViewer; log cursors deduplicate replay and retain a declared row bound; binary content uses transfer state. Native implementations should preserve stable node IDs, plain-text rendering, and byte/cursor semantics.
'@ | Set-Content -Path (Join-Path $repo $note) -Encoding utf8
git -C $repo add mcode-app/src/agents/dsh/ui mcode-app/src/components/dsh mcode-app/tests/components/dsh $note
git -C $repo commit -m 'feat(dsh-ui): add public tree diff and log nodes'
```

### Task 5: Register the complete RepoPanel paired source

**Files:**
- Create: `plugins/dsh-plugin-repopanel/src/shared/source.js`
- Create: `plugins/dsh-plugin-repopanel/src/host/operations.js`
- Create: `plugins/dsh-plugin-repopanel/src/host/source.js`
- Modify: `plugins/dsh-plugin-repopanel/src/index.js`
- Modify: `plugins/dsh-plugin-repopanel/src/host/routes.js`
- Create: `plugins/dsh-plugin-repopanel/test/source.test.mjs`
- Modify: `plugins/dsh-plugin-repopanel/test/entry.test.mjs`
- Modify: `plugins/dsh-plugin-repopanel/test/routes.test.mjs`
- Modify: `plugins/dsh-plugin-repopanel/test/protocol.test.mjs`
- Regenerate: `plugins/dsh-plugin-repopanel/lib/**`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/fixtures/dsh-plugins/repopanel.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/repopanelPluginWorkflow.spec.ts`
- Create at execution time using Step 7: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-repopanel-workflow.md`

**Interfaces:**
- Implements the exact RepoPanel table above.
- The operation service accepts an explicit request capability `{taskboardBase}` for `task/start`; it does not require/fabricate a Node HTTP request.
- Only durable settings/link changes emit `repopanel/changed` with `{revision,kind,workspaceId?,sourceKey?}`. External forge data is read on demand. Credentials are metadata-only.

- [ ] **Step 1: Write the failing table-driven source tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { REPOPANEL_COMMANDS } from '../src/shared/source.js'

test('RepoPanel command schemas and risks are exact', () => {
  const byName = Object.fromEntries(REPOPANEL_COMMANDS.map(command => [command.name, command]))
  assert.deepEqual(Object.keys(byName), [
    'workspace/list','repo/read','identity/read','label/list','item/list','item/count',
    'item/read','comment/list','settings/read','credential/list','comment/create',
    'item/set-state','issue/create','task/start','settings/update','credential/save','credential/delete',
  ])
  assert.equal(byName['credential/save'].confirmation, 'confirm')
  assert.equal(byName['credential/delete'].confirmation, 'danger')
  assert.equal(Object.hasOwn(byName['task/start'].input.properties, 'force'), false)
  assert.equal(byName['item/list'].input.additionalProperties, false)
})
```

Add fake forge/taskboard clients and assert every table input maps to the existing normalized method arguments and exact result shape. In particular: list body omitted; detail body present; comments paged separately; duplicate `task/start` returns duplicate; fenced prompt ordering is unchanged; credential token is absent from result, emitted event, and serialized catalog.

- [ ] **Step 2: Add lifecycle/event/bounds tests**

Assert optional source registration works without `webServer`, disposer leaves routes alive, only settings/link commits emit invalidation, a stale cursor returns `conflict`, rows/events fit their limits, and route/source errors redact workspace paths and tokens.

- [ ] **Step 3: Run focused tests and observe failure**

```powershell
node --test 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-repopanel/test/source.test.mjs'
```

Expected: FAIL because source and operation modules do not exist.

- [ ] **Step 4: Extract transport-neutral operations and register the source**

Move `contextOf`, filter normalization, list/count/detail/comment/settings/credential methods, and `start` into `createRepoPanelOperations()`. The HTTP adapter supplies `taskboardBaseFrom(req)`; the source adapter receives the equivalent loopback base/capability from plugin setup. Neither adapter calls the other's transport handler.

- [ ] **Step 5: Write and run the neutral MCode workflow test**

```ts
import { buildDeclaredActionRequest, redactActionTrace } from '@/agents/dsh/ui/nodes/collections'
import { buildPageModel } from '@/agents/dsh/ui/runtime'
import { repopanelFixture, repopanelResponses } from '../../fixtures/dsh-plugins/repopanel'

it('keeps RepoPanel secret input write-only', () => {
  const fixture = { ...repopanelFixture, id: 'example.forge' }
  const request = buildDeclaredActionRequest(fixture.actions['credential/save'], {
    host: 'github.com', token: 'secret-token', injected: 'drop',
  })
  expect(request).toEqual({
    command: 'credential/save', data: { host: 'github.com', token: 'secret-token' },
  })
  expect(redactActionTrace(request, fixture.commands)).toEqual({
    command: 'credential/save', data: { host: 'github.com', token: '[REDACTED]' },
  })
  const page = buildPageModel(fixture, 'accounts', repopanelResponses)
  expect(JSON.stringify(page)).not.toContain('secret-token')
  expect(JSON.stringify(repopanelResponses['credential/save'])).toBe('{"hosts":["github.com"],"env":[]}')
})
```

In the same file, build list/detail/comment/settings page models and assert list items omit `body`, detail contains it, comments are separately paged, and every action maps to the exact table command.

Run:

```powershell
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/repopanelPluginWorkflow.spec.ts
```

- [ ] **Step 6: Run complete affected validation**

```powershell
$root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
npm --prefix "$root/plugins/dsh-plugin-repopanel" run check
npm --prefix "$root/plugins/dsh-plugin-repopanel" test
npm --prefix $root test
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/repopanelPluginWorkflow.spec.ts
```

Expected: all PASS.

- [ ] **Step 7: Write the architecture note and commit each repository**

```powershell
$desktop = 'D:/Repos/xyito/open/dsh-desktop-ultra'
$mcode = 'D:/Repos/xyito/lingyun/mcode'
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-repopanel-workflow.md"
@'
# DSH RepoPanel mobile workflow

The RepoPanel paired source exposes bounded forge list/detail/comment/settings/task operations through closed command schemas. Forge bodies and comments are detail reads, credentials are write-only, and task-start prompt fencing remains host-owned. The MCode fixture uses only public declarative nodes; native clients can reproduce it by honoring paging, confirmation, and secret-redaction contracts.
'@ | Set-Content -Path (Join-Path $mcode $note) -Encoding utf8
git -C $desktop add plugins/dsh-plugin-repopanel
git -C $desktop commit -m 'feat(repopanel): expose paired forge source'
git -C $mcode add mcode-app/tests/fixtures/dsh-plugins/repopanel.ts mcode-app/tests/pages/connection-detail/repopanelPluginWorkflow.spec.ts $note
git -C $mcode commit -m 'test(dsh-ui): cover forge catalog workflow'
```

### Task 6: Register the complete Automation paired source

**Files:**
- Create: `plugins/dsh-plugin-automation/src/shared/source.js`
- Create: `plugins/dsh-plugin-automation/src/host/operations.js`
- Create: `plugins/dsh-plugin-automation/src/host/source.js`
- Modify: `plugins/dsh-plugin-automation/src/index.js`
- Modify: `plugins/dsh-plugin-automation/src/host/routes.js`
- Create: `plugins/dsh-plugin-automation/test/source.test.mjs`
- Modify: `plugins/dsh-plugin-automation/test/routes.test.mjs`
- Modify: `plugins/dsh-plugin-automation/test/engine.test.mjs`
- Modify: `plugins/dsh-plugin-automation/test/protocol.test.mjs`
- Modify: `plugins/dsh-plugin-automation/test/entry.test.mjs`
- Regenerate: `plugins/dsh-plugin-automation/lib/**`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/fixtures/dsh-plugins/automation.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/automationPluginWorkflow.spec.ts`
- Create at execution time using Step 5: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-automation-workflow.md`

**Interfaces:**
- Implements the exact Automation table above.
- Snapshot and `run/list` return compact summaries; only explicit `run/read` text pages return settled output/error.
- Shares existing engine/store semantics and does not claim live stdout.

- [ ] **Step 1: Write failing source contract tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTOMATION_COMMANDS } from '../src/shared/source.js'

test('automation risks preserve safe disable and dangerous run-now/delete', () => {
  const risk = Object.fromEntries(AUTOMATION_COMMANDS.map(row => [row.name, row.confirmation]))
  assert.equal(risk['automation/disable'], 'none')
  assert.equal(risk['automation/enable'], 'confirm')
  assert.equal(risk['run/cancel'], 'confirm')
  assert.equal(risk['automation/run'], 'danger')
  assert.equal(risk['automation/delete'], 'danger')
})
```

Using the current in-memory store/engine fakes, execute every command table row. Assert `automation/read` summaries omit prompt, `run/list` omits output/error, `run/read` reconstructs a multibyte string across 196608-byte chunks without data loss, and events carry revision/summary only.

- [ ] **Step 2: Run focused test and observe failure**

```powershell
node --test 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-automation/test/source.test.mjs'
```

Expected: FAIL because source and operation modules do not exist.

- [ ] **Step 3: Extract operations and register beside web routes**

Create `createAutomationOperations({store,engine,workspaces,now})`; make HTTP and source adapters call it. Keep `previewSchedule()` as the single schedule arithmetic implementation. Register source independently of `webServer` injection. Project store changes into bounded `automation/changed` and settled summaries only.

- [ ] **Step 4: Add the MCode fixture workflow test**

```ts
import { resolveActionConfirmation } from '@/agents/dsh/ui/actions'
import { buildDeclaredActionRequest } from '@/agents/dsh/ui/nodes/collections'
import { automationFixture } from '../../fixtures/dsh-plugins/automation'

it('keeps disable unconfirmed and run-now/delete dangerous', () => {
  const risk = (name: string) => resolveActionConfirmation({
    command: automationFixture.commands.find(row => row.name === name)!,
    action: automationFixture.actions[name],
  })
  expect(risk('automation/disable')).toBe('none')
  expect(risk('automation/run')).toBe('danger')
  expect(risk('automation/delete')).toBe('danger')
  expect(buildDeclaredActionRequest(automationFixture.actions['automation/run'], {
    id: 'a1', injected: 'drop',
  })).toEqual({ command: 'automation/run', data: { id: 'a1' } })
})
```

Also build the forms/log/history page models from fixture responses, assert `run/list` carries no full output/error, and reconstruct the `run/read` chunk pages into their original multibyte text.

Run:

```powershell
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/automationPluginWorkflow.spec.ts
```

- [ ] **Step 5: Run affected suites, write the note, and commit both repositories**

```powershell
$root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
$mcode = 'D:/Repos/xyito/lingyun/mcode'
npm --prefix "$root/plugins/dsh-plugin-automation" run check
npm --prefix "$root/plugins/dsh-plugin-automation" test
npm --prefix $root test
pnpm --dir "$mcode/mcode-app" run test:unit -- --runTestsByPath tests/pages/connection-detail/automationPluginWorkflow.spec.ts
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-automation-workflow.md"
@'
# DSH Automation mobile workflow

The paired Automation source shares the desktop scheduler/store operations and exposes compact automation/run summaries. Settled output and errors are explicit byte-paged reads; no live stdout is claimed. Declarative actions keep disable unconfirmed, configuration/cancel confirmed, and run-now/delete dangerous. Native clients should follow the same summary/detail and confirmation split.
'@ | Set-Content -Path (Join-Path $mcode $note) -Encoding utf8
git -C $root add plugins/dsh-plugin-automation
git -C $root commit -m 'feat(automation): expose complete paired source'
git -C $mcode add mcode-app/tests/fixtures/dsh-plugins/automation.ts mcode-app/tests/pages/connection-detail/automationPluginWorkflow.spec.ts $note
git -C $mcode commit -m 'test(dsh-ui): cover automation catalog workflow'
```

Expected: all tests PASS before commits.

### Task 7: Factor otools-git into a fixed typed source service

**Files:**
- Create: `plugins/dsh-plugin-otools-git/src/shared/source.js`
- Create: `plugins/dsh-plugin-otools-git/src/host/service.js`
- Create: `plugins/dsh-plugin-otools-git/src/host/source.js`
- Modify: `plugins/dsh-plugin-otools-git/src/index.js`
- Modify: `plugins/dsh-plugin-otools-git/src/host/routes.js`
- Modify: `plugins/dsh-plugin-otools-git/src/host/actions.js`
- Modify: `plugins/dsh-plugin-otools-git/src/host/ops.js`
- Modify: `plugins/dsh-plugin-otools-git/src/host/config.js`
- Modify: `plugins/dsh-plugin-otools-git/src/host/workspaces.js` to add source-scoped opaque worktree IDs and contained-ID resolution
- Create: `plugins/dsh-plugin-otools-git/test/source.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/host.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/ops.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/security.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/protocol.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/entry.test.mjs`
- Modify: `plugins/dsh-plugin-otools-git/test/client-mirror.test.mjs`
- Regenerate: `plugins/dsh-plugin-otools-git/lib/**`

**Interfaces:**
- Implements every read and mutation in the exact otools-git tables above; command names are the API, not HTTP paths.
- Produces events `operation/progress`, `operation/log`, `operation/settled`, and `repo/invalidated`; reconnect snapshot contains current operations and at most 200 log rows each.
- Uses foundation download tickets for image previews. Diff/log text uses UTF-8 byte cursors and 196608-byte chunks.

- [ ] **Step 1: Write the authoritative command/risk/schema test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GIT_COMMANDS } from '../src/shared/source.js'

test('git source has no generic execution or hidden destructive selectors', () => {
  const byName = Object.fromEntries(GIT_COMMANDS.map(command => [command.name, command]))
  for (const forbidden of ['git/run', 'http/request', 'config/set']) assert.equal(byName[forbidden], undefined)
  for (const command of GIT_COMMANDS) {
    const keys = Object.keys(command.input.properties)
    for (const key of ['argv','root','environment','noVerify','allowEmpty','authorName','authorEmail','force','forceMode']) {
      assert.equal(keys.includes(key), false, `${command.name} exposes ${key}`)
    }
  }
  assert.equal(byName['commit/create'].confirmation, 'confirm')
  assert.equal(byName['commit/amend'].confirmation, 'danger')
  assert.equal(byName['push/run'].confirmation, 'danger')
  assert.equal(byName['reset/hard'].confirmation, 'danger')
  assert.equal(byName['ssh/trust'].confirmation, 'danger')
})
```

Add an expected object containing every command→confirmation pair from this document and `assert.deepEqual(actual, expected)`. Assert every schema has `additionalProperties:false`; every repository operation requires `workspaceId`; `config/update-*` key enum equals `EDITABLE_KEYS`; normal/force command pairs do not expose a force parameter.

- [ ] **Step 2: Write behavior, paging, transfer, and security tests**

Use temporary real repositories for stage/unstage/discard/commit/ref/merge/rebase/reset/stash/remote/submodule/worktree cases. Stub network operations and credentials. For every command pair assert the fixed boolean passed to the existing primitive. Add these concrete boundary checks:

```js
test('diff cursor reconstructs UTF-8 text without splitting a code point', async () => {
  const text = `${'行🙂\n'.repeat(70000)}`
  const pages = await readAll(cursor => service.execute('diff/read', {
    workspaceId: 'ws-1', source: 'staged', path: 'a.txt', cursor,
  }))
  assert.equal(pages.map(page => page.chunk).join(''), text)
  assert.ok(pages.every(page => Buffer.byteLength(page.chunk, 'utf8') <= 196608))
})

test('image preview is a device-bound transfer descriptor', async () => {
  const issued = []
  const result = await service.execute('diff/image', {
    workspaceId: 'ws-1', source: 'head', path: 'logo.png',
  }, { issueTransfer: spec => { issued.push(spec); return { url: '/transfer/t1', kind: 'download' } } })
  assert.deepEqual(result, { url: '/transfer/t1', kind: 'download' })
  assert.equal(issued[0].contentType, 'image/png')
})
```

Assert credentials never appear in operation logs/events/snapshots; rejected `relativePath` cannot escape approved workspace parents; unknown worktree IDs, config keys, and absolute paths fail `invalid_input`; cancellation settles once.

- [ ] **Step 3: Run focused tests and observe failure**

```powershell
node --test 'D:/Repos/xyito/open/dsh-desktop-ultra/plugins/dsh-plugin-otools-git/test/source.test.mjs'
```

Expected: FAIL because `src/shared/source.js`, `src/host/service.js`, and `src/host/source.js` do not exist.

- [ ] **Step 4: Refactor HTTP and source around one typed service**

Create `createGitService({prefs,repos,operations,credentialsFile,ai,now})`. Move GET operation bodies out of `routes.js` and mutation operation bodies out of `actions.js` into named service methods. HTTP routes keep compatibility mapping, including old hidden commit fields; the public source maps only the closed tables in this plan. Keep one `operations` registry so desktop and MCode observe the same progress. Add opaque worktree IDs at the service boundary rather than accepting arbitrary absolute paths.

- [ ] **Step 5: Run complete Git and desktop validation**

```powershell
$root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
npm --prefix "$root/plugins/dsh-plugin-otools-git" run check
npm --prefix "$root/plugins/dsh-plugin-otools-git" test
npm --prefix $root test
```

Expected: all PASS, including real-repository and security suites, with regenerated `lib/**`.

- [ ] **Step 6: Commit desktop**

```powershell
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' add plugins/dsh-plugin-otools-git
git -C 'D:/Repos/xyito/open/dsh-desktop-ultra' commit -m 'feat(git): expose fixed paired repository source'
```

### Task 8: Validate all four catalogs and finish extension documentation

**Files:**
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/fixtures/dsh-plugins/otoolsGit.ts`
- Create: `D:/Repos/xyito/lingyun/mcode/mcode-app/tests/pages/connection-detail/pluginCatalogBatchOne.spec.ts`
- Modify: `D:/Repos/xyito/open/dsh-desktop-ultra/PLUGINS.md`
- Modify: each of the four desktop plugin `README.md` files
- Create at execution time using Step 7: `D:/Repos/xyito/lingyun/mcode/docs/mcode-architecture-notes/<runtime timestamp>-dsh-plugin-batch-one.md`

**Interfaces:**
- Consumes Tasks 1–7.
- Produces copyable third-party examples for source registration, UI nodes, confirmation, paging, transfers, overflow refresh, source removal, and safe errors.

- [ ] **Step 1: Write the fixture-driven catalog integration test**

```ts
import { validateCatalog } from '@/agents/dsh/ui/schema'
import { buildPageModel, reducePluginEvent } from '@/agents/dsh/ui/runtime'
import { resolveActionConfirmation } from '@/agents/dsh/ui/actions'
import { taskboardFixture } from '../../fixtures/dsh-plugins/taskboard'
import { repopanelFixture } from '../../fixtures/dsh-plugins/repopanel'
import { automationFixture } from '../../fixtures/dsh-plugins/automation'
import { otoolsGitFixture } from '../../fixtures/dsh-plugins/otoolsGit'

const fixtures = [
  ['taskboard', taskboardFixture],
  ['repopanel', repopanelFixture],
  ['automation', automationFixture],
  ['otools-git', otoolsGitFixture],
] as const

test.each(fixtures)('%s catalog uses only public nodes and declared risks', (_name, fixture) => {
  const neutral = { ...fixture, id: `example.${_name}` }
  expect(validateCatalog(neutral)).toEqual(neutral)
  for (const page of neutral.pages) {
    const model = buildPageModel(neutral, page.id, fixture.responses)
    expect(model.nodes.every(node => node.type !== 'unknown')).toBe(true)
  }
  for (const command of neutral.commands.filter(row => row.effect === 'write')) {
    expect(resolveActionConfirmation({ command, action: neutral.actions[command.name] }))
      .toBe(command.confirmation)
  }
  expect(reducePluginEvent(
    buildPageModel(neutral, neutral.pages[0].id, fixture.responses),
    { kind: 'source-removed', source: neutral.id },
  )).toEqual({ close: true })
})

test('Git image preview is a transfer, never inline data', () => {
  expect(otoolsGitFixture.responses['diff/image']).toEqual({
    before: undefined,
    after: {
      url: '/dsh-plugin-otools-socket/transfer/ticket-1',
      kind: 'download',
      expiresAt: 60_000,
      contentType: 'image/png',
      maxBytes: 4 * 1024 * 1024,
    },
  })
  expect(JSON.stringify(otoolsGitFixture.responses)).not.toContain('base64')
})
```

Add one overflow/revision-gap assertion per fixture against its declared refresh command. Read `DshDeclarativeNodeRenderer.vue` as text and assert none of the four production source IDs occurs in it; this is the executable no-source-branch guard under Node Jest.

- [ ] **Step 2: Run the focused test and observe failure**

```powershell
pnpm --dir 'D:/Repos/xyito/lingyun/mcode/mcode-app' run test:unit -- --runTestsByPath tests/pages/connection-detail/pluginCatalogBatchOne.spec.ts
```

Expected: FAIL until the Git fixture and any missing generic catalog wiring exist.

- [ ] **Step 3: Update extension documentation without changing protocol decisions**

Document the exact `registerSource()` lifecycle, local self-contained source module pattern, command schema closure, strictest-confirmation rule, cursor revision rule, 196608-byte text pages, transfer ticket use, secret redaction, and `paired` opt-in. Plugin READMEs list their source ID/protocol and command table; do not duplicate foundation transport internals.

- [ ] **Step 4: Run full MCode validation**

```powershell
$app = 'D:/Repos/xyito/lingyun/mcode/mcode-app'
pnpm --dir $app run test:unit
pnpm --dir $app exec vue-tsc --noEmit -p tsconfig.json
pnpm --dir $app run build:h5
pnpm --dir $app exec uni build -p app
pnpm --dir $app run build:mp-weixin
```

Expected: all PASS.

- [ ] **Step 5: Run full desktop validation**

```powershell
$root = 'D:/Repos/xyito/open/dsh-desktop-ultra'
npm --prefix $root run typecheck
npm --prefix $root test
foreach ($name in 'taskboard','repopanel','automation','otools-git') {
  npm --prefix "$root/plugins/dsh-plugin-$name" run check
  if ($LASTEXITCODE -ne 0) { throw "check failed: $name" }
  npm --prefix "$root/plugins/dsh-plugin-$name" test
  if ($LASTEXITCODE -ne 0) { throw "tests failed: $name" }
}
git -C $root diff --exit-code -- ':(glob)plugins/dsh-plugin-*/lib/**'
```

Expected: all PASS and no unreviewed generated output.

- [ ] **Step 6: Perform the real mobile smoke gate**

Pair once; execute Taskboard CRUD/bulk, RepoPanel browse/comment/create/task-start, Automation create/disable/enable/run/cancel, and Git status/stage/commit/pull plus one push and one danger confirmation. Cause one reconnect and one source unload/reload. Revoke the device and verify subsequent control and transfer operations stop. Record actual target, OS/runtime, desktop/MCode revisions, network origin, and results in the MCode architecture note without secrets. If no device or legal mini-program domain is available, mark this gate BLOCKED rather than PASS.

- [ ] **Step 7: Write the architecture note and commit documentation/tests separately**

```powershell
$desktop = 'D:/Repos/xyito/open/dsh-desktop-ultra'
$mcode = 'D:/Repos/xyito/lingyun/mcode'
$stamp = Get-Date -Format 'yyyy-MM-dd-HH-mm'
$note = "docs/mcode-architecture-notes/$stamp-dsh-plugin-batch-one.md"
@'
# DSH plugin batch one

Batch one adds source-neutral Kanban, collection, tree, Diff, and bounded-log nodes plus paired Taskboard, RepoPanel, Automation, and typed Git catalogs. Every command is closed-schema and confirmation-rated; large text is revision/byte paged, binary content uses transfer tickets, and overflow causes a fresh snapshot read. The same contracts apply to H5, App, mini-program, and future native clients without plugin-specific renderer code.

Compatibility: requires bus v2, declarative UI v1, and source protocol v1. Credentials and filesystem roots never enter catalogs, snapshots, events, or console frames. Real-device acceptance records the tested runtime separately; unavailable device/domain is BLOCKED, not PASS.
'@ | Set-Content -Path (Join-Path $mcode $note) -Encoding utf8
git -C $desktop add PLUGINS.md plugins/dsh-plugin-taskboard/README.md plugins/dsh-plugin-repopanel/README.md plugins/dsh-plugin-automation/README.md plugins/dsh-plugin-otools-git/README.md
git -C $desktop commit -m 'docs(plugins): document batch one source contracts'
git -C $mcode add mcode-app/tests/fixtures/dsh-plugins mcode-app/tests/pages/connection-detail/pluginCatalogBatchOne.spec.ts $note
git -C $mcode commit -m 'test(dsh-ui): validate batch one plugin catalogs'
```

Do not tag or publish in this plan.
