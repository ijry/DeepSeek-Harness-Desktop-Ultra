<template>
  <el-dialog
    v-if="modelValue"
    :model-value="modelValue"
    class="dictionary-dialog"
    :title="t('title')"
    width="94vw"
    top="3vh"
    destroy-on-close
    @close="emit('update:modelValue', false)"
  >
    <div v-if="!connection" class="empty-holder">
      <el-empty :description="t('empty.noConnection')" />
    </div>

    <template v-else>
      <div class="dictionary-toolbar">
        <div class="dictionary-toolbar-left">
          <el-tag size="small" type="info">{{ connection.name }}</el-tag>
          <el-tag size="small">{{ databaseLabel }}</el-tag>
          <el-tag v-if="schemaLabel" size="small" type="success">{{ schemaLabel }}</el-tag>
          <span class="summary-text">
            {{ t('summary', stats) }}
          </span>
        </div>

        <div class="dictionary-toolbar-right">
          <el-input
            v-model="keyword"
            size="small"
            clearable
            class="search-input"
            :placeholder="t('searchPlaceholder')"
          />
          <el-button size="small" :loading="loadingList" @click="refreshDictionary">{{ t('refresh') }}</el-button>
          <el-button
            size="small"
            type="primary"
            :loading="exporting"
            :disabled="loadingList || !tableNames.length"
            @click="handleExportDocx"
          >
            {{ t('exportDocx') }}
          </el-button>
        </div>
      </div>

      <div v-if="exportProgressVisible" class="export-progress-card">
        <div class="export-progress-header">
          <span class="export-progress-text">{{ exportProgressMessage || t('exporting') }}</span>
          <span class="export-progress-value">{{ exportProgress.toFixed(0) }}%</span>
        </div>
        <el-progress :percentage="exportProgress" :stroke-width="6" :show-text="false" />
      </div>

      <div class="dictionary-layout" v-loading="loadingList">
        <div class="table-sidebar">
          <div class="sidebar-header">{{ t('tableList') }}</div>
          <div class="sidebar-scroll" @wheel.stop>
            <div v-if="filteredTableItems.length" class="table-list">
              <button
                v-for="item in filteredTableItems"
                :key="item.tableName"
                type="button"
                class="table-list-item"
                :class="{ active: selectedTableName === item.tableName }"
                @click="selectTable(item.tableName)"
              >
                <div class="table-list-title">{{ item.tableName }}</div>
                <div class="table-list-meta">
                  <span>{{ t('tableMeta.columns', { count: item.detail ? item.detail.columns.length : '-' }) }}</span>
                  <span>{{ t('tableMeta.foreignKeys', { count: item.detail ? item.detail.foreign_keys.length : '-' }) }}</span>
                </div>
                <div v-if="item.detail?.comment" class="table-list-comment">
                  {{ item.detail.comment }}
                </div>
                <div
                  v-if="selectedTableName === item.tableName && detailLoading && !item.detail"
                  class="table-list-loading"
                >
                  <el-tag size="small" type="info">{{ t('loading') }}</el-tag>
                </div>
              </button>
            </div>
            <el-empty v-else :description="keyword ? t('empty.noMatchedTables') : t('empty.noTables')" :image-size="72" />
          </div>
        </div>

        <div class="table-detail" v-loading="detailLoading && !!selectedTableName && !currentTable">
          <div class="table-detail-scroll" @wheel.stop>
            <template v-if="currentTable">
              <div class="detail-header">
                <div>
                  <div class="detail-title">{{ currentTable.table_name }}</div>
                  <div class="detail-subtitle">
                    {{ currentTable.comment || t('noTableComment') }}
                  </div>
                </div>
                <div class="detail-tags">
                  <el-tag size="small" type="primary">{{ t('tags.primaryKeys', { count: currentTable.primary_keys.length }) }}</el-tag>
                  <el-tag size="small" type="success">{{ t('tags.foreignKeys', { count: currentTable.foreign_keys.length }) }}</el-tag>
                  <el-tag size="small" type="warning">{{ t('tags.indexes', { count: currentTable.indexes.length }) }}</el-tag>
                </div>
              </div>

              <el-descriptions :column="3" border size="small" class="meta-card">
                <el-descriptions-item :label="t('meta.database')">{{ databaseLabel }}</el-descriptions-item>
                <el-descriptions-item :label="t('meta.schema')">{{ schemaLabel || t('defaultSchema') }}</el-descriptions-item>
                <el-descriptions-item :label="t('meta.columnCount')">{{ currentTable.columns.length }}</el-descriptions-item>
              </el-descriptions>

              <section class="detail-section">
                <div class="section-title">{{ t('sections.columns') }}</div>
                <el-table :data="columnRows" border size="small" height="320">
                  <el-table-column type="index" label="#" width="52" />
                  <el-table-column prop="name" :label="t('columns.name')" min-width="160" show-overflow-tooltip />
                  <el-table-column prop="displayType" :label="t('columns.type')" min-width="160" show-overflow-tooltip />
                  <el-table-column prop="nullableLabel" :label="t('columns.nullable')" width="92" />
                  <el-table-column prop="defaultLabel" :label="t('columns.default')" min-width="140" show-overflow-tooltip />
                  <el-table-column prop="keyLabel" :label="t('columns.key')" width="90" />
                  <el-table-column prop="commentLabel" :label="t('columns.comment')" min-width="180" show-overflow-tooltip />
                </el-table>
              </section>

              <section class="detail-section">
                <div class="section-title">{{ t('sections.foreignKeys') }}</div>
                <el-table
                  v-if="currentTable.foreign_keys.length"
                  :data="currentTable.foreign_keys"
                  border
                  size="small"
                  max-height="220"
                >
                  <el-table-column prop="constraint_name" :label="t('foreignKeys.constraint')" min-width="160" show-overflow-tooltip />
                  <el-table-column prop="column_name" :label="t('foreignKeys.column')" min-width="120" show-overflow-tooltip />
                  <el-table-column prop="referenced_table" :label="t('foreignKeys.refTable')" min-width="140" show-overflow-tooltip />
                  <el-table-column prop="referenced_column" :label="t('foreignKeys.refColumn')" min-width="140" show-overflow-tooltip />
                </el-table>
                <el-empty v-else :description="t('empty.noForeignKeys')" :image-size="60" />
              </section>

              <section class="detail-section">
                <div class="section-title">{{ t('sections.indexes') }}</div>
                <el-table
                  v-if="currentTable.indexes.length"
                  :data="indexRows"
                  border
                  size="small"
                  max-height="220"
                >
                  <el-table-column prop="name" :label="t('indexes.name')" min-width="180" show-overflow-tooltip />
                  <el-table-column prop="columnsLabel" :label="t('indexes.columns')" min-width="240" show-overflow-tooltip />
                  <el-table-column prop="uniqueLabel" :label="t('indexes.unique')" width="90" />
                </el-table>
                <el-empty v-else :description="t('empty.noIndexes')" :image-size="60" />
              </section>
            </template>

            <div v-else class="detail-empty">
              <el-empty :description="keyword ? t('empty.noMatchedTables') : t('empty.selectTable')" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { DbmApi, extractDbmErrorMessage, type DbConnection, type TableStruct } from './service';
import { useDbSchemaContext } from './useDbSchemaContext';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  modelValue: boolean;
  connection: DbConnection | null;
  databaseName?: string;
  schemaName?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
const { t } = useI18nScope('dbm.dictionary');

interface TableListItem {
  tableName: string;
  detail: TableStruct | null;
}

interface DictionaryExportProgressEvent {
  token: string;
  progress: number;
  stage: string;
  message: string;
  table_name: string | null;
  processed_tables: number;
  total_tables: number;
}

const loadingList = ref(false);
const detailLoading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const tableNames = ref<string[]>([]);
const tableStructMap = ref<Record<string, TableStruct>>({});
const selectedTableName = ref('');
const exportProgressVisible = ref(false);
const exportProgress = ref(0);
const exportProgressMessage = ref('');

let detailRequestSerial = 0;
let exportProgressUnlisten: UnlistenFn | null = null;
let activeExportToken = '';

const databaseLabel = computed(() => props.databaseName || props.connection?.database || t('defaultDatabase'));
const schemaLabel = computed(() => props.schemaName || '');
const queryDatabaseName = computed(() => props.databaseName || props.connection?.database || undefined);
const {
  tableStructs: sharedTableStructs,
  schemaReady,
  schemaError,
  ensureSchemaLoaded,
} = useDbSchemaContext({
  connectionId: computed(() => props.connection?.id || ''),
  databaseName: computed(() => queryDatabaseName.value || ''),
  schemaName: computed(() => props.schemaName || ''),
  errorFallback: t('cacheLoadFailed')
});

const normalizedKeyword = computed(() => keyword.value.trim().toLowerCase());
const sharedTableStructMap = computed<Record<string, TableStruct>>(() =>
  Object.fromEntries(sharedTableStructs.value.map((table) => [table.table_name, table]))
);

const tableItems = computed<TableListItem[]>(() =>
  tableNames.value.map((tableName) => ({
    tableName,
    detail: tableStructMap.value[tableName] || null
  }))
);

const filteredTableItems = computed(() => {
  const keywordValue = normalizedKeyword.value;
  if (!keywordValue) {
    return tableItems.value;
  }

  return tableItems.value.filter((item) => {
    if (item.tableName.toLowerCase().includes(keywordValue)) {
      return true;
    }

    if ((item.detail?.comment || '').toLowerCase().includes(keywordValue)) {
      return true;
    }

    return (item.detail?.columns || []).some((column) => {
      const comment = column.column_comment || '';
      return column.name.toLowerCase().includes(keywordValue)
        || comment.toLowerCase().includes(keywordValue);
    });
  });
});

const currentTable = computed(() => tableStructMap.value[selectedTableName.value] || null);

const columnRows = computed(() =>
  (currentTable.value?.columns || []).map((column) => ({
    ...column,
    displayType: formatColumnType(column),
    nullableLabel: column.is_nullable ? t('boolean.yes') : t('boolean.no'),
    defaultLabel: normalizeDisplayValue(column.default_value),
    keyLabel: column.is_primary_key ? 'PK' : '-',
    commentLabel: normalizeDisplayValue(column.column_comment)
  }))
);

const indexRows = computed(() =>
  (currentTable.value?.indexes || []).map((index) => ({
    ...index,
    columnsLabel: index.columns.join(', '),
    uniqueLabel: index.is_unique ? t('boolean.yes') : t('boolean.no')
  }))
);

const stats = computed(() => ({
  tableCount: tableNames.value.length,
  loadedTableCount: Object.keys(tableStructMap.value).length,
  loadedColumnCount: Object.values(tableStructMap.value).reduce((total, table) => total + table.columns.length, 0)
}));

const normalizeDisplayValue = (value?: string | null) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || '-';
};

const formatColumnType = (column: TableStruct['columns'][number]) => {
  const base = column.data_type || '';
  const maxLength = column.character_maximum_length;
  if (!base) {
    return '-';
  }
  if (base.includes('(') || maxLength == null) {
    return base;
  }
  return `${base}(${maxLength})`;
};

const ensureSelection = () => {
  if (!filteredTableItems.value.length) {
    selectedTableName.value = '';
    return;
  }

  if (!filteredTableItems.value.some((item) => item.tableName === selectedTableName.value)) {
    selectedTableName.value = filteredTableItems.value[0].tableName;
  }
};

const resetDetailState = () => {
  detailRequestSerial += 1;
  detailLoading.value = false;
  tableNames.value = [];
  tableStructMap.value = {};
  selectedTableName.value = '';
};

const applyDictionaryData = (tables: TableStruct[]) => {
  const sortedTables = [...tables].sort((left, right) => left.table_name.localeCompare(right.table_name));
  tableNames.value = sortedTables.map((table) => table.table_name);
  tableStructMap.value = Object.fromEntries(sortedTables.map((table) => [table.table_name, table]));
  ensureSelection();
};

const loadTableDetail = async (tableName: string, force = false) => {
  if (!props.connection || !tableName) {
    return;
  }

  const sharedDetail = sharedTableStructMap.value[tableName];
  if (sharedDetail) {
    tableStructMap.value = {
      ...tableStructMap.value,
      [tableName]: sharedDetail
    };
    return;
  }

  if (!force && tableStructMap.value[tableName]) {
    return;
  }

  const requestSerial = ++detailRequestSerial;
  detailLoading.value = true;

  try {
    const detail = await DbmApi.getTableStruct(
      props.connection.id,
      queryDatabaseName.value,
      tableName,
      props.schemaName
    );

    if (requestSerial !== detailRequestSerial) {
      return;
    }

    tableStructMap.value = {
      ...tableStructMap.value,
      [tableName]: detail
    };
  } catch (error) {
    if (requestSerial === detailRequestSerial) {
      ElMessage.error(extractDbmErrorMessage(error, t('loadTableFailed', { tableName })));
    }
  } finally {
    if (requestSerial === detailRequestSerial) {
      detailLoading.value = false;
    }
  }
};

const loadDictionary = async () => {
  if (!props.connection) {
    resetDetailState();
    return;
  }

  resetDetailState();
  loadingList.value = true;
  try {
    if (schemaReady.value && sharedTableStructs.value.length) {
      applyDictionaryData(sharedTableStructs.value);
      return;
    }

    const tableList = await DbmApi.getTables(
      props.connection.id,
      queryDatabaseName.value,
      props.schemaName
    );
    tableNames.value = [...tableList].sort((left, right) => left.localeCompare(right));
    ensureSelection();
    if (selectedTableName.value) {
      await loadTableDetail(selectedTableName.value);
    }
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('loadFailed')));
  } finally {
    loadingList.value = false;
  }
};

const refreshDictionary = async () => {
  if (!props.connection) {
    resetDetailState();
    return;
  }

  resetDetailState();
  loadingList.value = true;
  try {
    const tables = await ensureSchemaLoaded(true);
    if (schemaError.value) {
      ElMessage.error(schemaError.value);
    }

    if (tables.length) {
      applyDictionaryData(tables);
      return;
    }

    const tableList = await DbmApi.getTables(
      props.connection.id,
      queryDatabaseName.value,
      props.schemaName
    );
    tableNames.value = [...tableList].sort((left, right) => left.localeCompare(right));
    ensureSelection();
    if (selectedTableName.value) {
      await loadTableDetail(selectedTableName.value, true);
    }
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('refreshFailed')));
  } finally {
    loadingList.value = false;
  }
};

const safeFileSegment = (value: string) =>
  value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, '_');

const clearExportProgressListener = () => {
  if (exportProgressUnlisten) {
    exportProgressUnlisten();
    exportProgressUnlisten = null;
  }
};

const bindExportProgressListener = async (token: string) => {
  clearExportProgressListener();
  activeExportToken = token;
  exportProgress.value = 0;
  exportProgressMessage.value = t('preparingExport');
  exportProgressVisible.value = true;

  exportProgressUnlisten = await listen<DictionaryExportProgressEvent>('dbm-dictionary-export-progress', (event) => {
    const payload = event.payload;
    if (!payload || payload.token !== activeExportToken) {
      return;
    }

    exportProgress.value = Math.min(100, Math.max(0, Number(payload.progress) || 0));
    exportProgressMessage.value = payload.message || t('exporting');
  });
};

const handleExportDocx = async () => {
  if (!props.connection || !tableNames.value.length) {
    return;
  }

  const dateLabel = new Date().toISOString().slice(0, 10);
  const schemaSuffix = schemaLabel.value ? `-${safeFileSegment(schemaLabel.value)}` : '';
  const defaultPath = `${safeFileSegment(databaseLabel.value)}${schemaSuffix}-${safeFileSegment(t('filename'))}-${dateLabel}.docx`;

  const filePath = await saveDialog({
    defaultPath,
    filters: [
      {
        name: t('filters.docx'),
        extensions: ['docx']
      }
    ]
  });

  if (!filePath) {
    return;
  }

  const progressToken = `dict-docx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  await bindExportProgressListener(progressToken);
  exporting.value = true;
  try {
    const savedPath = await DbmApi.exportDataDictionaryDocx(
      props.connection.id,
      filePath,
      queryDatabaseName.value,
      props.schemaName,
      progressToken
    );
    exportProgress.value = 100;
    exportProgressMessage.value = t('exportCompleted');
    ElMessage.success(t('exportSuccess', { savedPath }));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('exportFailed')));
  } finally {
    exporting.value = false;
    clearExportProgressListener();
    window.setTimeout(() => {
      exportProgressVisible.value = false;
    }, 1400);
  }
};

const selectTable = (tableName: string) => {
  if (selectedTableName.value === tableName && !tableStructMap.value[tableName]) {
    void loadTableDetail(tableName, true);
    return;
  }
  selectedTableName.value = tableName;
};

watch(
  () => [props.modelValue, props.connection?.id, props.databaseName, props.schemaName],
  ([visible]) => {
    if (!visible) {
      return;
    }
    void loadDictionary();
  },
  { immediate: true }
);

watch(normalizedKeyword, () => {
  ensureSelection();
});

watch(selectedTableName, (tableName) => {
  if (!tableName || tableStructMap.value[tableName]) {
    return;
  }
  void loadTableDetail(tableName);
});

onUnmounted(() => {
  clearExportProgressListener();
});
</script>

<style scoped>
:deep(.dictionary-dialog) {
  max-width: 1180px;
  max-height: 94vh;
  display: flex;
  flex-direction: column;
}

:deep(.dictionary-dialog .el-dialog__body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.empty-holder {
  min-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dictionary-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.dictionary-toolbar-left,
.dictionary-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.export-progress-card {
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: color-mix(in srgb, var(--el-color-primary-light-9) 28%, var(--el-bg-color) 72%);
}

.export-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.export-progress-text {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.export-progress-value {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.summary-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.search-input {
  width: 250px;
}

.dictionary-layout {
  height: clamp(460px, 72vh, 760px);
  display: flex;
  gap: 14px;
  overflow: hidden;
}

.table-sidebar {
  width: 240px;
  min-width: 240px;
  border: 1px solid var(--layout-border-color);
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-bg-color) 92%, var(--toolbar-bg-color) 8%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.sidebar-header {
  padding: 12px 14px;
  border-bottom: 1px solid var(--layout-border-color);
  font-size: 13px;
  font-weight: 600;
}

.sidebar-scroll {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  min-height: 0;
}

.table-list {
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 8px;
}

.table-list-item {
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--el-bg-color);
  text-align: left;
  cursor: pointer;
  transition: all 0.18s ease;
}

.table-list-item:hover {
  border-color: var(--el-color-primary-light-5);
  transform: translateY(-1px);
}

.table-list-item.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 25%, transparent 75%);
  background: color-mix(in srgb, var(--el-color-primary-light-9) 45%, var(--el-bg-color) 55%);
}

.table-list-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.table-list-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.table-list-comment {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.table-list-loading {
  margin-top: 8px;
}

.table-detail {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--layout-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  overflow: hidden;
  min-height: 0;
}

.table-detail-scroll {
  padding: 16px;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  align-items: flex-start;
}

.detail-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.detail-subtitle {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.detail-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-card {
  margin-bottom: 18px;
}

.detail-section + .detail-section {
  margin-top: 18px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}

.detail-empty {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 820px) {
  .dictionary-layout {
    flex-direction: column;
    min-height: 0;
    max-height: none;
    height: auto;
    overflow: visible;
  }

  .table-sidebar {
    width: 100%;
    min-width: 0;
    max-height: 260px;
  }

  .table-detail {
    max-height: 56vh;
  }
}
</style>
