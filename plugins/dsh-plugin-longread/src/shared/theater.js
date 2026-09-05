/**
 * The theater: turns one chapter of prose into a fake agent transcript —
 * a user prompt, an optional reasoning block, a handful of tool calls, then the
 * prose itself as the assistant's reply.
 *
 * Everything here is deterministic: the same (bookId, chapterIndex, turnIndex,
 * persona, file pool) always produces the same fake calls, so re-opening a
 * chapter does not reshuffle the transcript under the reader. That is also why
 * this runs on the host and ships as JSON — the browser bundle cannot import
 * shared code, and duplicating a PRNG across two files is how drift starts.
 *
 * The tool names, argument names and result strings are the REAL dsh ones
 * (`read`/`edit`/`bash`/`grep`/`glob`/`todo_write`, `file_path`, `(End of file -
 * total N lines)`, `The file X has been updated successfully.`) — the camouflage
 * is only worth anything if a passer-by reads exactly what they expect.
 *
 * @module dsh-plugin-longread/shared/theater
 */

/** Max fake tool calls in one turn, per density. */
const DENSITY = {
  off: { min: 0, max: 0, thinking: 0 },
  low: { min: 0, max: 1, thinking: 0.15 },
  medium: { min: 1, max: 2, thinking: 0.34 },
  high: { min: 1, max: 3, thinking: 0.55 },
}

/** Fallback file pool: a plausible TS/Rust workspace, used when no real one is available. */
export const FALLBACK_FILES = [
  'src/app/session/store.ts',
  'src/app/session/reducer.ts',
  'src/app/composer/Composer.tsx',
  'src/lib/retry.ts',
  'src/lib/stream.ts',
  'src/lib/telemetry.ts',
  'src/server/routes/session.ts',
  'src/server/routes/health.ts',
  'src/server/middleware/auth.ts',
  'packages/core/src/loop.ts',
  'packages/core/src/tool-registry.ts',
  'packages/core/src/index.ts',
  'tests/session.spec.ts',
  'tests/retry.spec.ts',
  'scripts/build.mjs',
  'src-tauri/src/main.rs',
  'src-tauri/src/plugins.rs',
  'package.json',
  'tsconfig.json',
  'README.md',
]

/** Code-ish lines used to fill fake grep hits and diff previews. */
const CODE_LINES = [
  'const backoff = Math.min(cap, base * 2 ** attempt)',
  'if (attempt >= maxRetries) throw new RetryExhausted(last)',
  'await sleep(jitter(backoff), { signal })',
  'export function createStore(initial: State): Store {',
  'return { ...state, status: \'running\', updatedAt: now() }',
  'logger.debug(\'retry\', { attempt, delay, code: err.code })',
  'const controller = new AbortController()',
  'if (!res.ok) return fail(res.status, await res.text())',
  'for (const listener of listeners) listener(snapshot)',
  'assert.equal(store.getState().status, \'idle\')',
  'let disposed = false',
  'queue = queue.then(run, run)',
]

/** Shell commands per persona flavour. */
const COMMANDS = [
  { cmd: 'npm test -- --reporter=dot', out: ['', '  84 passing (2.1s)', '  1 pending', ''], code: 0 },
  { cmd: 'npm run typecheck', out: ['', '> tsc --noEmit', ''], code: 0 },
  { cmd: 'git diff --stat', out: [' src/lib/retry.ts | 24 +++++++++-----', ' 1 file changed, 17 insertions(+), 7 deletions(-)'], code: 0 },
  { cmd: 'git status --short', out: [' M src/lib/retry.ts', ' M tests/retry.spec.ts'], code: 0 },
  { cmd: 'node --test test/store.test.mjs', out: ['# tests 12', '# pass 12', '# fail 0'], code: 0 },
  { cmd: 'cargo check -q', out: ['    Finished dev [unoptimized] target(s) in 3.42s'], code: 0 },
  { cmd: 'rg -c "TODO" src | head', out: ['src/lib/retry.ts:2', 'src/app/session/store.ts:1'], code: 0 },
]

/** Camouflage personas: what the transcript pretends to be doing. */
export const PERSONA_SCRIPTS = {
  refactor: {
    label: '重构',
    openers: [
      '继续上一轮：把 {file} 里的重试逻辑抽成独立函数，行为保持不变',
      '接着改 {file}，先把重复的分支合掉，别动对外签名',
      '把 {file} 的状态机拆开，读一遍再动手',
    ],
    thinking: [
      '先确认调用点，再改签名，避免漏掉测试里的两处引用。',
      '这里的分支其实是同一个语义，合并前先把边界条件列清楚。',
      '先读一遍再改：上一次就是没看到第二个 early return 才回归的。',
    ],
    tools: ['todo_write', 'read', 'grep', 'edit', 'bash'],
    lead: ['todo_write', 'read'],
  },
  debug: {
    label: '排查',
    openers: [
      '{file} 这里为什么会重复触发？先别改，读一遍再说',
      '定位一下这个偶发失败，从 {file} 开始',
      '看下 {file}：日志里同一条打了两次',
    ],
    thinking: [
      '两次触发说明监听器被注册了两次，先找注册点。',
      '先复现：把并发调低到 1，看是否还会出现。',
      '时间线对不上，先确认是不是重试把同一个请求发了两遍。',
    ],
    tools: ['grep', 'read', 'bash', 'read', 'edit'],
    lead: ['grep', 'read'],
  },
  review: {
    label: '审阅',
    openers: [
      '审一下这次改动，重点看 {file} 的错误处理',
      '过一遍分支上的改动，先列出可疑点，别改代码',
      '这块 {file} 的边界条件我不放心，帮我看看',
    ],
    thinking: [
      '先看错误路径：正常路径一般不会出问题。',
      '这个改动的风险在回滚上，先确认写入是不是原子的。',
      '先把公开接口的变化列出来，再看内部实现。',
    ],
    tools: ['glob', 'read', 'grep', 'read', 'bash'],
    lead: ['glob', 'read'],
  },
  docs: {
    label: '文档',
    openers: [
      '把 {file} 的行为补进文档，按现有风格来',
      '整理一下这个模块的说明，先看代码再写',
      '{file} 的注释和实现不一致了，对一遍',
    ],
    thinking: [
      '先按代码把实际行为列出来，再决定文档写到哪一层。',
      '文档里那句话已经过期了，先确认现在的默认值。',
      '保持和邻居文件同一个语气，不要引入新术语。',
    ],
    tools: ['glob', 'read', 'write', 'edit', 'read'],
    lead: ['glob', 'read'],
  },
}

/** Short continuations a human actually types on turn 2..n. */
const CONTINUATIONS = [
  '继续', '嗯，继续', 'ok', '接着说', '继续，别停', '好，下一步',
  '继续；有风险的地方标出来', '嗯', '继续吧', '往下走',
]

/** 32-bit string hash (FNV-1a), so seeds are stable across processes. */
export function hashString(text) {
  let hash = 0x811c9dc5
  const input = String(text)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32: tiny, fast, good enough, and identical everywhere. */
export function makeRandom(seed) {
  let state = (seed >>> 0) || 0x9e3779b9
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick one element deterministically. */
function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length]
}

/** Integer in [min, max]. */
function pickInt(random, min, max) {
  if (max <= min) return min
  return min + Math.floor(random() * (max - min + 1))
}

/** Group paragraphs into turns of roughly `turnChars` characters. */
export function groupTurns(paragraphs, turnChars) {
  const target = Math.max(120, Number.isFinite(turnChars) ? turnChars : 420)
  const groups = []
  let current = []
  let size = 0
  for (const paragraph of paragraphs) {
    current.push(paragraph)
    size += paragraph.length
    if (size >= target || current.length >= 6) {
      groups.push(current)
      current = []
      size = 0
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Split a file pool into code-ish and doc-ish buckets. */
function bucketFiles(files) {
  const pool = Array.isArray(files) && files.length > 0 ? files : FALLBACK_FILES
  const code = pool.filter((path) => /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|swift|c|cc|cpp|h|vue|svelte)$/i.test(path))
  const docs = pool.filter((path) => /\.(md|mdx|txt|ya?ml|json|toml)$/i.test(path))
  return {
    all: pool,
    code: code.length > 0 ? code : pool,
    docs: docs.length > 0 ? docs : pool,
  }
}

/** Build one fake tool call record. */
function buildCall(name, random, buckets, index) {
  const codeFile = pick(random, buckets.code)
  const anyFile = pick(random, buckets.all)
  const docFile = pick(random, buckets.docs)
  const id = `call_${(hashString(`${name}:${codeFile}:${index}`) % 0xffffff).toString(36)}`
  const ms = pickInt(random, 40, 1400)
  const base = { id, name, ms, status: 'ok' }

  if (name === 'read') {
    const total = pickInt(random, 48, 980)
    const capped = total > 400 && random() < 0.4
    return {
      ...base,
      summary: codeFile,
      args: { file_path: codeFile, ...(capped ? { offset: 1, limit: 200 } : {}) },
      result: capped
        ? `(Showing lines 1-200 of ${total}. Use offset=201 to continue.)`
        : `(End of file - total ${total} lines)`,
      resultLines: [
        `<path>${codeFile}</path>`,
        '<type>file</type>',
        ...Array.from({ length: 3 }, (_unused, i) => `${pickInt(random, 12, total)}: ${pick(random, CODE_LINES)}`),
      ],
    }
  }
  if (name === 'edit') {
    return {
      ...base,
      summary: codeFile,
      args: { file_path: codeFile, old_string: pick(random, CODE_LINES), new_string: pick(random, CODE_LINES) },
      result: `The file ${codeFile} has been updated successfully.`,
      resultLines: [`+${pickInt(random, 2, 22)} -${pickInt(random, 1, 14)}`],
    }
  }
  if (name === 'write') {
    return {
      ...base,
      summary: docFile,
      args: { file_path: docFile },
      result: random() < 0.5 ? 'Created file' : 'Updated file',
      resultLines: [`<path>${docFile}</path>`, '<type>file</type>'],
    }
  }
  if (name === 'grep') {
    const pattern = pick(random, ['retry|backoff', 'createStore', 'AbortController', 'TODO\\(', 'listeners\\.', 'await sleep'])
    const hits = pickInt(random, 0, 9)
    return {
      ...base,
      summary: pattern,
      args: { pattern, include: pick(random, ['*.ts', '*.{ts,tsx}', '*.js', undefined]) },
      result: hits === 0 ? 'No matches found' : `${hits} 处匹配 · ${pickInt(random, 1, 4)} 个文件`,
      resultLines: hits === 0 ? ['No matches found'] : [
        codeFile,
        ...Array.from({ length: Math.min(3, hits) }, () => `  Line ${pickInt(random, 8, 420)}: ${pick(random, CODE_LINES)}`),
      ],
    }
  }
  if (name === 'glob') {
    const pattern = pick(random, ['**/*.test.ts', 'src/**/*.ts', '**/*.md', 'packages/*/src/**/*.ts'])
    const count = pickInt(random, 2, 24)
    return {
      ...base,
      summary: pattern,
      args: { pattern },
      result: `${count} 个文件`,
      resultLines: buckets.all.slice(0, Math.min(4, buckets.all.length)),
    }
  }
  if (name === 'bash') {
    const entry = pick(random, COMMANDS)
    return {
      ...base,
      summary: entry.cmd,
      args: { command: entry.cmd, description: '本地校验' },
      result: entry.code === 0 ? '退出码 0' : `退出码 ${entry.code}`,
      resultLines: entry.out.filter((line) => line.length > 0),
    }
  }
  if (name === 'todo_write') {
    const pending = pickInt(random, 1, 4)
    const done = pickInt(random, 0, 5)
    return {
      ...base,
      summary: `${pending + done + 1} 项`,
      args: { todos: `[${pending + done + 1} items]` },
      result: `Updated todo list: ${pending} pending, 1 in progress, ${done} completed.`,
      resultLines: [
        `[~] ${pick(random, ['抽出重试函数', '对齐错误码', '补边界测试', '整理文档段落'])}`,
        `[ ] ${pick(random, ['回归旧调用点', '跑一遍 typecheck', '确认默认值', '清理临时日志'])}`,
      ],
    }
  }
  // Unknown tool: keep the shape valid rather than throwing into a render loop.
  return { ...base, summary: anyFile, args: {}, result: 'ok', resultLines: [] }
}

/**
 * Plan one chapter into fake agent turns.
 * @param input - { bookId, bookTitle, chapterIndex, chapterTitle, paragraphs,
 *                  settings, files }
 */
export function planChapter(input) {
  const settings = input.settings ?? {}
  const density = DENSITY[settings.toolDensity] ?? DENSITY.medium
  const script = PERSONA_SCRIPTS[settings.persona] ?? PERSONA_SCRIPTS.refactor
  const buckets = bucketFiles(input.files)
  const groups = groupTurns(input.paragraphs ?? [], settings.turnChars)
  const bookId = String(input.bookId ?? '')
  const chapterIndex = Number.isFinite(input.chapterIndex) ? input.chapterIndex : 0

  const turns = groups.map((paragraphs, index) => {
    const random = makeRandom(hashString(`${bookId}|${chapterIndex}|${index}|${settings.persona ?? 'refactor'}`))
    const leadFile = pick(random, buckets.code)

    const prompt = index === 0
      ? pick(random, script.openers).replace('{file}', leadFile)
      : (random() < 0.22
        ? pick(random, script.openers).replace('{file}', leadFile)
        : pick(random, CONTINUATIONS))

    let count = pickInt(random, density.min, density.max)
    // The first turn of a chapter always looks like the start of real work.
    if (index === 0 && density.max > 0) count = Math.max(count, Math.min(2, density.max))
    const names = []
    for (let i = 0; i < count; i++) {
      const source = index === 0 && i < script.lead.length ? [script.lead[i]] : script.tools
      names.push(pick(random, source))
    }
    const calls = names.map((name, position) => buildCall(name, random, buckets, index * 8 + position))

    const thinking = settings.showThinking !== false && random() < density.thinking
      ? { text: pick(random, script.thinking), seconds: pickInt(random, 9, 88) / 10 }
      : null

    const chars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
    return { index, prompt, thinking, calls, paragraphs, chars }
  })

  return {
    bookId,
    chapterIndex,
    chapterTitle: String(input.chapterTitle ?? ''),
    persona: script.label,
    turnCount: turns.length,
    turns,
  }
}
