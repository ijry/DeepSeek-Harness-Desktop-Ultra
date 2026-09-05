// Audit: no Chinese wording may vanish while a plugin is made bilingual.
//
// Compares HEAD against the working tree over a whole directory and reports any
// run of Chinese characters that existed before and appears nowhere after. Runs
// rather than string literals on purpose: strings legitimately move between files
// and gain `${...}` holes when they become functions, but the wording itself must
// survive character for character.
//
// Usage: node scripts/audit-zh.mjs <dir> [...]
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * Maximal runs of Chinese characters only — no punctuation, no interpolation.
 *
 * Deliberately coarse. A phrase that becomes a function gains `${...}` holes and
 * often moves its separator into the translation (`保存失败` → `保存失败：${m}`),
 * and neither is a change in wording. What must never happen is a run of Chinese
 * quietly disappearing or being retyped.
 */
const RUN = /[一-鿿]+/g

function runs(source) {
  return new Set(source.match(RUN) ?? [])
}

function tracked(dir) {
  return execSync(`git ls-files -- ${dir}`, { maxBuffer: 1e8 })
    .toString()
    .split('\n')
    .filter((path) => /\.(js|mjs|ts|tsx|rs)$/.test(path))
}

let bad = 0
for (const dir of process.argv.slice(2)) {
  const before = new Set()
  const after = new Set()
  for (const path of tracked(dir)) {
    // A file may be deleted in the working tree, or added since HEAD.
    try {
      for (const run of runs(execSync(`git show HEAD:${path}`, { maxBuffer: 1e8 }).toString())) {
        before.add(run)
      }
    } catch {}
    try {
      for (const run of runs(readFileSync(path, 'utf8'))) after.add(run)
    } catch {}
  }
  // Files added since HEAD are not in git ls-files output when untracked; sweep them too.
  const untracked = execSync(`git ls-files --others --exclude-standard -- ${dir}`, { maxBuffer: 1e8 })
    .toString()
    .split('\n')
    .filter((path) => /\.(js|mjs|ts|tsx|rs)$/.test(path))
  for (const path of untracked) {
    for (const run of runs(readFileSync(path, 'utf8'))) after.add(run)
  }

  const lost = [...before].filter((run) => !after.has(run))
  console.log(`${dir}: ${before.size} zh run(s) at HEAD, ${lost.length} now absent`)
  for (const run of lost.slice(0, 25)) console.log(`    LOST: ${run}`)
  bad += lost.length
}
process.exit(bad === 0 ? 0 : 1)
