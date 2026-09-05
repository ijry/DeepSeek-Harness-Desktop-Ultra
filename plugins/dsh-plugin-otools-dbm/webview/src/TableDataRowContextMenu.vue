<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="context-menu-backdrop"
      @click="hideMenu"
      @contextmenu.prevent
    ></div>

    <div
      v-if="visible"
      ref="contextMenuRef"
      class="context-menu"
      :style="{ top: position.y + 'px', left: position.x + 'px' }"
    >
        <el-card shadow="always" class="menu-card">
        <ul class="menu-list">
          <li class="menu-item" @click="handleEdit">
            <el-icon><Edit /></el-icon>
            <span>{{ t('edit') }}</span>
          </li>
          <li class="menu-item" @click="handleCopyRow">
            <el-icon><DocumentCopy /></el-icon>
            <span>{{ t('copyRow') }}</span>
          </li>
          <li class="menu-item" @click="handleCopyAsSql">
            <el-icon><Document /></el-icon>
            <span>{{ t('copyAsSql') }}</span>
          </li>
          <li class="menu-item" @click="handleCopyAsCsv">
            <el-icon><Document /></el-icon>
            <span>{{ t('copyAsCsv') }}</span>
          </li>
          <li class="divider"></li>
          <li class="menu-item danger" @click="handleDelete">
            <el-icon><Delete /></el-icon>
            <span>{{ t('deleteRow') }}</span>
          </li>
        </ul>
      </el-card>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { ElCard, ElIcon } from 'element-plus'
import { Edit, Delete, DocumentCopy, Document } from '@element-plus/icons-vue'
import { useI18nScope } from '@/platform/i18n';

interface Props {
  rowData: any;
  rowIndex: number;
  headers: string[];
  connectionId: string;
  tableName: string;
  databaseName?: string;
}

interface Emits {
  (e: 'edit', row: any): void;
  (e: 'copy-row', row: any): void;
  (e: 'copy-as-sql', row: any): void;
  (e: 'copy-as-csv', row: any): void;
  (e: 'delete', row: any, index: number): void;
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18nScope('dbm.rowContextMenu');

const visible = ref(false)
const position = ref({ x: 0, y: 0 })
const contextMenuRef = ref<HTMLDivElement>()

let currentRow: any = null

const showMenu = (row: any, event: MouseEvent) => {
  currentRow = row
  visible.value = true
  position.value = { x: event.clientX, y: event.clientY }
  
  nextTick(() => {
    if (contextMenuRef.value) {
      const menuRect = contextMenuRef.value.getBoundingClientRect()
      // 确保菜单不超出窗口边界
      if (position.value.y + menuRect.height > window.innerHeight) {
        position.value.y = window.innerHeight - menuRect.height - 10
      }
      if (position.value.x + menuRect.width > window.innerWidth) {
        position.value.x = window.innerWidth - menuRect.width - 10
      }
    }
  })
}

const hideMenu = () => {
  visible.value = false
}

const handleEdit = () => {
  emit('edit', currentRow)
  hideMenu()
}

const handleCopyRow = () => {
  emit('copy-row', currentRow)
  hideMenu()
}

const handleCopyAsSql = () => {
  emit('copy-as-sql', currentRow)
  hideMenu()
}

const handleCopyAsCsv = () => {
  emit('copy-as-csv', currentRow)
  hideMenu()
}

const handleDelete = () => {
  emit('delete', currentRow, props.rowIndex)
  hideMenu()
}

defineExpose({
  showMenu,
  hideMenu
})
</script>

<style scoped>
.context-menu-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9998;
  background: transparent;
}

.context-menu {
  position: fixed;
  z-index: 9999;
}

.menu-card {
  border: 0px solid var(--el-border-color);
  border-radius: 4px;
  box-shadow: 
    0 1px 1px rgba(0, 0, 0, 0.12);
}

.menu-list {
  list-style: none;
  margin: 0;
  /* padding: 4px 0; */
  min-width: 160px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.menu-item:hover {
  background-color: var(--el-fill-color-light);
}

.menu-item.danger {
  color: #f56c6c;
}

.divider {
  height: 1px;
  background-color: var(--el-border-color);
  margin: 4px 0;
}

.el-icon {
  margin-right: 8px;
  width: 16px;
  height: 16px;
}
</style>
