/**
 * Lazy driver loading.
 *
 * Every database driver is imported on first use, never at plugin load. Two
 * reasons, both learned the hard way in this repo's other plugins:
 *
 * 1. A plugin that throws while loading takes the whole dsh web boot with it. A
 *    missing optional driver (oracledb, snowflake-sdk) must degrade to "Oracle 驱动
 *    未安装" inside the panel, not a blank page.
 * 2. Loading fourteen drivers to open one MySQL connection costs a second of
 *    startup for nothing.
 *
 * @module dsh-plugin-otools-dbm/host/engines/drivers/load
 */
import { DbmError, ERR } from '../../../shared/protocol.js'

const cache = new Map()

/** Packages that are optionalDependencies, with the install hint to show. */
const OPTIONAL = {
  oracledb: 'npm install oracledb',
  'snowflake-sdk': 'npm install snowflake-sdk',
  dmdb: 'npm install dmdb',
}

/**
 * Import a driver package once.
 * @param name - the npm package name.
 * @param label - engine name for the error message ('Oracle', 'Redis'…).
 */
export async function loadDriver(name, label) {
  const hit = cache.get(name)
  if (hit !== undefined) {
    return hit
  }
  try {
    const module = await import(name)
    const resolved = module?.default ?? module
    cache.set(name, resolved)
    return resolved
  } catch (error) {
    const hint = OPTIONAL[name]
    const detail = hint === undefined
      ? `请在插件目录执行 npm install`
      : `它是可选依赖，请执行 ${hint}`
    throw new DbmError(
      ERR.driverMissing,
      `${label} 驱动 ${name} 没有安装：${detail}（原始错误：${String(error?.message ?? error)}）`,
      { cause: error },
    )
  }
}

/** Named export of a driver package, for the `{ Client }`-style ones. */
export async function loadDriverNamed(name, label, exported) {
  const module = await import(name).catch((error) => {
    const hint = OPTIONAL[name]
    const detail = hint === undefined ? '请在插件目录执行 npm install' : `它是可选依赖，请执行 ${hint}`
    throw new DbmError(
      ERR.driverMissing,
      `${label} 驱动 ${name} 没有安装：${detail}（原始错误：${String(error?.message ?? error)}）`,
      { cause: error },
    )
  })
  const value = module?.[exported] ?? module?.default?.[exported]
  if (value === undefined) {
    throw new DbmError(ERR.driverMissing, `${label} 驱动 ${name} 缺少导出 ${exported}`)
  }
  return value
}

/** Whether a package can be resolved, without throwing. Used by diagnostics. */
export async function driverAvailable(name) {
  try {
    await import(name)
    return true
  } catch {
    return false
  }
}
