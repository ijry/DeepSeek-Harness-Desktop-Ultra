<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    width="720px"
    :close-on-click-modal="false"
    append-to-body
    class="host-path-picker"
    @closed="handleClosed"
  >
    <div class="hpp-toolbar">
      <el-button-group>
        <el-button :icon="Back" :disabled="!parentPath" @click="goUp">
          {{ t('dbm.pathPicker.up', undefined, '上一级') }}
        </el-button>
        <el-button :icon="HomeFilled" @click="goHome">
          {{ t('dbm.pathPicker.home', undefined, '主目录') }}
        </el-button>
        <el-button :icon="Refresh" @click="() => load(currentPath)">
          {{ t('dbm.pathPicker.refresh', undefined, '刷新') }}
        </el-button>
        <el-button :icon="FolderAdd" @click="createDirectory">
          {{ t('dbm.pathPicker.newFolder', undefined, '新建文件夹') }}
        </el-button>
      </el-button-group>
      <el-input
        v-model="pathInput"
        class="hpp-path"
        :placeholder="t('dbm.pathPicker.pathPlaceholder', undefined, '输入目录路径后回车')"
        @keyup.enter="load(pathInput)"
      />
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      height="320"
      size="small"
      highlight-current-row
      :row-class-name="rowClassName"
      @row-click="handleRowClick"
      @row-dblclick="handleRowDblClick"
      @selection-change="handleSelectionChange"
    >
      <el-table-column v-if="multiple && mode === 'open'" type="selection" width="42" />
      <el-table-column :label="t('dbm.pathPicker.name', undefined, '名称')" min-width="260">
        <template #default="{ row }">
          <span class="hpp-name">
            <el-icon>
              <Folder v-if="row.isDir" />
              <Document v-else />
            </el-icon>
            <span>{{ row.name }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('dbm.pathPicker.size', undefined, '大小')" width="120" align="right">
        <template #default="{ row }">
          <span>{{ row.isDir ? '—' : formatBytes(row.size) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('dbm.pathPicker.modified', undefined, '修改时间')" width="180">
        <template #default="{ row }">
          <span>{{ formatTime(row.modifiedAt) }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="mode === 'save'" class="hpp-filename">
      <span class="hpp-filename-label">{{ t('dbm.pathPicker.fileName', undefined, '文件名') }}</span>
      <el-input v-model="fileName" :placeholder="t('dbm.pathPicker.fileNamePlaceholder', undefined, '请输入文件名')" />
    </div>

    <div v-if="error" class="hpp-error">{{ error }}</div>

    <template #footer>
      <span class="hpp-selection" :title="selectionLabel">{{ selectionLabel }}</span>
      <el-button @click="cancel">{{ t('dbm.pathPicker.cancel', undefined, '取消') }}</el-button>
      <el-button type="primary" :disabled="!canConfirm" @click="confirm">
        {{ t('dbm.pathPicker.confirm', undefined, '确定') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Back, Document, Folder, FolderAdd, HomeFilled, Refresh } from '@element-plus/icons-vue'

import { t } from '@/platform/i18n'
import {
  createHostDir,
  homeHostDir,
  joinHostPath,
  listHostDir,
  type HostDirEntry,
} from '@/utils/hostFs'

const props = withDefaults(
  defineProps<{
    mode?: 'open' | 'directory' | 'save'
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
    multiple?: boolean
  }>(),
  { mode: 'open', multiple: false },
)

const emit = defineEmits<{
  (event: 'picked', value: string | string[] | null): void
  (event: 'cancelled'): void
}>()

const visible = ref(true)
const loading = ref(false)
const error = ref('')
const currentPath = ref('')
const parentPath = ref('')
const pathInput = ref('')
const entries = ref<HostDirEntry[]>([])
const fileName = ref('')
const activeRow = ref<HostDirEntry | null>(null)
const checkedRows = ref<HostDirEntry[]>([])
let resolved = false

const mode = computed(() => props.mode)
const multiple = computed(() => props.multiple === true)

const dialogTitle = computed(() => {
  if (props.title) {
    return props.title
  }
  if (mode.value === 'directory') {
    return t('dbm.pathPicker.titleDirectory', undefined, '选择目录')
  }
  if (mode.value === 'save') {
    return t('dbm.pathPicker.titleSave', undefined, '选择保存位置')
  }
  return t('dbm.pathPicker.titleOpen', undefined, '选择文件')
})

const allowedExtensions = computed(() => {
  const list = (props.filters || [])
    .flatMap((filter) => filter.extensions || [])
    .map((item) => String(item || '').replace(/^\./, '').toLowerCase())
    .filter((item) => item && item !== '*')
  return Array.from(new Set(list))
})

const matchesFilter = (entry: HostDirEntry) => {
  if (entry.isDir || allowedExtensions.value.length === 0) {
    return true
  }
  const extension = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : ''
  return allowedExtensions.value.includes(extension)
}

const rows = computed(() => {
  const list = entries.value.filter((entry) => (mode.value === 'directory' ? entry.isDir : matchesFilter(entry)))
  return list.slice().sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1
    }
    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
})

const selectionLabel = computed(() => {
  if (mode.value === 'directory') {
    return currentPath.value
  }
  if (mode.value === 'save') {
    return fileName.value ? `${currentPath.value} / ${fileName.value}` : currentPath.value
  }
  if (multiple.value && checkedRows.value.length > 0) {
    return t('dbm.pathPicker.selectedCount', { count: checkedRows.value.length }, `已选 ${checkedRows.value.length} 个文件`)
  }
  return activeRow.value ? activeRow.value.path : currentPath.value
})

const canConfirm = computed(() => {
  if (mode.value === 'directory') {
    return !!currentPath.value
  }
  if (mode.value === 'save') {
    return !!currentPath.value && !!fileName.value.trim()
  }
  if (multiple.value && checkedRows.value.length > 0) {
    return true
  }
  return !!activeRow.value && !activeRow.value.isDir
})

const formatBytes = (bytes?: number) => {
  const value = Number(bytes) || 0
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const formatTime = (value?: number) => {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const rowClassName = ({ row }: { row: HostDirEntry }) =>
  activeRow.value && activeRow.value.path === row.path ? 'hpp-row-active' : ''

const load = async (path?: string) => {
  loading.value = true
  error.value = ''
  try {
    const listing = await listHostDir(path || '')
    currentPath.value = listing.path
    parentPath.value = listing.parent || ''
    pathInput.value = listing.path
    entries.value = listing.entries
    activeRow.value = null
    checkedRows.value = []
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

const goUp = () => {
  if (parentPath.value) {
    void load(parentPath.value)
  }
}

const goHome = async () => {
  try {
    await load(await homeHostDir())
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

const createDirectory = async () => {
  try {
    const answer = await ElMessageBox.prompt(
      t('dbm.pathPicker.newFolderPrompt', undefined, '请输入新文件夹名称'),
      t('dbm.pathPicker.newFolder', undefined, '新建文件夹'),
      { inputPattern: /^[^\\/:*?"<>|]+$/, inputErrorMessage: t('dbm.pathPicker.invalidName', undefined, '名称不合法') },
    )
    const created = await joinHostPath(currentPath.value, String(answer.value || '').trim())
    await createHostDir(created)
    await load(currentPath.value)
    ElMessage.success(t('dbm.pathPicker.newFolderCreated', undefined, '文件夹已创建'))
  } catch (reason) {
    if (reason === 'cancel' || reason === 'close') {
      return
    }
    ElMessage.error(reason instanceof Error ? reason.message : String(reason))
  }
}

const handleRowClick = (row: HostDirEntry) => {
  activeRow.value = row
  if (!row.isDir && mode.value === 'save') {
    fileName.value = row.name
  }
}

const handleRowDblClick = (row: HostDirEntry) => {
  if (row.isDir) {
    void load(row.path)
    return
  }
  if (mode.value === 'open') {
    activeRow.value = row
    confirm()
  }
}

const handleSelectionChange = (selection: HostDirEntry[]) => {
  checkedRows.value = selection.filter((row) => !row.isDir)
}

const settle = (value: string | string[] | null) => {
  if (resolved) {
    return
  }
  resolved = true
  visible.value = false
  emit('picked', value)
}

const confirm = async () => {
  if (mode.value === 'directory') {
    settle(currentPath.value)
    return
  }
  if (mode.value === 'save') {
    settle(await joinHostPath(currentPath.value, fileName.value.trim()))
    return
  }
  if (multiple.value && checkedRows.value.length > 0) {
    settle(checkedRows.value.map((row) => row.path))
    return
  }
  if (activeRow.value && !activeRow.value.isDir) {
    settle(activeRow.value.path)
  }
}

const cancel = () => {
  if (resolved) {
    return
  }
  resolved = true
  visible.value = false
  emit('cancelled')
}

const handleClosed = () => {
  if (!resolved) {
    resolved = true
    emit('cancelled')
  }
}

onMounted(async () => {
  const seed = String(props.defaultPath || '').trim()
  if (seed) {
    const known = seed.replace(/[\\/]+$/, '')
    const separator = known.includes('\\') ? '\\' : '/'
    const cut = known.lastIndexOf(separator)
    const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(known)
    if (looksLikeFile && cut > 0) {
      fileName.value = known.slice(cut + 1)
      await load(known.slice(0, cut))
      return
    }
    await load(known)
    return
  }
  await goHome()
})
</script>

<style scoped>
.hpp-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.hpp-path {
  flex: 1;
  min-width: 0;
}

.hpp-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hpp-filename {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.hpp-filename-label {
  flex: none;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.hpp-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-color-danger);
  word-break: break-all;
}

.hpp-selection {
  float: left;
  max-width: 380px;
  overflow: hidden;
  font-size: 12px;
  line-height: 32px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.hpp-row-active) {
  background: var(--el-color-primary-light-9);
}
</style>
