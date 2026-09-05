<template>
  <div
    v-if="visible"
    class="custom-context-menu"
    :style="{ top: position.y + 'px', left: position.x + 'px' }"
    @click.stop
  >
    <ul class="menu-list">
      <!-- 数据库/表节点菜单 -->
      <template v-if="nodeType === 'database' || nodeType === 'table'">
        <li class="menu-item" @click="handleExport">
          <el-icon><Download /></el-icon>
          <span>{{ nodeType === 'database' ? t('database.export') : t('table.export') }}</span>
        </li>
        <li class="menu-item" @click="handleImport">
          <el-icon><Upload /></el-icon>
          <span>{{ nodeType === 'database' ? t('database.import') : t('table.import') }}</span>
        </li>
        <li v-if="nodeType === 'table'" class="menu-item danger" @click="handleDropTable">
          <el-icon><Delete /></el-icon>
          <span>{{ t('table.drop') }}</span>
        </li>
        <li v-if="canCreateSchema" class="menu-item" @click="handleCreateSchema">
          <el-icon><Plus /></el-icon>
          <span>{{ t('schema.create') }}</span>
        </li>
      </template>
      <template v-if="nodeType === 'schema'">
        <li v-if="canRenameSchema" class="menu-item" @click="handleRenameSchema">
          <el-icon><Edit /></el-icon>
          <span>{{ t('schema.rename') }}</span>
        </li>
        <li v-if="canDropSchema" class="menu-item danger" @click="handleDropSchema">
          <el-icon><Delete /></el-icon>
          <span>{{ t('schema.drop') }}</span>
        </li>
      </template>
      <!-- 视图文件夹菜单 -->
      <template v-if="nodeType === 'views-folder'">
        <li class="menu-item" @click="handleCreateView">
          <el-icon><Plus /></el-icon>
          <span>{{ t('view.create') }}</span>
        </li>
      </template>
      <!-- 视图节点菜单 -->
      <template v-if="nodeType === 'view'">
        <li class="menu-item" @click="handleViewDefinition">
          <el-icon><View /></el-icon>
          <span>{{ t('common.viewDefinition') }}</span>
        </li>
        <li class="menu-item" @click="handleDropView">
          <el-icon><Delete /></el-icon>
          <span>{{ t('view.drop') }}</span>
        </li>
      </template>
      <!-- 存储过程文件夹菜单 -->
      <template v-if="nodeType === 'procedures-folder'">
        <li class="menu-item" @click="handleCreateProcedure">
          <el-icon><Plus /></el-icon>
          <span>{{ t('procedure.create') }}</span>
        </li>
      </template>
      <!-- 存储过程节点菜单 -->
      <template v-if="nodeType === 'procedure'">
        <li class="menu-item" @click="handleViewProcedure">
          <el-icon><View /></el-icon>
          <span>{{ t('common.viewDefinition') }}</span>
        </li>
        <li class="menu-item" @click="handleDropProcedure">
          <el-icon><Delete /></el-icon>
          <span>{{ t('procedure.drop') }}</span>
        </li>
      </template>
    </ul>
  </div>
  <ExportDatabaseDialog
    v-model="exportDialogVisible"
    :tables="exportTables"
    @confirm="handleExportDatabaseConfirm"
  />
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, h, defineComponent } from 'vue';
import { ElIcon, ElMessage, ElMessageBox, ElSelect, ElOption } from 'element-plus';
import { Download, Upload, Plus, Delete, View, Edit } from '@element-plus/icons-vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import ExportDatabaseDialog from './ExportDatabaseDialog.vue';
import { useI18nScope } from '@/platform/i18n';

// 定义组件属性
interface Props {
  nodeType: 'database' | 'schema' | 'table' | 'view' | 'procedure' | 'views-folder' | 'procedures-folder';
  nodeId: string;
  nodeLabel: string;
  dbId: string;
  dbType?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
}

const props = defineProps<Props>();
const { t } = useI18nScope('dbm.contextMenu');

// 定义事件
const emit = defineEmits<{
  close: [],
  'export-table': [connectionId: string, tableName: string, databaseName?: string, schemaName?: string],
  'open-view': [connectionId: string, viewName: string, databaseName?: string, schemaName?: string],
  'open-procedure': [connectionId: string, procedureName: string, databaseName?: string, schemaName?: string],
  'create-schema': [connectionId: string, databaseName: string],
  'rename-schema': [connectionId: string, databaseName: string, schemaName: string],
  'drop-schema': [connectionId: string, databaseName: string, schemaName: string],
  'create-view': [connectionId: string, databaseName: string, schemaName?: string],
  'create-procedure': [connectionId: string, databaseName: string, schemaName?: string],
  'drop-table': [connectionId: string, tableName: string, databaseName: string, schemaName?: string],
  'drop-view': [connectionId: string, viewName: string, databaseName: string, schemaName?: string],
  'drop-procedure': [connectionId: string, procedureName: string, databaseName: string, schemaName?: string],
  'refresh-tree': []
}>();

// 菜单位置和可见性
const position = ref({ x: 0, y: 0 });
const visible = ref(false);
const exportDialogVisible = ref(false);
const exportTables = ref<string[]>([]);
const normalizedDbType = computed(() => props.dbType?.toLowerCase() || '');
const canCreateSchema = computed(() =>
  props.nodeType === 'database' && ['postgresql', 'sqlserver', 'kingbasees'].includes(normalizedDbType.value)
);
const canRenameSchema = computed(() =>
  props.nodeType === 'schema' && ['postgresql', 'kingbasees'].includes(normalizedDbType.value)
);
const canDropSchema = computed(() =>
  props.nodeType === 'schema' && ['postgresql', 'kingbasees'].includes(normalizedDbType.value)
);

// 显示菜单
const showMenu = (x: number, y: number) => {
  position.value = { x, y };
  visible.value = true;
};

// 隐藏菜单
const hideMenu = () => {
  visible.value = false;
  emit('close');
};

// 处理导出
const handleExport = async () => {
  hideMenu();
  if (props.nodeType === 'database') {
    // 数据库导出 - 显示包含该数据库下所有表的对话框，允许选择格式
    showExportDatabaseDialog();
  } else if (props.nodeType === 'table') {
    // 表导出 - 使用TableContent的导出逻辑
    emit('export-table', props.dbId, props.tableName!, props.dbName, props.schemaName);
  }
};

// 显示数据库导出对话框
const showExportDatabaseDialog = async () => {
  try {
    // 获取当前数据库的所有表
    const { DbmApi } = await import('@/utils/dbm');
    const tables = await DbmApi.getTables(props.dbId, props.nodeLabel);
    
    if (tables.length === 0) {
      ElMessage.warning(t('messages.databaseHasNoTables'));
      return;
    }
    exportTables.value = tables;
    exportDialogVisible.value = true;
  } catch (error) {
    console.error('获取表列表失败:', error);
    ElMessage.error(t('messages.getTablesFailed', { error: String(error) }));
  }
};

const handleExportDatabaseConfirm = async (payload: {
  selectedTables: string[];
  selectedFormat: 'excel' | 'sql';
}) => {
  if (!payload.selectedTables || payload.selectedTables.length === 0) {
    ElMessage.warning(t('messages.selectAtLeastOneTable'));
    return;
  }

  if (!['excel', 'sql'].includes(payload.selectedFormat)) {
    ElMessage.warning(t('messages.selectValidExportFormat'));
    return;
  }

  exportDialogVisible.value = false;
  try {
    // 调用后端API启动多表导出任务
    const { exportMultipleTables } = await import('@/utils/dbm');
    const taskId = await exportMultipleTables(
      props.dbId,
      props.nodeLabel,
      payload.selectedTables,
      payload.selectedFormat
    );
    
    ElMessage.success(t('messages.exportTaskStarted', { count: payload.selectedTables.length, taskId }));
  } catch (error) {
    console.error('启动多表导出任务失败:', error);
    ElMessage.error(t('messages.startMultiExportFailed', { error: String(error) }));
  }
};

// 处理导入
const handleImport = async () => {
  hideMenu();
  if (props.nodeType === 'database') {
    // 数据库导入 - 只支持SQL文件
    importDatabaseFromSql();
  } else if (props.nodeType === 'table') {
    // 表导入 - 支持EXCEL、CSV、SQL
    showImportTableDialog();
  }
};

const handleDropTable = () => {
  hideMenu();
  emit('drop-table', props.dbId, props.nodeLabel, props.dbName || '', props.schemaName);
};

// 从SQL文件导入数据库
const importDatabaseFromSql = async () => {
  try {
    const selectedPath = await open({
      filters: [{
        name: t('filters.sqlFiles'),
        extensions: ['sql']
      }],
      multiple: false
    });
    
    if (!selectedPath) return;
    
    // 调用后端导入功能，现在返回任务ID
    const { DbmApi } = await import('@/utils/dbm');
    const taskId = await DbmApi.importDatabaseFromSql(props.dbId, props.nodeLabel, selectedPath as string);
    
    ElMessage.success(t('messages.importDatabaseStarted', { taskId }));
  } catch (error) {
    console.error('导入数据库失败:', error);
    ElMessage.error(t('messages.importDatabaseFailed', { error: String(error) }));
  }
};

// 显示表导入对话框
const showImportTableDialog = async () => {
  try {
    // 选择文件
    const selectedPath = await open({
      filters: [
        {
          name: t('filters.dataFiles'),
          extensions: ['csv', 'xlsx', 'xls', 'sql']
        }
      ],
      multiple: false
    });
    
    if (!selectedPath) return;
    
    const filePath = selectedPath as string;
    const fileExtension = filePath.split('.').pop()?.toLowerCase();
    
    if (!fileExtension) return;
    
    // 根据文件类型处理导入
    switch (fileExtension) {
      case 'csv':
      case 'xlsx':
      case 'xls':
        // EXCEL、CSV导入需要解析第一行，然后提供字段映射
        await handleExcelOrCsvImport(filePath);
        break;
      case 'sql':
        // SQL导入直接执行
        await importTableFromSql(filePath);
        break;
      default:
        ElMessage.error(t('messages.unsupportedFileFormat'));
    }
  } catch (error) {
    console.error('导入表失败:', error);
    ElMessage.error(t('messages.importTableFailed', { error: String(error) }));
  }
};

// 处理Excel或CSV导入
const handleExcelOrCsvImport = async (filePath: string) => {
  try {
    // 首先解析文件获取头部信息
    const { DbmApi } = await import('@/utils/dbm');
    
    // 获取表的列结构
    const tableStruct = await DbmApi.getTableStruct(
      props.dbId,
      props.dbName,
      props.tableName!,
      props.schemaName
    );
    
    // 获取CSV/Excel文件的头部信息
    const headers = await DbmApi.getFileHeaders(filePath);
    
    const columnMappings = ref<Record<string, string | null>>({});
    for (const column of tableStruct.columns) {
      columnMappings.value[column.name] = null;
    }

    const MappingDialogContent = defineComponent({
      setup() {
        return () =>
          h('div', { class: 'field-mapping-container' }, [
            h('h4', t('mapping.header')),
            h(
              'div',
              { class: 'mapping-list' },
              tableStruct.columns.map((column) =>
                h('div', { key: column.name, class: 'mapping-row' }, [
                  h('strong', `${column.name} (${column.data_type})`),
                  h(
                    ElSelect,
                    {
                      modelValue: columnMappings.value[column.name],
                      'onUpdate:modelValue': (value: string | null) => {
                        columnMappings.value[column.name] = value;
                      },
                      placeholder: t('mapping.selectColumn'),
                      style: 'width: 200px; margin-left: 10px;'
                    },
                    () => [
                      h(ElOption, { label: t('mapping.skipColumn'), value: null }),
                      ...headers.map((header) =>
                        h(ElOption, {
                          key: header,
                          label: header,
                          value: header
                        })
                      )
                    ]
                  )
                ])
              )
            )
          ]);
      }
    });

    try {
      await ElMessageBox({
        title: t('mapping.title'),
        message: h(MappingDialogContent),
        showCancelButton: true,
        confirmButtonText: t('mapping.confirm'),
        cancelButtonText: t('mapping.cancel'),
        customClass: 'field-mapping-dialog',
        width: '700px'
      });
    } catch {
      return;
    }

    // 调用后端导入功能，现在返回任务ID
    const taskId = await DbmApi.importTableFromDataFile(
      props.dbId,
      props.dbName!,
      props.tableName!,
      filePath,
      columnMappings.value,
      props.schemaName
    );
    
    ElMessage.success(t('messages.importTableStarted', { taskId }));
  } catch (error) {
    console.error('处理Excel或CSV导入失败:', error);
    ElMessage.error(t('messages.handleDataImportFailed', { error: String(error) }));
  }
};

// 从SQL文件导入表
const importTableFromSql = async (filePath: string) => {
  try {
    // 调用后端导入功能，现在返回任务ID
    const { DbmApi } = await import('@/utils/dbm');
    const taskId = await DbmApi.importTableFromSql(
      props.dbId,
      props.dbName!,
      props.tableName!,
      filePath,
      props.schemaName
    );
    
    ElMessage.success(t('messages.importTableStarted', { taskId }));
  } catch (error) {
    console.error('导入表失败:', error);
    ElMessage.error(t('messages.importTableFailed', { error: String(error) }));
  }
};

// 视图相关操作
const handleCreateView = () => {
  hideMenu();
  emit('create-view', props.dbId, props.dbName || '', props.schemaName);
};

const handleCreateSchema = () => {
  hideMenu();
  emit('create-schema', props.dbId, props.dbName || props.nodeLabel);
};

const handleRenameSchema = () => {
  hideMenu();
  emit('rename-schema', props.dbId, props.dbName || '', props.schemaName || props.nodeLabel);
};

const handleDropSchema = () => {
  hideMenu();
  emit('drop-schema', props.dbId, props.dbName || '', props.schemaName || props.nodeLabel);
};

const handleViewDefinition = () => {
  hideMenu();
  emit('open-view', props.dbId, props.nodeLabel, props.dbName, props.schemaName);
};

const handleDropView = async () => {
  hideMenu();
  try {
    await ElMessageBox.confirm(t('messages.confirmDropView', { name: props.nodeLabel }), t('messages.confirmDeleteTitle'), {
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      type: 'warning'
    });
    emit('drop-view', props.dbId, props.nodeLabel, props.dbName || '', props.schemaName);
  } catch {
    // 用户取消
  }
};

// 存储过程相关操作
const handleCreateProcedure = () => {
  hideMenu();
  emit('create-procedure', props.dbId, props.dbName || '', props.schemaName);
};

const handleViewProcedure = () => {
  hideMenu();
  emit('open-procedure', props.dbId, props.nodeLabel, props.dbName, props.schemaName);
};

const handleDropProcedure = async () => {
  hideMenu();
  try {
    await ElMessageBox.confirm(t('messages.confirmDropProcedure', { name: props.nodeLabel }), t('messages.confirmDeleteTitle'), {
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      type: 'warning'
    });
    emit('drop-procedure', props.dbId, props.nodeLabel, props.dbName || '', props.schemaName);
  } catch {
    // 用户取消
  }
};

// 监听点击外部隐藏菜单
const handleClickOutside = (event: Event) => {
  if (visible.value) {
    hideMenu();
  }
};

// 监听键盘事件
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    hideMenu();
  }
};

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});

// 暴露方法给父组件
defineExpose({
  showMenu,
  hideMenu
});
</script>

<style scoped>
.custom-context-menu {
  position: fixed;
  z-index: 9999;
  background: var(--el-bg-color);
  border: 1px solid var(--layout-border-color);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 150px;
}

.menu-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: background-color 0.2s;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.menu-item:hover {
  background-color: var(--el-fill-color-light);
}

.menu-item i {
  margin-right: 8px;
  width: 16px;
}

.menu-item.danger {
  color: var(--el-color-danger);
}
</style>
