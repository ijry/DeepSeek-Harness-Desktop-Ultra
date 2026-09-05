/**
 * The commit-graph geometry, ported from the reference's BranchGraph.
 *
 * Lanes are assigned in the browser from each row's `parents`, so filtering and
 * paging never wait on a round trip. The algorithm is the reference's: the
 * first-parent chain of the newest commit is pinned to lane 0, a new commit takes
 * the leftmost free lane, and a merge forks downward to its other parents' lanes.
 *
 * Constants (lane gap 14, node radius 4, the 8-colour palette, the deliberate
 * -1 top overlap that hides the antialiasing seam between rows) are verbatim.
 */

/** Lane x for a lane index. */
function laneX(lane) {
  return 10 + lane * GRAPH.laneGap
}

/** Lane colour, cycling through the palette. */
function laneColor(lane) {
  return LANE_COLORS[Math.abs(lane) % LANE_COLORS.length]
}

/**
 * Assign lanes to a page of rows.
 *
 * @param rows - history rows, newest first, each with `hash` and `parents`.
 * @returns one entry per row: `{ lane, lanesBefore, lanesAfter, parentLanes,
 *   incomingLanes, suppressMerge, laneCount }`
 */
function computeGraph(rows) {
  const indexOf = new Map()
  rows.forEach((row, index) => indexOf.set(row.hash, index))
  // Short-hash fallback: a parent may be abbreviated in a filtered page.
  const resolveIndex = (hash) => {
    if (indexOf.has(hash)) return indexOf.get(hash)
    for (const [full, index] of indexOf) {
      if (full.startsWith(hash) || hash.startsWith(full)) return index
    }
    return -1
  }

  // `lanes[i]` holds the hash the lane is currently waiting for, or null.
  const lanes = []
  const out = []
  let maxLane = 0

  // The first row's first-parent chain owns lane 0 all the way down, so the
  // mainline reads as one straight line instead of drifting right.
  const mainline = new Set()
  if (rows.length > 0) {
    let cursor = 0
    while (cursor !== -1 && cursor < rows.length) {
      mainline.add(rows[cursor].hash)
      const parent = rows[cursor].parents[0]
      cursor = parent === undefined ? -1 : resolveIndex(parent)
    }
  }

  rows.forEach((row, index) => {
    const lanesBefore = lanes.map((hash) => (hash === null ? null : 1))
    // Which lane is this commit already expected in?
    let lane = lanes.indexOf(row.hash)
    if (lane === -1) {
      lane = mainline.has(row.hash) && (lanes[0] === null || lanes[0] === undefined) ? 0 : lanes.indexOf(null)
      if (lane === -1) lane = lanes.length
    }
    // Keep the mainline on lane 0 even when something else grabbed it first.
    if (mainline.has(row.hash) && lane !== 0) {
      const occupant = lanes[0]
      lanes[0] = row.hash
      lanes[lane] = occupant ?? null
      lane = 0
    }
    lanes[lane] = row.hash

    // Other lanes waiting for the same commit merge into this node.
    const incomingLanes = []
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== lane && lanes[i] === row.hash) {
        incomingLanes.push(i)
        lanes[i] = null
      }
    }

    // Place the parents. The first parent inherits this lane; the rest take a
    // free lane to the right, preferring one that is already free.
    const visibleParents = row.parents.filter((parent) => resolveIndex(parent) > index)
    const parentLanes = []
    const suppressMerge = []
    lanes[lane] = null
    visibleParents.forEach((parent, order) => {
      if (order === 0) {
        lanes[lane] = parent
        parentLanes.push(lane)
        return
      }
      let target = lanes.indexOf(parent)
      if (target === -1) {
        target = -1
        for (let i = lane + 1; i < lanes.length; i += 1) {
          if (lanes[i] === null) {
            target = i
            break
          }
        }
        if (target === -1) target = lanes.length
      }
      lanes[target] = parent
      parentLanes.push(target)
    })
    // A single parent that already lives in another lane is drawn as that row's
    // INCOMING edge instead of as a fork from here, which is what keeps a long
    // side branch from growing a spurious diagonal at every step.
    if (visibleParents.length === 1 && parentLanes[0] !== lane) suppressMerge.push(parentLanes[0])
    // When filters hide a commit's parents, chain the next visible row into the
    // same lane so the column stays continuous rather than breaking into dashes.
    if (visibleParents.length === 0 && index + 1 < rows.length && lanes[lane] === null) {
      lanes[lane] = rows[index + 1].hash
    }

    maxLane = Math.max(maxLane, lane, ...parentLanes, ...incomingLanes, lanes.length - 1)
    out.push({
      lane,
      lanesBefore,
      lanesAfter: lanes.map((hash) => (hash === null ? null : 1)),
      parentLanes,
      incomingLanes,
      suppressMerge,
      isMerge: row.parents.length > 1,
    })
  })

  const laneCount = maxLane + 1
  for (const entry of out) {
    entry.laneCount = laneCount
    entry.lanesBefore.length = laneCount
    entry.lanesAfter.length = laneCount
  }
  return out
}

/** The SVG width one graph cell needs. */
function graphWidth(laneCount) {
  return GRAPH.sidePadding + Math.max(1, laneCount) * GRAPH.laneGap
}

/**
 * Draw one row's cell. Painted in the reference's order — straight lane runs,
 * then the downward merge forks, then the upward joins, then the node — so the
 * node always sits on top of every line that touches it.
 */
function graphCell(entry, rowHeight) {
  const height = Math.max(rowHeight ?? GRAPH.rowHeight, 12)
  const width = graphWidth(entry.laneCount)
  const centerY = height / 2
  const bottomY = height + 1
  const node = svg('svg', {
    class: 'dsh-og-graph-svg',
    width,
    height: '100%',
    viewBox: '0 ' + GRAPH.topY + ' ' + width + ' ' + (height + 2),
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  })

  // Where a fork/join leaves the node vertically — 45% of the way to the edge,
  // which is what gives the reference's edges their gentle elbow.
  const mergeTurnY = entry.parentLanes.some((lane) => lane !== entry.lane)
    ? centerY + (bottomY - centerY) * 0.45
    : undefined
  const incomingTurnY = entry.incomingLanes.length > 0
    ? centerY - (centerY - GRAPH.topY) * 0.45
    : undefined

  for (let lane = 0; lane < entry.laneCount; lane += 1) {
    const before = lane === entry.lane
      ? entry.lanesBefore[lane] !== null && entry.lanesBefore[lane] !== undefined
      : entry.lanesBefore[lane] !== null && entry.lanesBefore[lane] !== undefined
    const after = entry.lanesAfter[lane] !== null && entry.lanesAfter[lane] !== undefined
    if (!before && !after) continue
    let y1 = GRAPH.topY
    let y2 = bottomY
    if (!before) y1 = lane === entry.lane ? centerY : (mergeTurnY ?? centerY)
    if (!after) y2 = lane === entry.lane ? centerY : (incomingTurnY ?? centerY)
    if (y2 <= y1) continue
    node.append(svg('line', {
      x1: laneX(lane), x2: laneX(lane), y1, y2,
      stroke: laneColor(lane), 'stroke-width': 2, 'stroke-linecap': 'butt',
    }))
  }

  for (const target of entry.parentLanes) {
    if (target === entry.lane || entry.suppressMerge.includes(target)) continue
    const turnY = centerY + (bottomY - centerY) * 0.45
    node.append(svg('path', {
      d: 'M ' + laneX(entry.lane) + ' ' + centerY + ' L ' + laneX(target) + ' ' + turnY +
        ' L ' + laneX(target) + ' ' + bottomY,
      fill: 'none', stroke: laneColor(target), 'stroke-width': 2, 'stroke-linejoin': 'round',
    }))
  }

  for (const source of entry.incomingLanes) {
    const turnY = centerY - (centerY - GRAPH.topY) * 0.45
    node.append(svg('path', {
      d: 'M ' + laneX(source) + ' ' + GRAPH.topY + ' L ' + laneX(source) + ' ' + turnY +
        ' L ' + laneX(entry.lane) + ' ' + centerY,
      fill: 'none', stroke: laneColor(source), 'stroke-width': 2, 'stroke-linejoin': 'round',
    }))
  }

  node.append(svg('circle', {
    cx: laneX(entry.lane),
    cy: centerY,
    r: entry.isMerge === true ? GRAPH.nodeRadius + 1 : GRAPH.nodeRadius,
    fill: laneColor(entry.lane),
    stroke: 'var(--og-bg)',
    'stroke-width': 1.5,
  }))
  return node
}
