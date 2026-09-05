/**
 * "Show me this file on disk".
 *
 * The reference opened the OTools file window, or handed the path to the OS file
 * manager when it was running natively. Here the host does the revealing —
 * `explorer` / `open` / `xdg-open` on the machine that owns the file — and the
 * panel only reports whether that worked.
 */
import { ElMessage } from 'element-plus'

import { revealHostPath } from '@/utils/hostFs'

import { t } from '../i18n'

export interface FsWindowRequest {
  title?: string
  defaultPath?: string
}

export const openHostFsWindow = async (
  path?: string,
  _options: FsWindowRequest = {},
): Promise<void> => {
  const target = String(path || '').trim()
  if (!target) {
    return
  }

  try {
    await revealHostPath(target)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ElMessage.warning(
      t('dbm.fsWindow.revealFailed', { path: target, error: detail }, `无法打开 ${target}：${detail}`),
    )
  }
}
