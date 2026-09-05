<template>
  <div class="table-content flex flex-col h-100% min-h-0">
    <div class="data-tab flex flex-col flex-1 min-h-0 p-10px" v-show="activeTab === 0">
      <div class="toolbar mb-5px">
        <div class="toolbar-buttons mr-10px">
          <el-button size="small" plain type="primary" @click="saveChanges">{{ t('toolbar.saveChanges') }}</el-button>
          <el-button size="small" @click="resetChanges">{{ t('toolbar.refresh') }}</el-button>
        </div>
        <div v-if="isRedisDb" class="toolbar-redis-options flex items-center gap-10px mr-10px">
          <el-checkbox v-model="redisSavePrecheck" size="small">{{ t('toolbar.redisPrecheck') }}</el-checkbox>
          <el-checkbox v-model="redisAtomicBatch" size="small">{{ t('toolbar.redisAtomicBatch') }}</el-checkbox>
          <el-checkbox v-model="redisWatchKeys" size="small" :disabled="!redisAtomicBatch">
            {{ t('toolbar.redisConflictProtect') }}
          </el-checkbox>
        </div>

        <div class="filter-bar flex items-center ml-auto">
          <!-- <el-button 
            size="small" 
            type="success"
            @click="showExportDialog"
          >
            导出
          </el-button> -->
          <div class="filter-header ml-2">
            <el-button plain
              size="small" 
              type="primary" 
              @click="toggleFilter"
            >
              {{ t('toolbar.filter') }}
            </el-button>
          </div>
        </div>
      </div>

      <!-- 高级筛选组件 -->
      <AdvancedFilter 
        ref="advancedFilterRef"
        :fields="headers" 
        @apply-filters="handleAdvancedFilter" 
      />

      <div class="table-container flex-1" ref="tableContainerRef">
        <el-table
          v-fit-columns
          class="flex-1"
          v-loading="loading"
          :element-loading-text="t('loading')"
          :data="tableData"
          :empty-text="loading ? t('loading') : t('empty')"
          :row-class-name="getRowClassName"
          stripe
          border
          height="100%"
          style="width: 100%"
          @cell-dblclick="handleCellDblClick"
          @row-contextmenu="showContextMenu"
        >
          <el-table-column
            v-for="(header, index) in headers"
            :key="index"
            :prop="header"
            :label="header"
            :min-width="110"
            :show-overflow-tooltip="{ effect: 'dark', showArrow: true, trigger: 'click' }"
            width="auto"
          >
            <template #default="{ row, column }">
              <el-input
                v-if="isEditing(row) && !isDeleted(row)"
                v-model="row[column.property]"
                size="small"
                @change="markAsModified(row)"
                @blur="stopEditing(row)"
              />
              <div 
                v-else 
                class="cell-content truncate max-w-200px"
              >
                {{ formatCellValue(row[column.property]) }}
              </div>
            </template>
          </el-table-column>

          <el-table-column :label="t('columns.actions')" width="140">
            <template #default="{ row, $index }">
              <el-button
                v-if="isDeleted(row)"
                plain
                size="small"
                @click="restoreRow(row)"
              >
                {{ t('actions.restore') }}
              </el-button>
              <template v-else>
                <el-button plain
                  v-if="!isEditing(row)"
                  size="small"
                  type="primary"
                  @click="startEditing(row)"
                >
                  {{ t('actions.edit') }}
                </el-button>
                <el-button
                  v-else
                  plain
                  size="small"
                  type="success"
                  @click="stopEditing(row)"
                >
                  {{ t('actions.done') }}
                </el-button>
                <el-button plain
                  size="small"
                  type="danger"
                  @click="removeRow($index)"
                >
                  {{ t('actions.delete') }}
                </el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="bottom-actions flex justify-between items-center p-t-10px">
        <div>
          <el-button size="small" @click="addRow">{{ t('actions.addRow') }}</el-button>
        </div>
        <div class="pagination-section">
          <el-pagination
            size="small"
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next, jumper"
            :total="totalRecords"
            @size-change="handleSizeChange"
            @current-change="handleCurrentChange"
          />
        </div>
      </div>
    </div>

    <div v-if="showStructureTab" v-show="activeTab === 1" class="struct-tab flex-1 min-h-0 flex flex-col overflow-auto p-10px">
      <TableStruct
        :connection-id="connectionId"
        :database-name="databaseName"
        :schema-name="schemaName"
        :table-name="tableName"
      />
    </div>

    <div v-if="showStructureTab" class="segmented-section pt-6px pb-6px px-10px">
      <el-segmented
        v-model="activeTab"
        :options="[{ label: t('tabs.data'), value: 0 }, { label: t('tabs.structure'), value: 1 }]"
        size="small"
      />
    </div>
    
    <!-- 右键菜单组件 -->
    <TableDataRowContextMenu
      ref="contextMenuRef"
      :row-data="contextMenuRow"
      :row-index="contextMenuRowIndex"
      :headers="headers"
      :connection-id="connectionId"
      :table-name="tableName"
      :database-name="databaseName"
      @edit="handleEditRow"
      @copy-row="handleCopyRow"
      @copy-as-sql="handleCopyAsSql"
      @copy-as-csv="handleCopyAsCsv"
      @delete="handleDeleteRow"
    />
    
    <!-- 编辑数据行对话框 -->
    <EditDataRowDialog
      v-if="editDialogVisible"
      v-model="editDialogVisible"
      :row-data="editRowData"
      :fields="headersWithType"
      :table-name="tableName"
      :connection-id="connectionId"
      :database-name="databaseName"
      :db-type="currentDbType"
      @confirm="confirmEditRow"
    />
    
    <SingleTableExport
      v-if="exportDialogVisible"
      v-model="exportDialogVisible"
      :connection-id="connectionId"
      :database-name="databaseName"
      :schema-name="schemaName"
      :table-name="tableName"
      :advanced-filters="advancedFilters"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, onUnmounted, watch } from 'vue'
import { ElTable, ElMessage, ElMessageBox } from 'element-plus'
import { 
  getTableData, 
  updateTableRow, 
  addNewTableRow, 
  deleteTableRow,
  getTableHeaders,
  DbmApi,
  type ColumnSchema,
  extractDbmErrorMessage,
  getDbmPluginUiState,
  saveDbmPluginUiState
} from './service'
import TableStruct from './TableStruct.vue'
import AdvancedFilter from './AdvancedFilter.vue'
import TableDataRowContextMenu from './TableDataRowContextMenu.vue'
import EditDataRowDialog from './EditDataRowDialog.vue'
import SingleTableExport from './singleTableExport.vue'
import { useI18nScope } from '@/platform/i18n';

interface Props {
  connectionId: string;
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  showStructureTab?: boolean;
}

type RowStatus = 'original' | 'added' | 'modified' | 'deleted';
type DataRow = Record<string, any> & {
  __row_key__: string;
  __status__: RowStatus;
  __editing__: boolean;
};

const props = withDefaults(defineProps<Props>(), {
  showStructureTab: true
})
const { t } = useI18nScope('dbm.tableContent');
const showStructureTab = computed(() => props.showStructureTab)

// 表格相关引用
const tableData = ref<DataRow[]>([])
const headers = ref<string[]>([])
const headersWithType = ref<ColumnSchema[]>([])  // 添加字段类型信息
const activeTab = ref(0)
const loading = ref(false)
const tableRef = ref<InstanceType<typeof ElTable>>()
const advancedFilterRef = ref<any>(null)
const tableContainerRef = ref<HTMLElement | null>(null)

// 分页相关
const currentPage = ref(1)
const pageSize = ref(20)
const totalRecords = ref(0)

// 编辑状态跟踪
const recordStatusMap = ref<Record<string, RowStatus>>({})
const originalDataMap = ref<Record<string, Record<string, any>>>({});
const editingRows = ref<Set<string>>(new Set());
const nextLocalId = ref(0);

// 高级筛选条件
const advancedFilters = ref<Record<string, any>>({})

// PORT FIX: these two helpers were declared inside the save handler but also used
// by the Redis WATCH-conflict retry below, which threw a ReferenceError the moment a
// concurrent write was detected. Same bodies, hoisted to component scope.
const normalizeMongoValue = (value: any) => {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!raw) return value;
  if (/^-?\d+$/.test(raw)) {
    const asNumber = Number(raw);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return value;
    }
  }
  return value;
};
const normalizeMongoRow = (row: Record<string, any>) => {
  if ((currentDbType.value || '').toLowerCase() !== 'mongodb') return row;
  const nextRow: Record<string, any> = {};
  Object.keys(row).forEach((key) => {
    nextRow[key] = normalizeMongoValue(row[key]);
  });
  return nextRow;
};


// 右键菜单相关
const contextMenuRef = ref<InstanceType<typeof TableDataRowContextMenu>>()
const contextMenuRow = ref<any>(null)
const contextMenuRowIndex = ref<number>(0)

// 编辑对话框相关
const editDialogVisible = ref(false)
const editRowData = ref<any>(null)

const exportDialogVisible = ref(false)
const currentDbType = ref<string>('')
const isRedisDb = computed(() => (currentDbType.value || '').toLowerCase() === 'redis')
const redisSavePrecheck = ref(true)
const redisAtomicBatch = ref(true)
const redisWatchKeys = ref(true)
const DBM_REDIS_TABLE_OPTIONS_KEY = 'redisTableSaveOptions'

type RedisTableSaveOptions = {
  precheck: boolean;
  atomicBatch: boolean;
  watchKeys: boolean;
};

const getRedisOptionsStorageKey = () =>
  `${props.connectionId}::${props.databaseName || ''}::${props.schemaName || ''}::${props.tableName || ''}`;

const extractRedisConflictKeys = (message: string): string[] => {
  const match = message.match(/冲突键：([^)）\n\r]+)/);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => !!item);
};

const selectRowsByRedisKeys = (
  rows: Array<{ current?: Record<string, any>; original?: Record<string, any> }>,
  keys: string[]
) => {
  if (!keys.length) {
    return rows;
  }
  const keySet = new Set(keys);
  return rows.filter((row) => {
    const key = String(row.current?.key ?? row.current?.key_name ?? row.original?.key ?? row.original?.key_name ?? '').trim();
    return !!key && keySet.has(key);
  });
};

const persistRedisTableSaveOptions = async () => {
  if (!isRedisDb.value) {
    return;
  }
  const storageKey = getRedisOptionsStorageKey();
  if (!storageKey.trim()) {
    return;
  }
  try {
    const uiState = await getDbmPluginUiState<Record<string, any> | null>();
    const currentState: Record<string, any> = uiState && typeof uiState === 'object' ? { ...uiState } : {};
    const prevMap = currentState[DBM_REDIS_TABLE_OPTIONS_KEY];
    const optionsMap: Record<string, RedisTableSaveOptions> =
      prevMap && typeof prevMap === 'object' ? { ...(prevMap as Record<string, RedisTableSaveOptions>) } : {};
    optionsMap[storageKey] = {
      precheck: !!redisSavePrecheck.value,
      atomicBatch: !!redisAtomicBatch.value,
      watchKeys: !!redisWatchKeys.value
    };
    currentState[DBM_REDIS_TABLE_OPTIONS_KEY] = optionsMap;
    await saveDbmPluginUiState(currentState);
  } catch (error) {
    console.warn('保存 Redis 表格保存策略失败:', error);
  }
};

const restoreRedisTableSaveOptions = async () => {
  if (!isRedisDb.value) {
    return;
  }
  const storageKey = getRedisOptionsStorageKey();
  if (!storageKey.trim()) {
    return;
  }
  try {
    const uiState = await getDbmPluginUiState<Record<string, any> | null>();
    const optionsMap =
      uiState && typeof uiState === 'object'
        ? (uiState as Record<string, any>)[DBM_REDIS_TABLE_OPTIONS_KEY]
        : null;
    if (!optionsMap || typeof optionsMap !== 'object') {
      return;
    }
    const option = (optionsMap as Record<string, Partial<RedisTableSaveOptions>>)[storageKey];
    if (!option || typeof option !== 'object') {
      return;
    }
    redisSavePrecheck.value = option.precheck !== false;
    redisAtomicBatch.value = option.atomicBatch !== false;
    redisWatchKeys.value = option.watchKeys !== false;
  } catch (error) {
    console.warn('读取 Redis 表格保存策略失败:', error);
  }
};

// 添加右键菜单事件处理
const showContextMenu = (row: DataRow, column: any, event: MouseEvent) => {
  event.preventDefault();
  contextMenuRow.value = row;
  // 获取行索引
  const rowIndex = tableData.value.findIndex(r => r.__row_key__ === row.__row_key__);
  contextMenuRowIndex.value = rowIndex;
  nextTick(() => {
    if (contextMenuRef.value) {
      contextMenuRef.value.showMenu(row, event);
    }
  });
};

// 显示导出对话框
const showExportDialog = () => {
  exportDialogVisible.value = true;
}

// 处理编辑行
const handleEditRow = (row: DataRow) => {
  if (row.__status__ !== 'deleted') {
    editRowData.value = { ...row };
    editDialogVisible.value = true;
  }
};

// 确认编辑行
const confirmEditRow = (updatedRow: any) => {
  // 更新行数据
  const rowIndex = tableData.value.findIndex(r => r.__row_key__ === updatedRow.__row_key__);
  if (rowIndex !== -1) {
    // 只更新字段值，保留特殊属性
    const originalRow = tableData.value[rowIndex];
    const rowKey = originalRow.__row_key__;
    const oldStatus = originalRow.__status__;
    headers.value.forEach(header => {
      originalRow[header] = updatedRow[header];
    });
    
    // 设置为修改状态
    if (oldStatus !== 'added') {
      originalRow.__status__ = 'modified';
      recordStatusMap.value[rowKey] = 'modified';
    }
    
    // ElMessage.success('行数据已更新');
  }
};

// 处理复制行
const handleCopyRow = (row: DataRow) => {
  const rowKey = `local_${nextLocalId.value++}`;
  const newRow: DataRow = {
    __row_key__: rowKey,
    __status__: 'added',
    __editing__: false,
  };

  // 复制原行数据，但不包括特殊属性
  headers.value.forEach((header) => {
    newRow[header] = row[header];
  });

  tableData.value.push(newRow);
  recordStatusMap.value[rowKey] = 'added';
  originalDataMap.value[rowKey] = cleanRowForSubmit(newRow);
  
  ElMessage.success(t('messages.rowCopied'));
};

// 处理复制为SQL
const handleCopyAsSql = (row: DataRow) => {
  // 生成INSERT SQL语句
  const fields = headers.value.join(', ');
  const values = headers.value.map(header => {
    const value = row[header];
    if (value === null || value === undefined) {
      return 'NULL';
    } else if (typeof value === 'string') {
      return `'${value.replace(/'/g, "''")}'`;
    } else {
      return String(value);
    }
  }).join(', ');
  
  const sql = `INSERT INTO ${props.tableName} (${fields}) VALUES (${values});`;
  
  // 复制到剪贴板
  navigator.clipboard.writeText(sql).then(() => {
    ElMessage.success(t('messages.sqlCopied'));
  }).catch(err => {
    ElMessage.error(t('messages.copySqlFailed'));
    console.error('复制失败:', err);
  });
};

// 处理复制为CSV
const handleCopyAsCsv = (row: DataRow) => {
  // 将行数据转换为CSV格式
  const csvRow = headers.value.map(header => {
    let value = row[header];
    if (value === null || value === undefined) {
      value = '';
    }
    // 如果值包含逗号、换行符或引号，则需要用引号包围，并转义内部的引号
    value = String(value);
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      value = `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }).join(',');
  
  // 复制到剪贴板
  navigator.clipboard.writeText(csvRow).then(() => {
    ElMessage.success(t('messages.csvCopied'));
  }).catch(err => {
    ElMessage.error(t('messages.copyCsvFailed'));
    console.error('复制失败:', err);
  });
};

// 处理删除行
const handleDeleteRow = async (row: DataRow, index: number) => {
  try {
    await ElMessageBox.confirm(t('messages.confirmDeleteRow'), t('messages.warningTitle'), {
      confirmButtonText: t('actions.confirm'),
      cancelButtonText: t('actions.cancel'),
      type: 'warning',
    });

    const rowKey = row.__row_key__;

    if (recordStatusMap.value[rowKey] === 'added') {
      tableData.value.splice(index, 1);
      delete recordStatusMap.value[rowKey];
      delete originalDataMap.value[rowKey];
      editingRows.value.delete(rowKey);
    } else {
      recordStatusMap.value[rowKey] = 'deleted';
      editingRows.value.delete(rowKey);
    }
    
    // ElMessage.success('行已删除');
  } catch {
    // 用户取消
  }
};

// 添加双击单元格处理方法
const handleCellDblClick = (row: DataRow) => {
  startEditing(row);
}

// 监听高级筛选组件的变化
const toggleFilter = async () => {
  if (advancedFilterRef.value) {
    advancedFilterRef.value.toggleFilterConditions()
  }
}

const cleanRowForSubmit = (row: DataRow) => {
  const clean = { ...row } as Record<string, any>;
  delete clean.__row_key__;
  delete clean.__status__;
  delete clean.__editing__;
  return clean;
};

const isEditing = (row: DataRow) => row.__editing__;
const isDeleted = (row: DataRow) => (row.__status__ || 'original') === 'deleted';
const formatCellValue = (value: any) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const getRowClassName = ({ row }: { row: DataRow }) => {
  const status = row.__status__ || 'original';
  if (status === 'added') return 'status-added';
  if (status === 'modified') return 'status-modified';
  if (status === 'deleted') return 'status-deleted';
  return '';
};

const startEditing = (row: DataRow) => {
  if (row.__status__ === 'deleted') return;
  if ((currentDbType.value || '').toLowerCase() === 'mongodb') {
    handleEditRow(row);
    return;
  }
  row.__editing__ = true;
  editingRows.value.add(row.__row_key__);
};

const stopEditing = (row: DataRow) => {
  row.__editing__ = false;
  editingRows.value.delete(row.__row_key__);
  markAsModified(row);
};

const markAsModified = (row: DataRow) => {
  const rowKey = row.__row_key__;
  const currentStatus = row.__status__ || 'original';
  if (currentStatus === 'added' || currentStatus === 'deleted') return;

  const original = originalDataMap.value[rowKey];
  if (!original) {
    row.__status__ = 'modified';
    return;
  }

  const current = cleanRowForSubmit(row);
  row.__status__ =
    JSON.stringify(current) === JSON.stringify(original) ? 'original' : 'modified';
};

const addRow = () => {
  const rowKey = `local_${nextLocalId.value++}`;
  const newRow: DataRow = {
    __row_key__: rowKey,
    __status__: 'added',
    __editing__: true,
  };

  headers.value.forEach((header) => {
    newRow[header] = '';
  });

  tableData.value.push(newRow);
  recordStatusMap.value[rowKey] = 'added';
  editingRows.value.add(rowKey);
};

const removeRow = async (index: number) => {
  const row = tableData.value[index];
  handleDeleteRow(row, index);
};

const restoreRow = (row: DataRow) => {
  const rowKey = row.__row_key__;
  recordStatusMap.value[rowKey] = 'original';
};

const saveChanges = async () => {
  const targetDatabase = props.databaseName;
  try {
    const isMongo = (currentDbType.value || '').toLowerCase() === 'mongodb';
    const addedRows: Record<string, any>[] = [];
    const modifiedRows: Array<{ rowKey: string; current: Record<string, any>; original: Record<string, any> }> = [];
    const deletedRows: Array<{ rowKey: string; original: Record<string, any> }> = [];

    tableData.value.forEach((row) => {
      const rowKey = row.__row_key__;
      const status = row.__status__ || 'original';
      const cleanRow = normalizeMongoRow(cleanRowForSubmit(row));
      
      if (status === 'added') {
        addedRows.push(cleanRow);
      } else if (status === 'modified') {
        modifiedRows.push({
          rowKey,
          current: cleanRow,
          original: normalizeMongoRow(originalDataMap.value[rowKey] || {})
        });
      } else if (status === 'deleted') {
        deletedRows.push({
          rowKey,
          original: normalizeMongoRow(originalDataMap.value[rowKey] || {})
        });
      }
    });
    
    if (addedRows.length === 0 && modifiedRows.length === 0 && deletedRows.length === 0) {
      ElMessage.info(t('messages.noChanges'));
      return;
    }

    const isKafka = (currentDbType.value || '').toLowerCase() === 'kafka';
    if (isKafka) {
      for (const item of modifiedRows) {
        const key = String(item.current?.key ?? '').trim();
        if (!key) {
          ElMessage.error(t('messages.kafkaUpdateRequiresKey'));
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(item.current || {}, 'value')) {
          ElMessage.error(t('messages.kafkaUpdateRequiresValue'));
          return;
        }
      }
      for (const item of deletedRows) {
        const key = String(item.original?.key ?? '').trim();
        if (!key) {
          ElMessage.error(t('messages.kafkaDeleteRequiresKey'));
          return;
        }
      }
      if (modifiedRows.length > 0 || deletedRows.length > 0) {
        const confirmed = await ElMessageBox.confirm(
          t('messages.kafkaSaveConfirmMessage'),
          t('messages.kafkaSaveConfirmTitle'),
          {
            confirmButtonText: t('actions.confirm'),
            cancelButtonText: t('actions.cancel'),
            type: 'warning',
          }
        ).then(() => true).catch(() => false);
        if (!confirmed) {
          return;
        }
      }
    }

    if (!targetDatabase) {
      throw new Error(t('messages.databaseRequiredForSave'));
    }

    const isRedis = isRedisDb.value;
    if (isRedis) {
      if (redisSavePrecheck.value) {
        await DbmApi.saveTableData(props.connectionId, targetDatabase, props.tableName, props.schemaName, {
          added: addedRows,
          modified: modifiedRows.map(item => ({
            current: item.current,
            original: item.original
          })),
          deleted: deletedRows.map(item => item.original),
          validate_only: true,
          redis_atomic_batch: redisAtomicBatch.value,
          redis_watch_keys: redisAtomicBatch.value && redisWatchKeys.value
        });
      }
    }

    await DbmApi.saveTableData(props.connectionId, targetDatabase, props.tableName, props.schemaName, {
      added: addedRows,
      modified: modifiedRows.map(item => ({
        current: item.current,
        original: item.original
      })),
      deleted: deletedRows.map(item => item.original),
      redis_atomic_batch: isRedis && redisAtomicBatch.value,
      redis_watch_keys: isRedis && redisAtomicBatch.value && redisWatchKeys.value
    });
    
    ElMessage.success(t('messages.saveSuccess'));
    
    // 更新原始数据和状态
    await loadData();
  } catch (error) {
    console.error('保存数据失败:', error);
    const rawErrorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'string' ? error : JSON.stringify(error || {}));
    if (isRedisDb.value && rawErrorMessage.includes('DBM_REDIS_WATCH_CONFLICT')) {
      const retry = await ElMessageBox.confirm(
        t('messages.redisWatchConflictRetryMessage'),
        t('messages.redisWatchConflictRetryTitle'),
        {
          confirmButtonText: t('actions.confirm'),
          cancelButtonText: t('actions.cancel'),
          type: 'warning',
        }
      ).then(() => true).catch(() => false);
      if (retry) {
        const previousWatchSetting = redisWatchKeys.value;
        try {
          const conflictKeys = extractRedisConflictKeys(rawErrorMessage);
          if (!conflictKeys.length) {
            redisWatchKeys.value = false;
            await saveChanges();
            return;
          }

          const addedRows = Object.entries(recordStatusMap.value)
            .filter(([, status]) => status === 'added')
            .map(([rowKey]) => cleanRowForSubmit(tableData.value.find((item) => item.__row_key__ === rowKey) || {} as DataRow));
          const modifiedRows = Object.entries(recordStatusMap.value)
            .filter(([, status]) => status === 'modified')
            .map(([rowKey]) => ({
              current: cleanRowForSubmit(tableData.value.find((item) => item.__row_key__ === rowKey) || {} as DataRow),
              original: normalizeMongoRow(originalDataMap.value[rowKey] || {})
            }));
          const deletedRows = Object.entries(recordStatusMap.value)
            .filter(([, status]) => status === 'deleted')
            .map(([rowKey]) => normalizeMongoRow(originalDataMap.value[rowKey] || {}));

          const filteredAdded = selectRowsByRedisKeys(addedRows.map((row) => ({ current: row })), conflictKeys)
            .map((item) => item.current || {});
          const filteredModified = selectRowsByRedisKeys(modifiedRows, conflictKeys)
            .map((item) => ({ current: item.current || {}, original: item.original || {} }));
          const filteredDeleted = selectRowsByRedisKeys(
            deletedRows.map((row) => ({ original: row })),
            conflictKeys
          ).map((item) => item.original || {});

          if (!filteredAdded.length && !filteredModified.length && !filteredDeleted.length) {
            redisWatchKeys.value = false;
            await saveChanges();
            return;
          }

          await DbmApi.saveTableData(props.connectionId, targetDatabase, props.tableName, props.schemaName, {
            added: filteredAdded,
            modified: filteredModified,
            deleted: filteredDeleted,
            redis_atomic_batch: true,
            redis_watch_keys: false
          });
          ElMessage.success(t('messages.saveSuccess'));
          await loadData();
        } finally {
          redisWatchKeys.value = previousWatchSetting;
        }
      }
      return;
    }
    const errorMessage = extractDbmErrorMessage(error, t('messages.unknownError'));
    ElMessage.error(t('messages.saveFailed', { error: errorMessage }));
  }
};

const loadConnectionMeta = async () => {
  try {
    const connection = await DbmApi.getConnection(props.connectionId);
    currentDbType.value = connection?.db_type || '';
  } catch {
    currentDbType.value = '';
  }
};

const resetChanges = async () => {
  try {
    await ElMessageBox.confirm(t('messages.confirmResetChanges'), t('messages.warningTitle'), {
      confirmButtonText: t('actions.confirm'),
      cancelButtonText: t('actions.cancel'),
      type: 'warning',
    });
    await loadData();
  } catch {
    // 用户取消
  }
};

const loadData = async () => {
  loading.value = true;
  try {
    const result = await DbmApi.getTableData(
      props.connectionId,
      props.databaseName,
      props.tableName,
      props.schemaName,
      pageSize.value,
      (currentPage.value - 1) * pageSize.value,
      undefined,  // orderBy
      advancedFilters.value  // 传递高级筛选条件
    );

    headers.value = result.columns;
    totalRecords.value = result.row_count;

    // 获取表结构以获得字段类型信息
    try {
      const tableStruct = await DbmApi.getTableStruct(
        props.connectionId,
        props.databaseName,
        props.tableName,
        props.schemaName
      );
      headersWithType.value = tableStruct.columns;
    } catch (schemaError) {
      console.warn('获取表结构失败，使用默认类型:', schemaError);
      // 如果获取不到结构，使用默认类型
      headersWithType.value = result.columns.map(col => ({
        name: col,
        data_type: 'VARCHAR',
        is_nullable: true,
        default_value: null,
        is_primary_key: false,
        character_maximum_length: null
      }));
    }

    const newStatusMap: Record<string, RowStatus> = {};
    const newOriginalMap: Record<string, Record<string, any>> = {};

    tableData.value = result.rows.map((row) => {
      const rowKey = `local_${nextLocalId.value++}`;
      const obj: DataRow = {
        __row_key__: rowKey,
        __status__: 'original',
        __editing__: false,
      };
      result.columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      newStatusMap[rowKey] = 'original';
      newOriginalMap[rowKey] = cleanRowForSubmit(obj);
      return obj;
    });

    recordStatusMap.value = newStatusMap;
    originalDataMap.value = newOriginalMap;
    editingRows.value.clear();
  } catch (error) {
    console.error('加载表数据失败:', error);
    // 解析错误信息
    let errorMessage = t('messages.unknownError');
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = (error as any).message || (error as any).msg || JSON.stringify(error);
    }
    
    if (
      error instanceof Error &&
      (errorMessage.includes("doesn't exist") || errorMessage.includes('no such table') || errorMessage.includes('42S02'))
    ) {
      const dbNameInfo = props.databaseName ? t('messages.inDatabase', { databaseName: props.databaseName }) : '';
      ElMessage.error(t('messages.tableNotExists', { tableName: props.tableName, dbNameInfo }));
      tableData.value = [];
      headers.value = [];
      totalRecords.value = 0;
    } else {
      ElMessage.error(t('messages.loadFailed', { error: errorMessage }));
    }
  } finally {
    loading.value = false;
  }
};

const resetFilter = () => {
  advancedFilters.value = {};
  loadData();
};

const handleAdvancedFilter = (conditions: any[]) => {
  // 将筛选条件转换为API所需的格式
  const filters: Record<string, any> = {};
  const isMongo = (currentDbType.value || '').toLowerCase() === 'mongodb';
  conditions.forEach(condition => {
    // 为了支持多种操作符，我们使用特殊格式存储
    let value: any = condition.value;
    if (isMongo && !['LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL'].includes(condition.operator)) {
      const raw = String(condition.value ?? '').trim();
      if (raw === '') {
        value = raw;
      } else if (raw === 'true' || raw === 'false') {
        value = raw === 'true';
      } else if (!Number.isNaN(Number(raw))) {
        value = Number(raw);
      } else {
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
      }
    }
    filters[`${condition.field}_${condition.operator}`] = value;
  });
  
  advancedFilters.value = filters;
  loadData();
};

const handleSizeChange = (size: number) => {
  pageSize.value = size;
  currentPage.value = 1;
  loadData();
};

const handleCurrentChange = (page: number) => {
  currentPage.value = page;
  loadData();
};

// 处理导出事件
const handleExportEvent = () => {
  showExportDialog();
};

// 定义组件事件
const emit = defineEmits<{
  (e: 'export-table', connectionId: string, tableName: string, databaseName?: string): void;
}>();

onMounted(() => {
  loadConnectionMeta();
  loadData();
});

watch(
  () => [props.connectionId, props.databaseName, props.schemaName, props.tableName, currentDbType.value],
  async () => {
    await restoreRedisTableSaveOptions();
  },
  { immediate: true }
);

watch(
  () => [redisSavePrecheck.value, redisAtomicBatch.value, redisWatchKeys.value],
  () => {
    persistRedisTableSaveOptions();
  }
);

watch(
  () => redisAtomicBatch.value,
  (enabled) => {
    if (!enabled) {
      redisWatchKeys.value = false;
    }
  }
);

// 监听属性变化
watch(() => props.tableName, () => {
  currentPage.value = 1;
  loadData();
});

watch(() => props.connectionId, () => {
  loadConnectionMeta();
});

// 暴露方法给父组件
defineExpose({
  handleExportEvent
});
</script>

<style scoped lang="scss">
.table-content {
  min-height: 0;

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;

    .toolbar-buttons {
      display: flex;
      gap: 10px;
    }

    .toolbar-redis-options {
      flex-wrap: wrap;
    }

    .filter-bar {
      gap: 10px;
      margin-left: auto;

      .filter-input {
        width: 300px;
      }
    }
  }

  .table-container {
    flex: 1;
    min-height: 0;
    overflow: auto;

    ::v-deep(.el-table) {
      --el-table-row-hover-bg-color: var(--theme-primary-soft-hover);

      .status-added td {
        background-color: rgba(144, 238, 144, 0.3) !important;
      }

      .status-modified td {
        background-color: rgba(255, 255, 0, 0.3) !important;
      }

      .status-deleted td {
        background-color: rgba(255, 182, 193, 0.3) !important;
        text-decoration: line-through;
      }
    }
  }

  .pagination-section {
    display: flex;
    justify-content: flex-start;
  }

  .data-tab,
  .struct-tab,
  .bottom-actions {
    min-height: 0;
  }

  .bottom-actions {
    flex-shrink: 0;
  }

  .segmented-section {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    z-index: 2;
    border-top: 1px solid var(--layout-border-color);
    background: var(--el-bg-color, #fff);
  }
}
</style>
