/**
 * 文件池是伪装的可信度来源：假的 `read(...)` 引用的必须是工作区里真实存在的路径。
 * 但它跑在 harness 进程里、扫的是用户随手选的目录，所以每一条边界都要钉住：
 * 跳过 node_modules 与点目录、深度上限、缓存、以及注册表缺席时安静地返回空。
 *
 * @module dsh-plugin-longread/test/files
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFilePool, workspaceFace } from '../src/host/files.js'

async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-longread-files-'))
  const write = async (relative) => {
    const full = join(root, relative)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, 'x', 'utf8')
  }
  await write('src/one.ts')
  await write('src/nested/two.rs')
  await write('README.md')
  await write('image.png')
  await write('node_modules/pkg/index.ts')
  await write('.git/config.ts')
  await write('dist/bundle.js')
  await write('a/b/c/d/e/deep.ts')
  return root
}

test('只收源码文件、相对路径、正斜杠，且跳过 node_modules / .git / dist', async () => {
  const root = await makeTree()
  const pool = createFilePool({ workspaces: () => [{ path: root, updatedAt: 1 }] })
  const paths = await pool.paths()
  assert.ok(paths.includes('src/one.ts'))
  assert.ok(paths.includes('src/nested/two.rs'))
  assert.ok(paths.includes('README.md'))
  assert.equal(paths.includes('image.png'), false, '图片不是源码')
  for (const path of paths) {
    assert.equal(path.includes('\\'), false, '路径要用正斜杠')
    assert.equal(path.startsWith('/'), false, '要相对路径')
    assert.equal(/(^|\/)(node_modules|dist|\.git)\//.test(path), false, path + ' 不该被收进来')
  }
  assert.equal(paths.includes('a/b/c/d/e/deep.ts'), false, '超过深度上限的不收')
})

test('缓存住：第二次不再问工作区，invalidate 之后才重扫', async () => {
  const root = await makeTree()
  let asked = 0
  const pool = createFilePool({
    workspaces: () => {
      asked += 1
      return [{ path: root }]
    },
  })
  await pool.paths()
  await pool.paths()
  assert.equal(asked, 1)
  pool.invalidate()
  await pool.paths()
  assert.equal(asked, 2)
})

test('没有工作区注册表时安静地返回空，绝不抛', async () => {
  assert.deepEqual(await createFilePool({ workspaces: workspaceFace(() => undefined) }).paths(), [])
  assert.deepEqual(await createFilePool({ workspaces: workspaceFace(() => ({})) }).paths(), [])
  assert.deepEqual(await createFilePool({ workspaces: () => { throw new Error('boom') } }).paths(), [])
  assert.deepEqual(await createFilePool({ workspaces: () => [{ path: '/nope/does/not/exist' }] }).paths(), [])
})

test('workspaceFace 把注册表映射成 { path, updatedAt }', () => {
  const face = workspaceFace(() => ({
    list: () => [{ id: 'w1', path: '/a', updatedAt: 3, title: '甲' }],
  }))
  assert.deepEqual(face(), [{ path: '/a', updatedAt: 3 }])
})
