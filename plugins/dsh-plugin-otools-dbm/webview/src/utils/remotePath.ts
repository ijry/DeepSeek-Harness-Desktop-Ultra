import { homeHostDir, joinHostPath, pluginDataHostDir } from './hostFs'

export const homeDir = async (): Promise<string> => {
  return homeHostDir()
}

/** 本插件的数据目录（<DSH home>/plugins/dsh-plugin-otools-dbm/）。 */
export const pluginDataDir = async (): Promise<string> => {
  return pluginDataHostDir()
}

export const join = async (...paths: string[]): Promise<string> => {
  return joinHostPath(...paths)
}
