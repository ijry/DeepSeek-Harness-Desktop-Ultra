import { homeHostDir, joinHostPath } from './hostFs'

export const homeDir = async (): Promise<string> => {
  return homeHostDir()
}

export const join = async (...paths: string[]): Promise<string> => {
  return joinHostPath(...paths)
}
