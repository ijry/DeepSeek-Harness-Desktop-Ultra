<template>
  <el-dialog
    v-model="dialogVisible"
    class="sync-center-dialog"
    :title="t('title')"
    width="92vw"
    top="3vh"
  >
    <div class="sync-center">
      <div class="summary-bar">
        <div class="summary-left">
          <el-tag size="small" type="primary">{{ t('summary.connections', { count: supportedConnections.length }) }}</el-tag>
          <el-tag size="small" type="warning">{{ t('summary.tasks', { count: syncTasks.length }) }}</el-tag>
          <el-tag size="small" type="success">{{ t('summary.logs', { count: syncLogs.length }) }}</el-tag>
          <span class="summary-text">{{ t('summary.description') }}</span>
        </div>
        <div class="summary-right">
          <el-button size="small" :loading="refreshing" @click="refreshAll">{{ t('refresh') }}</el-button>
        </div>
      </div>

      <el-alert
        v-if="supportedConnections.length"
        class="sync-notice"
        type="warning"
        :closable="false"
        show-icon
        :title="t('notice.title')"
      >
        <div class="sync-notice-body">
          <p>{{ t('notice.body') }}</p>
          <p class="sync-notice-danger">{{ t('notice.danger') }}</p>
        </div>
      </el-alert>

      <div v-if="!supportedConnections.length" class="empty-holder">
        <el-empty :description="t('empty.noConnections')" />
      </div>

      <template v-else>
        <el-card class="section-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ t('config.title') }}</span>
              <span class="card-subtitle">{{ t('config.subtitle') }}</span>
            </div>
          </template>

          <div class="form-grid">
            <div class="form-item">
              <label>{{ t('config.sourceConnection') }}</label>
              <el-select v-model="form.sourceConnectionId" size="small" class="w-full" filterable>
                <el-option
                  v-for="connection in supportedConnections"
                  :key="connection.id"
                  :label="connection.name"
                  :value="connection.id"
                />
              </el-select>
            </div>
            <div class="form-item">
              <label>{{ t('config.sourceDatabase') }}</label>
              <el-select
                v-model="form.sourceDatabaseName"
                size="small"
                class="w-full"
                filterable
                allow-create
                default-first-option
                :disabled="sourceConnection?.db_type === 'sqlite'"
              >
                <el-option
                  v-for="dbName in sourceDatabases"
                  :key="dbName"
                  :label="dbName"
                  :value="dbName"
                />
              </el-select>
            </div>
            <div class="form-item">
              <label>{{ t('config.targetConnection') }}</label>
              <el-select v-model="form.targetConnectionId" size="small" class="w-full" filterable>
                <el-option
                  v-for="connection in supportedConnections"
                  :key="connection.id"
                  :label="connection.name"
                  :value="connection.id"
                />
              </el-select>
            </div>
            <div class="form-item">
              <label>{{ t('config.targetDatabase') }}</label>
              <el-select
                v-model="form.targetDatabaseName"
                size="small"
                class="w-full"
                filterable
                allow-create
                default-first-option
                :disabled="targetConnection?.db_type === 'sqlite'"
              >
                <el-option
                  v-for="dbName in targetDatabases"
                  :key="dbName"
                  :label="dbName"
                  :value="dbName"
                />
              </el-select>
            </div>
            <div class="form-item form-item-wide">
              <label>{{ t('config.syncContent') }}</label>
              <div class="sync-options">
                <el-checkbox v-model="form.syncStructure">{{ t('config.structure') }}</el-checkbox>
                <el-checkbox v-model="form.syncData">{{ t('config.data') }}</el-checkbox>
              </div>
            </div>
          </div>

          <div class="form-actions">
            <el-button @click="swapSourceTarget">{{ t('config.swap') }}</el-button>
            <el-button :loading="previewing" @click="previewSync">{{ t('config.preview') }}</el-button>
            <el-button type="primary" :loading="running" @click="startSync">{{ t('config.start') }}</el-button>
          </div>
        </el-card>

        <el-card class="section-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ t('tasks.title') }}</span>
              <span class="card-subtitle">{{ t('tasks.subtitle') }}</span>
            </div>
          </template>

          <el-table :data="syncTasks" border size="small" max-height="280">
            <el-table-column prop="name" :label="t('tasks.columns.name')" min-width="200" show-overflow-tooltip />
            <el-table-column :label="t('tasks.columns.status')" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="getTaskStatusTag(row.status)">
                  {{ formatTaskStatus(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.progress')" width="150">
              <template #default="{ row }">
                <el-progress
                  :percentage="roundProgress(row.progress)"
                  :stroke-width="6"
                  :status="row.status === 'Completed' ? 'success' : row.status === 'Failed' ? 'exception' : ''"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.flow')" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <div>
                  {{ getConnectionName(readMeta(row.metadata, 'source_connection_id', 'sourceConnectionId')) }}
                  /
                  {{ readMeta(row.metadata, 'source_database_name', 'sourceDatabaseName') || '-' }}
                </div>
                <div class="row-secondary">
                  {{ getConnectionName(readMeta(row.metadata, 'target_connection_id', 'targetConnectionId')) }}
                  /
                  {{ readMeta(row.metadata, 'target_database_name', 'targetDatabaseName') || '-' }}
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.createdAt')" width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.created_at) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.error')" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.error_message || '-' }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card class="section-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ t('logs.title') }}</span>
              <span class="card-subtitle">{{ t('logs.subtitle') }}</span>
            </div>
          </template>

          <el-table :data="syncLogs" border size="small" max-height="360">
            <el-table-column type="expand" width="52">
              <template #default="{ row }">
                <div class="log-detail-panel">
                  <div v-if="!row.details?.length" class="log-detail-empty">
                    {{ t('logs.noDetails') }}
                  </div>
                  <div v-else class="log-detail-list">
                    <div
                      v-for="detail in row.details"
                      :key="detail.tableName"
                      class="log-detail-card"
                    >
                      <div class="log-detail-head">
                        <span class="log-detail-name">{{ detail.tableName }}</span>
                        <div class="log-detail-tags">
                          <el-tag size="small" :type="getDetailStatusTag(detail.structureStatus)">
                            {{ t('logs.structure') }} {{ formatDetailStatus(detail.structureStatus) }}
                          </el-tag>
                          <el-tag size="small" :type="getDetailStatusTag(detail.dataStatus)">
                            {{ t('logs.data') }} {{ formatDetailStatus(detail.dataStatus) }}
                          </el-tag>
                        </div>
                      </div>
                      <div class="log-detail-metrics">
                        <span>{{ t('logs.inserted', { count: toSafeCount(detail.insertedCount) }) }}</span>
                        <span>{{ t('logs.updated', { count: toSafeCount(detail.updatedCount) }) }}</span>
                        <span>{{ t('logs.deleted', { count: toSafeCount(detail.deletedCount) }) }}</span>
                        <span>{{ t('logs.elapsed', { ms: toSafeCount(detail.elapsedMs) }) }}</span>
                        <span>{{ t('logs.sqlCount', { count: toSafeCount(detail.sqlCount) }) }}</span>
                      </div>
                      <div v-if="detail.structureActions?.length" class="log-detail-actions">
                        {{ detail.structureActions.join(t('comma')) }}
                      </div>
                      <div v-if="detail.skippedReason" class="row-secondary">
                        {{ t('logs.skippedReason', { reason: detail.skippedReason }) }}
                      </div>
                      <div v-if="detail.errorMessage" class="log-detail-error">
                        {{ detail.errorMessage }}
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.time')" width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.createdAt) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.flow')" min-width="280" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ getConnectionName(row.sourceConnectionId) }} / {{ row.sourceDatabaseName || '-' }}</div>
                <div class="row-secondary">{{ getConnectionName(row.targetConnectionId) }} / {{ row.targetDatabaseName || '-' }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.mode')" width="140">
              <template #default="{ row }">
                {{ formatSyncMode(row.syncStructure, row.syncData) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.status')" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'Completed' ? 'success' : 'danger'">
                  {{ formatTaskStatus(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="tableCount" :label="t('logs.columns.tableCount')" width="80" />
            <el-table-column :label="t('logs.columns.structureSummary')" width="180">
              <template #default="{ row }">
                {{ formatStructureSummary(row) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.dataSummary')" width="180">
              <template #default="{ row }">
                {{ formatDataSummary(row) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('logs.columns.result')" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.message || row.resultFile || '-' }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>
    <el-dialog
      v-model="previewDialogVisible"
      :title="t('preview.title')"
      width="78vw"
      top="6vh"
    >
      <div v-if="!previewResult" class="empty-holder">
        <el-empty :description="t('preview.empty')" />
      </div>
      <template v-else>
        <el-alert :title="previewResult.message || t('preview.empty')" type="info" :closable="false" show-icon />
        <div class="preview-toolbar mt-10px">
          <el-input
            v-model="previewFilterKeyword"
            size="small"
            clearable
            class="preview-filter-input"
            :placeholder="t('preview.filterPlaceholder')"
          />
          <el-button size="small" @click="copyPreviewSql">{{ t('preview.copySql') }}</el-button>
          <el-button size="small" @click="exportPreviewSql">{{ t('preview.exportSql') }}</el-button>
        </div>
        <div class="mt-10px text-12px color-[var(--el-text-color-secondary)]">
          {{ t('preview.sqlCount', { count: filteredPreviewSqlStatements.length }) }}
        </div>
        <el-table :data="filteredPreviewDetails" border size="small" max-height="260" class="mt-10px">
          <el-table-column prop="tableName" :label="t('logs.columns.tableCount')" min-width="160" />
          <el-table-column :label="t('logs.columns.structureSummary')" min-width="260">
            <template #default="{ row }">
              {{ row.structureActions?.join(t('comma')) || '-' }}
            </template>
          </el-table-column>
          <el-table-column :label="t('logs.columns.dataSummary')" width="180">
            <template #default="{ row }">
              {{ t('summaryDetail.inserted', { count: toSafeCount(row.insertedCount) }) }} /
              {{ t('summaryDetail.updated', { count: toSafeCount(row.updatedCount) }) }} /
              {{ t('summaryDetail.deleted', { count: toSafeCount(row.deletedCount) }) }}
            </template>
          </el-table-column>
        </el-table>
        <div class="mt-12px text-12px font-600">{{ t('preview.sqlTitle') }}</div>
        <div class="sync-preview-sql">
          <pre v-if="filteredPreviewSqlStatements.length">{{ filteredPreviewSqlStatements.join('\n\n') }}</pre>
          <el-empty v-else :description="t('preview.noSql')" />
        </div>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeHostFile } from '@/utils/hostFs';
import {
  DbmApi,
  extractDbmErrorMessage,
  type DbConnection,
  type DbSyncLog,
  type DbSyncPreviewResult,
  type DbSyncTableDetail
} from './service';
import { useI18nScope } from '@/platform/i18n';

type TaskStatusText = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';

interface SyncTask {
  id: string;
  name: string;
  task_type: unknown;
  status: TaskStatusText;
  progress: number;
  created_at: string;
  updated_at: string;
  duration: number;
  result_path?: string | null;
  error_message?: string | null;
  metadata: Record<string, string>;
}

const props = defineProps<{
  modelValue: boolean;
  preferredConnectionId?: string;
  preferredDatabaseName?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
const { t } = useI18nScope('dbm.syncCenter');

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});

const refreshing = ref(false);
const running = ref(false);
const previewing = ref(false);
const connections = ref<DbConnection[]>([]);
const tasks = ref<SyncTask[]>([]);
const syncLogs = ref<DbSyncLog[]>([]);
const sourceDatabases = ref<string[]>([]);
const targetDatabases = ref<string[]>([]);
const previewDialogVisible = ref(false);
const previewResult = ref<DbSyncPreviewResult | null>(null);
const previewFilterKeyword = ref('');
const lastPreviewToken = ref('');

const form = reactive({
  sourceConnectionId: '',
  sourceDatabaseName: '',
  targetConnectionId: '',
  targetDatabaseName: '',
  syncStructure: true,
  syncData: true
});

const supportedConnections = computed(() =>
  connections.value.filter((connection) =>
    ['mysql', 'mariadb', 'sqlite', 'oracle', 'sqlserver', 'kingbasees', 'dameng'].includes(connection.db_type)
  )
);

const sourceConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === form.sourceConnectionId) || null
);
const targetConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === form.targetConnectionId) || null
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeTaskType = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (!keys.length) {
      return '';
    }
    const enumKey = keys[0];
    const enumValue = value[enumKey];
    const normalizedKey = enumKey.trim().toLowerCase();
    if (normalizedKey === 'custom' && typeof enumValue === 'string') {
      return `custom:${enumValue.trim().toLowerCase()}`;
    }
    return normalizedKey;
  }
  return '';
};

const readMeta = (metadata: Record<string, string>, key: string, altKey: string) =>
  (metadata[key] || metadata[altKey] || '').toString();

const syncTasks = computed(() =>
  [...tasks.value]
    .filter((task) => {
      const taskType = normalizeTaskType(task.task_type);
      if (taskType === 'custom:sync') {
        return true;
      }
      return !!readMeta(task.metadata || {}, 'source_connection_id', 'sourceConnectionId')
        && !!readMeta(task.metadata || {}, 'target_connection_id', 'targetConnectionId');
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
);

const roundProgress = (value: number) => Number((Number(value) || 0).toFixed(2));

const toSafeCount = (value?: number | null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const getConnectionName = (connectionId: string) =>
  supportedConnections.value.find((item) => item.id === connectionId)?.name || connectionId || '-';

const getTaskStatusTag = (status: string) => {
  switch (status) {
    case 'Completed':
      return 'success';
    case 'Running':
      return 'primary';
    case 'Failed':
      return 'danger';
    case 'Cancelled':
      return 'info';
    default:
      return 'warning';
  }
};

const formatTaskStatus = (status: string) => {
  switch (status) {
    case 'Pending':
      return t('status.pending');
    case 'Running':
      return t('status.running');
    case 'Completed':
      return t('status.completed');
    case 'Failed':
      return t('status.failed');
    case 'Cancelled':
      return t('status.cancelled');
    default:
      return status || '-';
  }
};

const formatSyncMode = (syncStructure: boolean, syncData: boolean) => {
  if (syncStructure && syncData) {
    return t('mode.structureAndData');
  }
  if (syncStructure) {
    return t('mode.structureOnly');
  }
  if (syncData) {
    return t('mode.dataOnly');
  }
  return '-';
};

const formatStructureSummary = (log: DbSyncLog) =>
  [
    t('summaryDetail.created', { count: toSafeCount(log.createdTableCount) }),
    t('summaryDetail.altered', { count: toSafeCount(log.alteredTableCount) }),
    t('summaryDetail.failed', { count: toSafeCount(log.failedTableCount) })
  ].join(' / ');

const formatDataSummary = (log: DbSyncLog) =>
  [
    t('summaryDetail.inserted', { count: toSafeCount(log.insertedCount) }),
    t('summaryDetail.updated', { count: toSafeCount(log.updatedCount) }),
    t('summaryDetail.deleted', { count: toSafeCount(log.deletedCount) })
  ].join(' / ');

const formatDetailStatus = (status?: string | null) => {
  switch ((status || '').toLowerCase()) {
    case 'created':
      return t('detailStatus.created');
    case 'altered':
      return t('detailStatus.altered');
    case 'synced':
      return t('detailStatus.synced');
    case 'unchanged':
      return t('detailStatus.unchanged');
    case 'skipped':
      return t('detailStatus.skipped');
    case 'failed':
      return t('detailStatus.failed');
    default:
      return '-';
  }
};

const getDetailStatusTag = (status?: DbSyncTableDetail['structureStatus']) => {
  switch ((status || '').toLowerCase()) {
    case 'created':
    case 'altered':
    case 'synced':
      return 'success';
    case 'failed':
      return 'danger';
    case 'skipped':
      return 'warning';
    case 'unchanged':
      return 'info';
    default:
      return 'info';
  }
};

const resolveDatabaseName = (connection: DbConnection | null, input: string) => {
  if (!connection) {
    return '';
  }
  if (connection.db_type === 'sqlite') {
    return connection.database || '';
  }
  const normalized = (input || '').trim();
  return normalized || connection.database || '';
};

const toBase64 = (content: string) => {
  const utf8 = new TextEncoder().encode(content);
  let binary = '';
  for (const item of utf8) {
    binary += String.fromCharCode(item);
  }
  return btoa(binary);
};

const extractSqlTableCandidates = (sql: string): string[] => {
  const matches = sql.match(/([A-Za-z0-9_]+\.)?[A-Za-z0-9_]+/g) || [];
  return matches.map((item) => item.replace(/[`"\[\]]/g, '').toLowerCase());
};

const filteredPreviewDetails = computed(() => {
  const details = previewResult.value?.details || [];
  const keyword = previewFilterKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return details;
  }
  return details.filter((detail) => detail.tableName?.toLowerCase().includes(keyword));
});

const filteredPreviewSqlStatements = computed(() => {
  const statements = previewResult.value?.sqlStatements || [];
  const keyword = previewFilterKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return statements;
  }
  const tableNames = new Set(filteredPreviewDetails.value.map((item) => item.tableName.toLowerCase()));
  return statements.filter((sql) => {
    const normalized = sql.toLowerCase();
    if (normalized.includes(keyword)) {
      return true;
    }
    const candidates = extractSqlTableCandidates(sql);
    return candidates.some((item) => tableNames.has(item));
  });
});

const applySyncModeConstraints = () => {};

const applyPreferred = () => {
  const firstConnection = supportedConnections.value[0] || null;
  const preferredSource = supportedConnections.value.find((item) => item.id === props.preferredConnectionId)
    || firstConnection;

  let preferredTarget = supportedConnections.value.find((item) => item.id !== preferredSource?.id) || null;
  if (!preferredTarget) {
    preferredTarget = preferredSource;
  }

  if (!form.sourceConnectionId && preferredSource) {
    form.sourceConnectionId = preferredSource.id;
  }
  if (!form.targetConnectionId && preferredTarget) {
    form.targetConnectionId = preferredTarget.id;
  }

  const sourceConn = supportedConnections.value.find((item) => item.id === form.sourceConnectionId) || null;
  const targetConn = supportedConnections.value.find((item) => item.id === form.targetConnectionId) || null;
  const preferredDbName = props.preferredDatabaseName || sourceConn?.database || '';

  if (!form.sourceDatabaseName) {
    form.sourceDatabaseName = preferredDbName;
  }
  if (!form.targetDatabaseName) {
    form.targetDatabaseName = targetConn?.database || preferredDbName;
  }
  applySyncModeConstraints();
};

const loadDatabasesForConnection = async (connectionId: string, direction: 'source' | 'target') => {
  const targetRef = direction === 'source' ? sourceDatabases : targetDatabases;
  const formField = direction === 'source' ? 'sourceDatabaseName' : 'targetDatabaseName';
  const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;

  if (!connection) {
    targetRef.value = [];
    form[formField] = '';
    return;
  }

  if (connection.db_type === 'sqlite') {
    targetRef.value = [connection.database];
    form[formField] = connection.database;
    return;
  }

  try {
    const list = await DbmApi.getDatabases(connectionId);
    const options = Array.from(new Set([...(list || []), connection.database].filter((name) => !!name)));
    targetRef.value = options;
    if (!form[formField]) {
      form[formField] = options[0] || connection.database || '';
    }
  } catch (error) {
    targetRef.value = connection.database ? [connection.database] : [];
    if (!form[formField]) {
      form[formField] = connection.database || '';
    }
    console.error(`${direction === 'source' ? 'source' : 'target'} database list load failed:`, error);
  }
};

const loadConnections = async () => {
  connections.value = await DbmApi.getConnections();
  applyPreferred();
};

const refreshTasks = async () => {
  const allTasks = await invoke<SyncTask[]>('get_all_tasks');
  tasks.value = allTasks.map((task) => ({
    ...task,
    progress: roundProgress(task.progress),
    metadata: task.metadata || {}
  }));
};

const refreshLogs = async () => {
  syncLogs.value = await DbmApi.getSyncLogs();
};

const refreshAll = async () => {
  if (!dialogVisible.value) {
    return;
  }

  refreshing.value = true;
  try {
    await loadConnections();
    await Promise.all([
      loadDatabasesForConnection(form.sourceConnectionId, 'source'),
      loadDatabasesForConnection(form.targetConnectionId, 'target'),
      refreshTasks(),
      refreshLogs()
    ]);
  } finally {
    refreshing.value = false;
  }
};

const swapSourceTarget = () => {
  const sourceConnectionId = form.sourceConnectionId;
  const sourceDatabaseName = form.sourceDatabaseName;

  form.sourceConnectionId = form.targetConnectionId;
  form.sourceDatabaseName = form.targetDatabaseName;
  form.targetConnectionId = sourceConnectionId;
  form.targetDatabaseName = sourceDatabaseName;
  applySyncModeConstraints();
};

const startSync = async () => {
  if (!form.syncStructure && !form.syncData) {
    ElMessage.warning(t('warning.selectMode'));
    return;
  }
  if (!form.sourceConnectionId || !form.targetConnectionId) {
    ElMessage.warning(t('warning.selectConnections'));
    return;
  }

  const sourceDb = resolveDatabaseName(sourceConnection.value, form.sourceDatabaseName);
  const targetDb = resolveDatabaseName(targetConnection.value, form.targetDatabaseName);
  if (!sourceDb || !targetDb) {
    ElMessage.warning(t('warning.databaseRequired'));
    return;
  }
  applySyncModeConstraints();

  running.value = true;
  try {
    const taskId = await DbmApi.syncDatabasesAsTask(
      form.sourceConnectionId,
      sourceDb,
      form.targetConnectionId,
      targetDb,
      form.syncStructure,
      form.syncData,
      lastPreviewToken.value || null
    );
    ElMessage.success(t('startSuccess', { taskId }));
    await refreshTasks();
    await refreshLogs();
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('startFailed')));
  } finally {
    running.value = false;
  }
};

const previewSync = async () => {
  if (!form.syncStructure && !form.syncData) {
    ElMessage.warning(t('warning.selectMode'));
    return;
  }
  if (!form.sourceConnectionId || !form.targetConnectionId) {
    ElMessage.warning(t('warning.selectConnections'));
    return;
  }

  const sourceDb = resolveDatabaseName(sourceConnection.value, form.sourceDatabaseName);
  const targetDb = resolveDatabaseName(targetConnection.value, form.targetDatabaseName);
  if (!sourceDb || !targetDb) {
    ElMessage.warning(t('warning.databaseRequired'));
    return;
  }

  previewing.value = true;
  try {
    previewResult.value = await DbmApi.previewSyncPlan(
      form.sourceConnectionId,
      sourceDb,
      form.targetConnectionId,
      targetDb,
      form.syncStructure,
      form.syncData
    );
    lastPreviewToken.value = previewResult.value.planToken || '';
    previewDialogVisible.value = true;
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('preview.failed')));
  } finally {
    previewing.value = false;
  }
};

const copyPreviewSql = async () => {
  try {
    const sql = filteredPreviewSqlStatements.value.join('\n\n').trim();
    if (!sql) {
      ElMessage.warning(t('preview.noSql'));
      return;
    }
    await navigator.clipboard.writeText(sql);
    ElMessage.success(t('preview.copySqlSuccess'));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('preview.copySqlFailed')));
  }
};

const exportPreviewSql = async () => {
  try {
    const sql = filteredPreviewSqlStatements.value.join('\n\n').trim();
    if (!sql) {
      ElMessage.warning(t('preview.noSql'));
      return;
    }
    const path = await saveDialog({
      defaultPath: `db-sync-preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sql`,
      filters: [{ name: 'SQL', extensions: ['sql'] }]
    });
    if (!path) {
      return;
    }
    await writeHostFile({
      path,
      dataBase64: toBase64(sql)
    });
    ElMessage.success(t('preview.exportSqlSuccess'));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('preview.exportSqlFailed')));
  }
};

watch(
  () => dialogVisible.value,
  (visible) => {
    if (visible) {
      void refreshAll();
      return;
    }
    lastPreviewToken.value = '';
    previewFilterKeyword.value = '';
    previewResult.value = null;
  }
);

watch(
  () => form.sourceConnectionId,
  (connectionId) => {
    applySyncModeConstraints();
    if (!dialogVisible.value || !connectionId) {
      return;
    }
    void loadDatabasesForConnection(connectionId, 'source');
  }
);

watch(
  () => form.targetConnectionId,
  (connectionId) => {
    applySyncModeConstraints();
    if (!dialogVisible.value || !connectionId) {
      return;
    }
    void loadDatabasesForConnection(connectionId, 'target');
  }
);

watch(
  () => [
    form.sourceConnectionId,
    form.sourceDatabaseName,
    form.targetConnectionId,
    form.targetDatabaseName,
    form.syncStructure,
    form.syncData
  ],
  () => {
    lastPreviewToken.value = '';
  }
);

let taskListener: UnlistenFn | null = null;
let taskRefreshTimer: ReturnType<typeof window.setTimeout> | null = null;

onMounted(async () => {
  taskListener = await listen<SyncTask>('task-updated', () => {
    if (!dialogVisible.value) {
      return;
    }
    if (taskRefreshTimer) {
      clearTimeout(taskRefreshTimer);
    }
    taskRefreshTimer = window.setTimeout(() => {
      void Promise.all([refreshTasks(), refreshLogs()]);
      taskRefreshTimer = null;
    }, 160);
  });
});

onUnmounted(() => {
  if (taskListener) {
    taskListener();
    taskListener = null;
  }
  if (taskRefreshTimer) {
    clearTimeout(taskRefreshTimer);
    taskRefreshTimer = null;
  }
});
</script>

<style scoped>
:deep(.sync-center-dialog) {
  max-height: 90vh;
}

:deep(.sync-center-dialog .el-dialog__body) {
  height: calc(90vh - 120px);
  overflow: hidden;
  padding-top: 10px;
}

.sync-center {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.summary-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.summary-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.sync-notice {
  flex: 0 0 auto;
}

.sync-notice-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
}

.sync-notice-body p {
  margin: 0;
}

.sync-notice-danger {
  color: var(--el-color-danger);
  font-weight: 600;
}

.empty-holder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  min-height: 220px;
}

.section-card {
  flex: 0 0 auto;
}

.card-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-subtitle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-item label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.form-item-wide {
  grid-column: 1 / -1;
}

.sync-options {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 30px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}

.row-secondary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.sync-preview-sql {
  margin-top: 8px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 8px;
  max-height: 280px;
  overflow: auto;
  background: var(--el-fill-color-lighter);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-filter-input {
  max-width: 320px;
}

.sync-preview-sql pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
}

.w-full {
  width: 100%;
}

.log-detail-panel {
  padding: 4px 6px;
}

.log-detail-empty {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.log-detail-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.log-detail-card {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-extra-light);
}

.log-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.log-detail-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.log-detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.log-detail-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.log-detail-actions {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.log-detail-error {
  margin-top: 8px;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

@media (max-width: 960px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .log-detail-head {
    flex-direction: column;
  }

  .log-detail-tags {
    justify-content: flex-start;
  }
}
</style>
