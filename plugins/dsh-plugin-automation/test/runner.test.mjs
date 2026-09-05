/**
 * Runner tests: the four outcomes a headless child can have (answer, non-zero
 * exit, timeout, cancel), the spawn failure that must still be an outcome, and
 * the session-identification rule. Real child processes — the part worth testing
 * is the process handling itself, not a mock of it.
 *
 * @module dsh-plugin-automation/test/runner
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { identifySession, sessionIdsOnDisk, startHeadlessRun } from '../src/host/runner.js'

/** A stand-in launcher that accepts exactly the argv the runner promises to pass. */
const FAKE_DSH = `
const args = process.argv.slice(2)
if (args[0] !== '--profile' || args[1] !== 'headless' || args.length !== 3) {
  console.error('unexpected argv: ' + JSON.stringify(args))
  process.exit(64)
}
if (process.env.FAKE_STDERR !== undefined) console.error(process.env.FAKE_STDERR)
console.log('ANSWER:' + args[2])
process.exit(Number(process.env.FAKE_EXIT ?? 0))
`

const FAKE_HANG = 'setInterval(() => {}, 1000)\n'

async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-run-'))
  const dsh = join(dir, 'fake-dsh.js')
  const hang = join(dir, 'fake-hang.js')
  await writeFile(dsh, FAKE_DSH, 'utf8')
  await writeFile(hang, FAKE_HANG, 'utf8')
  return {
    dir,
    entry: { command: process.execPath, prefix: [dsh] },
    hangEntry: { command: process.execPath, prefix: [hang] },
  }
}

test('提示词按单个 argv 传递，shell 元字符不会被展开', async () => {
  const { entry } = await fixtures()
  const prompt = 'hello $(whoami) && echo pwned | tee x'
  const handle = await startHeadlessRun({ entry, cwd: process.cwd(), prompt, timeoutMs: 10_000 })
  const outcome = await handle.done
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.exitCode, 0)
  // The child echoes back exactly what it received: one argument, verbatim.
  assert.equal(outcome.output.trim(), `ANSWER:${prompt}`)
})

test('非零退出码是 failed，stderr 成为错误详情', async () => {
  const { entry } = await fixtures()
  const handle = await startHeadlessRun({
    entry, cwd: process.cwd(), prompt: 'x', timeoutMs: 10_000,
    env: { FAKE_EXIT: '3', FAKE_STDERR: 'dsh: model_error: no credentials' },
  })
  const outcome = await handle.done
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.exitCode, 3)
  assert.match(outcome.error, /no credentials/)
})

test('超时会终止子进程并落到 timeout', async () => {
  const { hangEntry } = await fixtures()
  const handle = await startHeadlessRun({ entry: hangEntry, cwd: process.cwd(), prompt: 'x', timeoutMs: 400 })
  const outcome = await handle.done
  assert.equal(outcome.status, 'timeout')
  assert.match(outcome.error, /超时/)
})

test('取消会终止子进程并落到 canceled', async () => {
  const { hangEntry } = await fixtures()
  const handle = await startHeadlessRun({ entry: hangEntry, cwd: process.cwd(), prompt: 'x', timeoutMs: 60_000 })
  setTimeout(() => handle.kill('cancel'), 150)
  const outcome = await handle.done
  assert.equal(outcome.status, 'canceled')
})

test('启动器不存在时也给出结果而不是抛异常', async () => {
  const handle = await startHeadlessRun({
    entry: { command: 'dsh-launcher-that-does-not-exist', prefix: [] },
    cwd: process.cwd(),
    prompt: 'x',
    timeoutMs: 1000,
  })
  const outcome = await handle.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.error, /dsh/)
})

test('会话只在唯一新候选时才认领，并且不会被认领两次', () => {
  const claimed = new Set()
  assert.equal(identifySession(new Set(['session-a']), new Set(['session-a', 'session-b']), claimed), 'session-b')
  // Already attributed to the first run: a second run must not steal it.
  assert.equal(identifySession(new Set(['session-a']), new Set(['session-a', 'session-b']), claimed), undefined)
  // Two fresh candidates are ambiguous — no link is better than a wrong one.
  assert.equal(identifySession(new Set(), new Set(['session-c', 'session-d']), new Set()), undefined)
  assert.equal(identifySession(new Set(['session-a']), new Set(['session-a']), new Set()), undefined)
})

test('会话目录不存在时扫描返回空集而不是抛异常', async () => {
  const { dir } = await fixtures()
  assert.equal((await sessionIdsOnDisk(join(dir, 'nope'))).size, 0)
})
