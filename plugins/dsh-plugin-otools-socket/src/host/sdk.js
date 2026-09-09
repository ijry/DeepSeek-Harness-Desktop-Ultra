import { join } from 'node:path'
import { homedir } from 'node:os'

export function dshHomePath(...segments) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...segments)
}
