/**
 * 几何与吸附的领域测试：把 codeg-plus canvas-model.test.ts 里那批断言搬过来，
 * 锁住「板上单位」的具体数值——列宽/行高的往返、网格摆放、拖拽落点判定、
 * 对齐参考线与点阵吸附、货架式自动整理。
 *
 * 这些数字是画布的坐标系本身，改动会直接表现为卡片压边框、参考线指不到东西，
 * 所以宁可把它们钉死在测试里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_DOT_GAP,
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_VISIBLE_MEMBERS,
  REGION_FOOTER_HEIGHT,
  REGION_HEADER_HEIGHT,
  REGION_PADDING,
  clampZoom,
  columnsForRegionWidth,
  effectiveColumns,
  regionHeightForRows,
  regionWidthForColumns,
  rowsForRegionHeight,
  visibleMemberCap,
} from '../src/shared/units.js'
import { layoutRegionGrid, packLayout, seedRegionsFromWorkspaces } from '../src/shared/layout.js'
import { computeAlignment, computeDropHint } from '../src/shared/snap.js'

test('列数与行数经过框尺寸往返不变', () => {
  for (let n = 1; n <= 6; n++) {
    assert.equal(columnsForRegionWidth(regionWidthForColumns(n)), n)
    assert.equal(rowsForRegionHeight(regionHeightForRows(n)), n)
  }
  // 具体数值：2 列 484、3 列 720、6 列 1428；1 行 196、2 行 340。
  assert.equal(regionWidthForColumns(2), 484)
  assert.equal(regionWidthForColumns(3), 720)
  assert.equal(regionWidthForColumns(6), 1428)
  assert.equal(regionHeightForRows(1), 196)
  assert.equal(regionHeightForRows(2), 340)
})

test('参差的拖拽宽度向下量化到整列，且永远不会是零列', () => {
  assert.equal(columnsForRegionWidth(regionWidthForColumns(3) + CARD_WIDTH / 2), 3)
  assert.equal(columnsForRegionWidth(0), 1)
  assert.equal(columnsForRegionWidth(-100), 1)
  assert.equal(rowsForRegionHeight(0), 1)
})

test('钉死的列数/行数盖过宽度推导，并决定可见上限', () => {
  assert.equal(effectiveColumns({ gridColumns: 2 }, 1428), 2)
  assert.equal(effectiveColumns({ gridColumns: 0 }, 1428), 6)
  assert.equal(visibleMemberCap({ gridRows: 2 }, 3), 6)
  assert.equal(visibleMemberCap({ gridRows: 0 }, 3), MAX_VISIBLE_MEMBERS)
})

test('网格按宽度算列并换行，内容高度含页眉与内边距', () => {
  const grid = layoutRegionGrid(5, regionWidthForColumns(3))
  assert.equal(grid.columns, 3)
  assert.deepEqual(grid.positions[0], {
    x: REGION_PADDING,
    y: REGION_HEADER_HEIGHT + REGION_PADDING,
  })
  assert.deepEqual(grid.positions[2], {
    x: REGION_PADDING + 2 * (CARD_WIDTH + CARD_GAP),
    y: REGION_HEADER_HEIGHT + REGION_PADDING,
  })
  assert.deepEqual(grid.positions[3], {
    x: REGION_PADDING,
    y: REGION_HEADER_HEIGHT + REGION_PADDING + CARD_HEIGHT + CARD_GAP,
  })
  assert.equal(grid.contentHeight, regionHeightForRows(2))
})

test('缩放被夹在 0.1–2 之间，非数字退回 1', () => {
  assert.equal(clampZoom(0.01), 0.1)
  assert.equal(clampZoom(5), 2)
  assert.equal(clampZoom(Number.NaN), 1)
  assert.equal(clampZoom(1.25), 1.25)
})

test('空画布种子按 3×2 统一footprint、每行两个铺开', () => {
  const seeds = seedRegionsFromWorkspaces([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  assert.equal(seeds.length, 3)
  assert.equal(seeds[0].width, regionWidthForColumns(3))
  assert.equal(seeds[0].height, regionHeightForRows(2))
  assert.deepEqual([seeds[0].x, seeds[0].y], [0, 0])
  assert.equal(seeds[1].x, regionWidthForColumns(3) + 48)
  assert.equal(seeds[1].y, 0)
  assert.equal(seeds[2].x, 0)
  assert.equal(seeds[2].y, regionHeightForRows(2) + 48)
  assert.equal(seeds[2].workspace, 'c')
})

test('货架整理：按渲染高度从高到低铺，只报真的动了的节点', () => {
  const nodes = [
    { id: 1, x: 0, y: 0, width: 200, height: 100 },
    { id: 2, x: 999, y: 999, width: 200, height: 300 },
  ]
  const moves = packLayout(nodes, new Map(), { gap: 10, rowWidth: 1000 })
  // 2 更高，排在前面并落在原点——它本来不在原点，所以要报；1 跟在它右边。
  assert.deepEqual(moves, [
    { id: 2, x: 0, y: 0 },
    { id: 1, x: 210, y: 0 },
  ])
})

test('货架整理用渲染尺寸而不是入账尺寸，展开的卡片才不会压到邻居', () => {
  const nodes = [
    { id: 1, x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT },
    { id: 2, x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT },
  ]
  const rendered = new Map([[1, { width: 520, height: 560 }]])
  const moves = packLayout(nodes, rendered, { gap: 48, rowWidth: 2400 })
  assert.deepEqual(moves, [{ id: 2, x: 568, y: 0 }])
})

// ── 拖拽落点判定 ──

/** 一个自定义区域：能吃卡片。 */
const custom = (id, x, y) => ({
  id,
  kind: 'custom',
  x,
  y,
  width: regionWidthForColumns(3),
  height: regionHeightForRows(2),
})

/** 卡片中心落在 (x, y) 需要的左上角坐标。 */
const centerAt = (x, y) => ({ x: x - CARD_WIDTH / 2, y: y - CARD_HEIGHT / 2 })

const pin = (id, sessionId, x, y) => ({
  id,
  sessionId,
  x,
  y,
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
})

test('落在空白板上就是普通移动，无论卡片从哪来', () => {
  const source = { kind: 'pin', pinId: 7, sessionId: 's7' }
  const hint = computeDropHint(source, { x: 900, y: 900 }, [custom(1, 0, 0)], [])
  assert.deepEqual(hint, { type: 'canvas', x: 900, y: 900 })
})

test('落回自己所属的区域 → same（吸回网格，不发命令）', () => {
  const source = { kind: 'member', regionId: 1, sessionId: 's1' }
  const hint = computeDropHint(source, centerAt(100, 100), [custom(1, 0, 0)], [])
  assert.deepEqual(hint, { type: 'same' })
})

test('落到另一个自定义区域 → 那个区域；重叠时 id 大的（画在上面的）赢', () => {
  const source = { kind: 'pin', pinId: 9, sessionId: 's9' }
  const regions = [custom(1, 0, 0), custom(5, 0, 0)]
  const hint = computeDropHint(source, centerAt(100, 100), regions, [])
  assert.deepEqual(hint, { type: 'region', regionId: 5 })
})

test('落到绑定区域（工作区/智能体）是普通移动，不是拒绝', () => {
  const source = { kind: 'pin', pinId: 9, sessionId: 's9' }
  const bound = { ...custom(1, 0, 0), kind: 'workspace' }
  const pos = centerAt(100, 100)
  assert.deepEqual(computeDropHint(source, pos, [bound], []), {
    type: 'canvas',
    x: pos.x,
    y: pos.y,
  })
})

test('卡片压卡片 → 以静止那张为锚点的两列新框', () => {
  const source = { kind: 'pin', pinId: 9, sessionId: 's9' }
  const target = pin(4, 's4', 400, 400)
  const hint = computeDropHint(source, centerAt(420, 420), [], [target])
  assert.equal(hint.type, 'merge')
  assert.equal(hint.targetPinId, 4)
  assert.equal(hint.targetSessionId, 's4')
  assert.deepEqual(hint.rect, {
    x: 400 - REGION_PADDING,
    y: 400 - REGION_HEADER_HEIGHT - REGION_PADDING,
    width: regionWidthForColumns(2),
    height: regionHeightForRows(1),
  })
})

test('绝不与自己、也不与显示同一会话的另一张卡合并', () => {
  const selfPin = pin(4, 's4', 400, 400)
  const mirror = pin(6, 's9', 400, 400)
  const source = { kind: 'pin', pinId: 4, sessionId: 's4' }
  const pos = centerAt(420, 420)
  assert.equal(computeDropHint(source, pos, [], [selfPin]).type, 'canvas')
  const mirrorSource = { kind: 'pin', pinId: 9, sessionId: 's9' }
  assert.equal(computeDropHint(mirrorSource, pos, [], [mirror]).type, 'canvas')
})

test('区域框里的卡片永远不会成为合并目标', () => {
  const source = { kind: 'pin', pinId: 9, sessionId: 's9' }
  const inside = pin(4, 's4', 100, 100)
  const hint = computeDropHint(source, centerAt(120, 120), [custom(1, 0, 0)], [inside])
  assert.deepEqual(hint, { type: 'region', regionId: 1 })
})

// ── 对齐参考线与点阵吸附 ──

const box = (x, y, width = 100, height = 100) => ({ x, y, width, height })

test('所有线都在容差外时什么都不报', () => {
  const r = computeAlignment(box(0, 0), [box(500, 500)], 6)
  assert.deepEqual(r, { dx: 0, dy: 0, guides: [] })
})

test('差一点的左边缘被吸到邻居的左边缘上，并画出参考线', () => {
  const r = computeAlignment(box(103, 300), [box(100, 0)], 6)
  assert.equal(r.dx, -3)
  assert.equal(r.dy, 0)
  assert.equal(r.guides.length, 1)
  assert.equal(r.guides[0].axis, 'x')
  assert.equal(r.guides[0].at, 100)
  // 参考线只覆盖相关的两个盒子，不是一整条视口长的尺子。
  assert.equal(r.guides[0].from, 0)
  assert.equal(r.guides[0].to, 400)
})

test('两个轴各自独立判定，可以分别对上不同的邻居', () => {
  const r = computeAlignment(box(102, 298), [box(100, 900), box(900, 300)], 6)
  assert.equal(r.dx, -2)
  assert.equal(r.dy, 2)
  assert.equal(r.guides.length, 2)
})

test('多条线都在范围内时取最小的修正量', () => {
  const r = computeAlignment(box(103, 0), [box(100, 0), box(104, 0)], 6)
  assert.equal(r.dx, 1)
})

test('中线也参与对齐，不只是边缘', () => {
  // moving 的中线 x=150+50=200，候选盒中线 x=200 → 差 0；先给个 2 的偏移。
  const r = computeAlignment(box(148, 0), [box(150, 400)], 6)
  assert.equal(r.dx, 2)
})

test('容差不是正数就直接放弃（NaN 会吸到第一个候选上）', () => {
  assert.deepEqual(computeAlignment(box(103, 0), [box(100, 0)], Number.NaN), {
    dx: 0,
    dy: 0,
    guides: [],
  })
  assert.deepEqual(computeAlignment(box(103, 0), [box(100, 0)], 0).guides, [])
})

test('点阵：没有别的候选时吸到最近的点，且不画参考线', () => {
  const r = computeAlignment(box(2, 2), [], 6, BOARD_DOT_GAP)
  assert.equal(r.dx, -2)
  assert.equal(r.dy, -2)
  assert.deepEqual(r.guides, [])
})

test('点阵：邻居赢下它所在的那个轴，另一个轴仍然吸点', () => {
  // x 轴有邻居（100 对 103），y 轴没有 → y 吸到 24 的倍数。
  const r = computeAlignment(box(103, 2), [box(100, 900)], 6, BOARD_DOT_GAP)
  assert.equal(r.dx, -3)
  assert.equal(r.dy, -2)
  assert.equal(r.guides.length, 1)
  assert.equal(r.guides[0].axis, 'x')
})

test('点阵的吸附半径被压到 gap 的四分之一，缩小时也留得下两点之间', () => {
  // 容差 24（相当于板子缩到 25%）但点阵只肯吃 gap/4 = 6。
  assert.equal(computeAlignment(box(6, 0), [], 24, BOARD_DOT_GAP).dx, -6)
  assert.equal(computeAlignment(box(7, 0), [], 24, BOARD_DOT_GAP).dx, 0)
})

test('不传 gap 就没有点阵吸附', () => {
  assert.deepEqual(computeAlignment(box(2, 2), [], 6), { dx: 0, dy: 0, guides: [] })
})

test('参考线跨的是「最终落位」的盒子——含另一个轴的点阵修正', () => {
  // x 轴对上邻居（-3），y 轴吸点（290 → 288，-2）；竖线跨度要用 y-2 之后的盒子算。
  const r = computeAlignment(box(103, 290), [box(100, 0, 100, 100)], 6, BOARD_DOT_GAP)
  assert.equal(r.dx, -3)
  assert.equal(r.dy, -2)
  assert.equal(r.guides.length, 1)
  assert.equal(r.guides[0].from, 0)
  assert.equal(r.guides[0].to, 388)
})

test('区域页脚高度是留出来的一整行 chrome，不是浮层', () => {
  assert.equal(REGION_FOOTER_HEIGHT, 36)
})
