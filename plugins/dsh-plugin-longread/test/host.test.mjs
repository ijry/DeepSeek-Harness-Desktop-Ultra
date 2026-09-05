/**
 * 书架的持久化：这本书的正文不在 JSON 里（一本书几 MB，画个菜单不该解析一部小说），
 * 所以「元数据提交」和「正文落盘」是两次写，顺序错了就会出现指向空文件的书。
 * 这里对着真实临时目录跑，专门盯这条缝，以及坏账本的隔离。
 *
 * @module dsh-plugin-longread/test/host
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../src/host/store.js'
import { addBook, deleteBook, seedSample, setProgress, updateSettings } from '../src/host/library.js'
import { SAMPLE_TITLE } from '../src/host/sample.js'

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-longread-'))
  const store = new LibraryStore({ file: join(dir, 'library.json'), textDir: join(dir, 'books') })
  return { store, dir }
}

const TXT = Buffer.from('第一章 甲\n\n甲的正文。\n\n第二章 乙\n\n乙的正文。\n', 'utf8')

test('缺文件时从空开始，不抛', async () => {
  const { store } = await freshStore()
  await store.load()
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.books, [])
  assert.equal(snapshot.revision, 0)
})

test('addBook 先落正文再提交元数据，两边都能读回来', async () => {
  const { store, dir } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: '测试.txt', now: () => 1000 })
  assert.equal(summary.title, '测试')
  assert.equal(summary.chapters.length, 2)
  const onDisk = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8'))
  assert.equal(onDisk.books.length, 1)
  assert.equal(onDisk.revision, 1)
  const files = await readdir(join(dir, 'books'))
  assert.deepEqual(files, [summary.id + '.txt'])
  assert.equal(await store.chapterText(summary.id, 1), '第二章 乙\n\n乙的正文。')
})

test('snapshot 里没有正文，只有元数据，而且是冻的', async () => {
  const { store } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  const snapshot = store.snapshot()
  assert.equal(JSON.stringify(snapshot).includes('甲的正文'), false, '正文不该出现在书架快照里')
  assert.ok(Object.isFrozen(snapshot))
  assert.throws(() => { snapshot.books[0].title = 'x' }, TypeError)
  assert.equal(store.get(summary.id).chapters.length, 2)
  assert.equal(store.get('nope'), undefined)
})

test('删书连正文与阅读进度一起删，删不存在的返回 false', async () => {
  const { store, dir } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  await setProgress(store, { bookId: summary.id, chapterIndex: 1, turnIndex: 3, now: () => 5 })
  assert.deepEqual(store.snapshot().progress[summary.id], { chapterIndex: 1, turnIndex: 3, updatedAt: 5 })
  assert.equal(await deleteBook(store, summary.id), true)
  assert.deepEqual(await readdir(join(dir, 'books')), [])
  assert.equal(store.snapshot().progress[summary.id], undefined)
  assert.equal(await deleteBook(store, summary.id), false)
})

test('进度被夹回书里：越界的章号与负数都不会写进账本', async () => {
  const { store } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  const high = await setProgress(store, { bookId: summary.id, chapterIndex: 99, turnIndex: -4, now: () => 1 })
  assert.deepEqual(high, { chapterIndex: 1, turnIndex: 0, updatedAt: 1 })
  assert.equal(await setProgress(store, { bookId: 'nope', chapterIndex: 0, turnIndex: 0 }), undefined)
})

test('设置只接受合法值，非法值退回原值', async () => {
  const { store } = await freshStore()
  const saved = await updateSettings(store, { speed: 99999, persona: 'nope', toolDensity: 'high', autoPlay: false })
  assert.equal(saved.speed, 600, '超出上限就夹住')
  assert.equal(saved.persona, 'refactor', '不认识的伪装退回默认')
  assert.equal(saved.toolDensity, 'high')
  assert.equal(saved.autoPlay, false)
  assert.equal(store.settings.toolDensity, 'high', '写进账本，不只是回显')
})

test('示例小说只种一次，删掉之后也不会自己长回来', async () => {
  const { store } = await freshStore()
  const first = await seedSample(store, { now: () => 7 })
  assert.equal(first.title, SAMPLE_TITLE)
  assert.equal(first.builtin, true)
  assert.equal(first.chapters.length, 9, '示例应该切出九章')
  assert.equal(await seedSample(store, {}), undefined, '第二次是空操作')
  assert.equal(store.snapshot().books.length, 1)
  await deleteBook(store, first.id)
  assert.equal(await seedSample(store, {}), undefined, '删了就是删了')
  assert.equal(store.snapshot().books.length, 0)
})

test('坏账本被隔离而不是让插件起不来', async () => {
  const { store, dir } = await freshStore()
  await writeFile(store.file, '{ this is not json', 'utf8')
  await store.load()
  assert.deepEqual(store.snapshot().books, [])
  const left = await readdir(dir)
  assert.ok(left.some((name) => name.includes('.corrupt-')), '坏文件应该被改名留档')
})

test('不像书的条目在加载时被丢掉，孤儿进度也一起丢', async () => {
  const { store } = await freshStore()
  await writeFile(store.file, JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    books: [
      { id: 'ok', title: '好书', format: 'txt', chapters: [{ title: 'a', start: 0, end: 5 }] },
      { id: 'bad', title: '没有章节', format: 'txt', chapters: [] },
      { id: 'worse', format: 'epub', chapters: [{ title: 'a', start: 0, end: 1 }] },
      'not even an object',
    ],
    progress: { ok: { chapterIndex: 0, turnIndex: 2 }, ghost: { chapterIndex: 9, turnIndex: 9 } },
  }), 'utf8')
  await store.load()
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.books.map((book) => book.id), ['ok'])
  assert.equal(snapshot.revision, 4, '版本号照旧沿用')
  assert.deepEqual(Object.keys(snapshot.progress), ['ok'])
})

test('并发写串行化：三次进度写完，账本版本刚好加三', async () => {
  const { store } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  const before = store.revision
  await Promise.all([
    setProgress(store, { bookId: summary.id, chapterIndex: 0, turnIndex: 1, now: () => 1 }),
    setProgress(store, { bookId: summary.id, chapterIndex: 1, turnIndex: 2, now: () => 2 }),
    setProgress(store, { bookId: summary.id, chapterIndex: 0, turnIndex: 3, now: () => 3 }),
  ])
  assert.equal(store.revision, before + 3)
})

test('正文缓存有上限，且写入后失效', async () => {
  const { store } = await freshStore()
  store.textCacheLimit = 1
  const first = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  const second = await addBook(store, { buffer: TXT, filename: 'b.txt' })
  await store.text(first.id)
  await store.text(second.id)
  assert.equal(store.textCache.size, 1, '一本书几 MB，缓存必须有上限')
  await store.writeText(first.id, '第一章 新\n\n新的正文。')
  assert.equal(store.textCache.has(first.id), false)
  assert.equal(await store.chapterText(first.id, 0), '第一章 新\n\n新的正文。')
})

test('缺了正文文件时 chapterText 返回 undefined，而不是抛', async () => {
  const { store } = await freshStore()
  const summary = await addBook(store, { buffer: TXT, filename: 'a.txt' })
  await store.removeText(summary.id)
  assert.equal(await store.chapterText(summary.id, 0), undefined)
  assert.equal(await store.chapterText(summary.id, 99), undefined)
})
