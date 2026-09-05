<template>
  <el-dialog
    v-model="dialogVisible"
    class="backup-center-dialog"
    :title="t('title')"
    width="94vw"
    top="3vh"
  >
    <div class="backup-center">
      <div class="summary-bar">
        <div class="summary-left">
          <el-tag size="small" type="primary">{{ t('summary.connections', { count: supportedConnections.length }) }}</el-tag>
          <el-tag size="small" type="success">{{ t('summary.plans', { count: plans.length }) }}</el-tag>
          <el-tag size="small" type="warning">{{ t('summary.tasks', { count: backupTasks.length }) }}</el-tag>
          <span class="summary-text">{{ t('summary.description') }}</span>
        </div>
        <div class="summary-right">
          <el-button size="small" :loading="refreshing" @click="refreshAll">{{ t('refresh') }}</el-button>
        </div>
      </div>

      <div class="storage-hint" v-loading="storageInfoLoading">
        <div class="storage-hint-title">{{ t('storage.title') }}</div>
        <div v-if="storageInfo" class="storage-hint-content">
          <span class="storage-hint-row">{{ t('storage.path', { path: storageInfo.path }) }}</span>
          <span class="storage-hint-row">
            {{ t('storage.usage', {
              used: formatBytes(storageInfo.usedBytes),
              total: formatBytes(storageInfo.totalBytes),
              percent: storageInfo.usagePercent.toFixed(1),
              available: formatBytes(storageInfo.availableBytes)
            }) }}
          </span>
          <span class="storage-hint-row">
            {{ storageInfo.sampleBackupCount > 0
              ? t('storage.averageRecent', {
                count: storageInfo.sampleBackupCount,
                size: formatBytes(storageInfo.averageBackupBytes),
                estimated: storageInfo.estimatedBackupCount
              })
              : t('storage.averageDefault', {
                size: formatBytes(storageInfo.averageBackupBytes),
                estimated: storageInfo.estimatedBackupCount
              }) }}
          </span>
        </div>
        <div v-else-if="storageInfoError" class="storage-hint-error">
          {{ storageInfoError }}
        </div>
        <div v-else class="storage-hint-empty">
          {{ t('storage.loading') }}
        </div>
      </div>

      <div v-if="!supportedConnections.length" class="empty-holder">
        <el-empty :description="t('empty.noConnections')" />
      </div>

      <template v-else>
        <div class="action-grid">
          <el-card class="action-card" shadow="never">
            <template #header>
              <div class="card-header">
                <span>{{ t('manual.title') }}</span>
                <span class="card-subtitle">{{ t('manual.subtitle') }}</span>
              </div>
            </template>

            <el-form label-width="96px" size="small">
              <el-form-item :label="t('fields.connection')">
                <el-select v-model="manualBackupForm.connectionId" class="w-full" filterable>
                  <el-option
                    v-for="connection in supportedConnections"
                    :key="connection.id"
                    :label="connection.name"
                    :value="connection.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('fields.database')">
                <el-input
                  v-model="manualBackupForm.databaseName"
                  :disabled="manualBackupConnection?.db_type === 'sqlite'"
                  :placeholder="manualBackupConnection?.db_type === 'sqlite' ? t('placeholders.sqliteAutoUseConnectionFile') : t('placeholders.enterDatabaseName')"
                />
              </el-form-item>
              <el-form-item :label="t('fields.exportDirectory')">
                <div class="path-picker">
                  <el-input v-model="manualBackupForm.exportPath" readonly :placeholder="t('placeholders.selectExportDirectory')" />
                  <el-button size="small" @click="selectManualBackupDirectory">{{ t('buttons.browse') }}</el-button>
                </div>
              </el-form-item>
            </el-form>

            <div class="card-actions">
              <el-button type="primary" :loading="manualBackupRunning" @click="startManualBackup">
                {{ t('buttons.startBackup') }}
              </el-button>
            </div>
          </el-card>

          <el-card class="action-card" shadow="never">
            <template #header>
              <div class="card-header">
                <span>{{ t('restore.title') }}</span>
                <span class="card-subtitle">{{ t('restore.subtitle') }}</span>
              </div>
            </template>

            <el-form label-width="96px" size="small">
              <el-form-item :label="t('fields.connection')">
                <el-select v-model="restoreForm.connectionId" class="w-full" filterable>
                  <el-option
                    v-for="connection in supportedConnections"
                    :key="connection.id"
                    :label="connection.name"
                    :value="connection.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('fields.database')">
                <el-input
                  v-model="restoreForm.databaseName"
                  :disabled="restoreConnection?.db_type === 'sqlite'"
                  :placeholder="restoreConnection?.db_type === 'sqlite' ? t('placeholders.sqliteAutoUseConnectionFile') : t('placeholders.enterTargetDatabaseName')"
                />
              </el-form-item>
              <el-form-item :label="t('fields.backupFile')">
                <div class="path-picker">
                  <el-input v-model="restoreForm.backupPath" readonly :placeholder="t('placeholders.selectBackupFile')" />
                  <el-button size="small" @click="selectRestoreFile">{{ t('buttons.browse') }}</el-button>
                </div>
              </el-form-item>
            </el-form>

            <div class="card-actions">
              <el-button type="warning" :loading="restoreRunning" @click="startRestore">
                {{ t('buttons.startRestore') }}
              </el-button>
            </div>
          </el-card>
        </div>

        <el-card class="section-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ t('plans.title') }}</span>
              <span class="card-subtitle">{{ t('plans.subtitle') }}</span>
            </div>
          </template>

          <div class="plan-form-grid">
            <div class="plan-form-item">
              <label>{{ t('plans.fields.name') }}</label>
              <el-input v-model="planForm.name" size="small" :placeholder="t('plans.placeholders.name')" />
            </div>
            <div class="plan-form-item">
              <label>{{ t('fields.connection') }}</label>
              <el-select v-model="planForm.connectionId" size="small" class="w-full" filterable>
                <el-option
                  v-for="connection in supportedConnections"
                  :key="connection.id"
                  :label="connection.name"
                  :value="connection.id"
                />
              </el-select>
            </div>
            <div class="plan-form-item">
              <label>{{ t('fields.database') }}</label>
              <el-input
                v-model="planForm.databaseName"
                size="small"
                :disabled="planConnection?.db_type === 'sqlite'"
                :placeholder="planConnection?.db_type === 'sqlite' ? t('placeholders.sqliteAutoUseConnectionFile') : t('placeholders.enterDatabaseName')"
              />
            </div>
            <div class="plan-form-item">
              <label>{{ t('plans.fields.scheduleType') }}</label>
              <el-select v-model="planForm.scheduleType" size="small" class="w-full">
                <el-option :label="t('plans.schedule.daily')" value="daily" />
                <el-option :label="t('plans.schedule.interval')" value="interval" />
              </el-select>
            </div>
            <div class="plan-form-item" v-if="planForm.scheduleType === 'daily'">
              <label>{{ t('plans.fields.executionTime') }}</label>
              <el-time-select
                v-model="planForm.dailyTime"
                size="small"
                class="w-full"
                start="00:00"
                step="00:30"
                end="23:30"
                :placeholder="t('plans.placeholders.executionTime')"
              />
            </div>
            <div class="plan-form-item" v-else>
              <label>{{ t('plans.fields.intervalHours') }}</label>
              <el-input-number v-model="planForm.intervalHours" :min="1" :max="720" size="small" class="w-full" />
            </div>
            <div class="plan-form-item">
              <label>{{ t('plans.fields.retentionDays') }}</label>
              <el-input-number v-model="planForm.retentionDays" :min="0" :max="3650" size="small" class="w-full" />
              <span class="form-hint">{{ t('plans.retentionHint') }}</span>
            </div>
            <div class="plan-form-item plan-form-item-wide">
              <label>{{ t('fields.exportDirectory') }}</label>
              <div class="path-picker">
                <el-input v-model="planForm.exportPath" size="small" readonly :placeholder="t('plans.placeholders.exportDirectory')" />
                <el-button size="small" @click="selectPlanDirectory">{{ t('buttons.browse') }}</el-button>
              </div>
            </div>
          </div>

          <div class="plan-actions">
            <el-switch v-model="planForm.enabled" :active-text="t('plans.enabled')" :inactive-text="t('plans.disabled')" />
            <div class="plan-actions-right">
              <el-button v-if="editingPlanId" size="small" @click="resetPlanForm">{{ t('buttons.cancelEdit') }}</el-button>
              <el-button type="primary" size="small" @click="savePlan">
                {{ editingPlanId ? t('buttons.savePlan') : t('buttons.addPlan') }}
              </el-button>
            </div>
          </div>

          <el-table :data="plans" border size="small" max-height="280" class="mt-12px">
            <el-table-column prop="name" :label="t('plans.columns.name')" min-width="160" show-overflow-tooltip />
            <el-table-column :label="t('plans.columns.target')" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ getConnectionName(row.connectionId) }}</div>
                <div class="row-secondary">{{ getDisplayDatabaseNameByPlan(row) }}</div>
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.schedule')" width="150">
              <template #default="{ row }">
                {{ formatPlanSchedule(row) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.retention')" width="130">
              <template #default="{ row }">
                {{ row.retentionDays > 0 ? t('plans.retentionDays', { days: row.retentionDays }) : t('plans.retentionNever') }}
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.status')" width="120">
              <template #default="{ row }">
                <el-tag size="small" :type="getPlanStatusTag(row)">
                  {{ getPlanStatusLabel(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.lastTriggeredAt')" width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.lastTriggeredAt) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.enabled')" width="90">
              <template #default="{ row }">
                <el-switch v-model="row.enabled" @change="handlePlanToggle" />
              </template>
            </el-table-column>
            <el-table-column :label="t('plans.columns.actions')" width="220">
              <template #default="{ row }">
                <div class="row-actions">
                  <el-button size="small" @click="runPlanNow(row)">{{ t('buttons.runNow') }}</el-button>
                  <el-button size="small" @click="editPlan(row)">{{ t('buttons.edit') }}</el-button>
                  <el-button size="small" type="danger" @click="removePlan(row)">{{ t('buttons.delete') }}</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card class="section-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ t('tasks.title') }}</span>
              <span class="card-subtitle">{{ t('tasks.subtitle') }}</span>
            </div>
          </template>

          <el-table :data="backupTasks" border size="small" max-height="320">
            <el-table-column prop="name" :label="t('tasks.columns.name')" min-width="210" show-overflow-tooltip />
            <el-table-column :label="t('tasks.columns.type')" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="normalizeTaskType(row.task_type) === 'backup' ? 'warning' : 'info'">
                  {{ normalizeTaskType(row.task_type) === 'backup' ? t('tasks.type.backup') : t('tasks.type.restore') }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.status')" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="getTaskStatusTag(row.status)">
                  {{ row.status }}
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
            <el-table-column :label="t('tasks.columns.database')" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.metadata.database_name || '-' }}
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.createdAt')" width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.created_at) }}
              </template>
            </el-table-column>
            <el-table-column :label="t('tasks.columns.actions')" width="210">
              <template #default="{ row }">
                <div class="row-actions">
                  <el-button
                    v-if="row.status === 'Completed' && row.result_path"
                    size="small"
                    @click="openDirectory(row.result_path)"
                  >
                    {{ t('buttons.openDirectory') }}
                  </el-button>
                  <el-button
                    v-if="row.status === 'Failed'"
                    size="small"
                    @click="retryTask(row.id)"
                  >
                    {{ t('buttons.retry') }}
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openHostFsWindow } from '@/platform/ui/fsWindow';
import { homeDir, join } from '@/utils/remotePath';
import {
  DbmApi,
  extractDbmErrorMessage,
  type BackupPlan,
  type BackupStorageInfo,
  type DbConnection
} from './service';
import { hasHostBridgeRuntime } from '@/platform/runtime';
import { useI18nScope } from '@/platform/i18n';

type TaskStatusText = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';

interface BackupTask {
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

const BACKUP_PLANS_UPDATED_EVENT = 'dbm-backup-plans-updated';
const isTauriRuntime = hasHostBridgeRuntime();
const { t } = useI18nScope('dbm.backupCenter');

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});

const refreshing = ref(false);
const manualBackupRunning = ref(false);
const restoreRunning = ref(false);
const connections = ref<DbConnection[]>([]);
const plans = ref<BackupPlan[]>([]);
const tasks = ref<BackupTask[]>([]);
const editingPlanId = ref('');
const storageInfo = ref<BackupStorageInfo | null>(null);
const storageInfoError = ref('');
const storageInfoLoading = ref(false);

const manualBackupForm = reactive({
  connectionId: '',
  databaseName: '',
  exportPath: ''
});

const restoreForm = reactive({
  connectionId: '',
  databaseName: '',
  backupPath: ''
});

const planForm = reactive({
  name: '',
  connectionId: '',
  databaseName: '',
  exportPath: '',
  scheduleType: 'daily' as BackupPlan['scheduleType'],
  dailyTime: '02:00',
  intervalHours: 24,
  enabled: true,
  retentionDays: 20
});

const supportedConnections = computed(() =>
  connections.value.filter((connection) =>
    ['mysql', 'mariadb', 'postgresql', 'sqlite', 'oracle', 'sqlserver', 'kingbasees', 'dameng'].includes(connection.db_type)
  )
);

const manualBackupConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === manualBackupForm.connectionId) || null
);

const restoreConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === restoreForm.connectionId) || null
);

const planConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === planForm.connectionId) || null
);

const backupTasks = computed(() =>
  [...tasks.value]
    .filter((task) => {
      const taskType = normalizeTaskType(task.task_type);
      return taskType === 'backup' || taskType === 'restore';
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
);

let taskListener: UnlistenFn | null = null;
let backupPlansListener: UnlistenFn | null = null;
let refreshDebounceTimer: ReturnType<typeof window.setTimeout> | null = null;
let storageInfoDebounceTimer: ReturnType<typeof window.setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const roundProgress = (value: number) => Number((Number(value) || 0).toFixed(2));

const normalizeTaskType = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length) {
      return keys[0].trim().toLowerCase();
    }
  }
  return '';
};

const normalizePlan = (value: unknown): BackupPlan | null => {
  if (!isRecord(value)) {
    return null;
  }

  const scheduleType = value.scheduleType === 'interval' ? 'interval' : 'daily';
  const intervalHours = Number(value.intervalHours);

  return {
    id: typeof value.id === 'string' ? value.id : '',
    name: typeof value.name === 'string' ? value.name : '',
    connectionId: typeof value.connectionId === 'string' ? value.connectionId : '',
    databaseName: typeof value.databaseName === 'string' ? value.databaseName : '',
    exportPath: typeof value.exportPath === 'string' ? value.exportPath : '',
    scheduleType,
    dailyTime: typeof value.dailyTime === 'string' && value.dailyTime ? value.dailyTime : '02:00',
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? Math.round(intervalHours) : 24,
    enabled: value.enabled !== false,
    retentionDays: Math.max(0, Math.round(Number(value.retentionDays) || 0)),
    createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date().toISOString(),
    lastTriggeredAt: typeof value.lastTriggeredAt === 'string' ? value.lastTriggeredAt : null,
    lastTaskId: typeof value.lastTaskId === 'string' ? value.lastTaskId : null,
    lastRunStatus: typeof value.lastRunStatus === 'string' ? value.lastRunStatus : null,
    lastSuccessAt: typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
    lastErrorMessage: typeof value.lastErrorMessage === 'string' ? value.lastErrorMessage : null
  };
};

const buildDefaultBackupDirectory = async (mode: 'manual' | 'schedule') => {
  const home = await homeDir();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return join(home, '.otools', 'local', 'dbm', 'backup', mode, date);
};

const resolveDatabaseName = (connection: DbConnection | null, rawValue: string) => {
  if (!connection) {
    return '';
  }
  if (connection.db_type === 'sqlite') {
    return connection.database;
  }
  const candidate = rawValue.trim();
  return candidate || connection.database || '';
};

const getConnectionName = (connectionId: string) =>
  supportedConnections.value.find((connection) => connection.id === connectionId)?.name || connectionId;

const getDisplayDatabaseName = (connection: DbConnection | null, databaseName: string) => {
  if (!connection) {
    return databaseName || '-';
  }
  return resolveDatabaseName(connection, databaseName) || '-';
};

const getDisplayDatabaseNameByPlan = (plan: BackupPlan) =>
  getDisplayDatabaseName(
    supportedConnections.value.find((connection) => connection.id === plan.connectionId) || null,
    plan.databaseName
  );

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

const formatBytes = (value: number) => {
  const bytes = Number(value) || 0;
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 100 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
};

const activeStoragePath = computed(() => {
  const candidate = planForm.exportPath.trim() || manualBackupForm.exportPath.trim();
  return candidate || '';
});

const refreshStorageInfo = async (path?: string) => {
  if (!isTauriRuntime) {
    return;
  }

  storageInfoLoading.value = true;
  storageInfoError.value = '';
  try {
    storageInfo.value = await DbmApi.getBackupStorageInfo(path || undefined);
  } catch (error) {
    storageInfo.value = null;
    storageInfoError.value = extractDbmErrorMessage(error, t('messages.loadStorageFailed'));
  } finally {
    storageInfoLoading.value = false;
  }
};

const scheduleRefreshStorageInfo = () => {
  if (!isTauriRuntime || !dialogVisible.value) {
    return;
  }
  if (storageInfoDebounceTimer) {
    clearTimeout(storageInfoDebounceTimer);
  }
  storageInfoDebounceTimer = window.setTimeout(() => {
    void refreshStorageInfo(activeStoragePath.value);
  }, 220);
};

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

const formatPlanSchedule = (plan: BackupPlan) =>
  plan.scheduleType === 'daily'
    ? t('plans.scheduleLabel.daily', { time: plan.dailyTime || '02:00' })
    : t('plans.scheduleLabel.interval', { hours: plan.intervalHours || 24 });

const getPlanStatusLabel = (plan: BackupPlan) => {
  if (!plan.enabled) {
    return t('plans.status.disabled');
  }
  if (plan.lastRunStatus === 'Failed') {
    return t('plans.status.lastFailed');
  }
  if (plan.lastRunStatus === 'Running' || plan.lastRunStatus === 'Pending') {
    return t('plans.status.running');
  }
  if (plan.lastRunStatus === 'Completed') {
    return t('plans.status.lastSuccess');
  }
  return t('plans.status.pending');
};

const getPlanStatusTag = (plan: BackupPlan) => {
  if (!plan.enabled) {
    return 'info';
  }
  if (plan.lastRunStatus === 'Failed') {
    return 'danger';
  }
  if (plan.lastRunStatus === 'Running' || plan.lastRunStatus === 'Pending') {
    return 'warning';
  }
  if (plan.lastRunStatus === 'Completed') {
    return 'success';
  }
  return 'primary';
};

const applyPreferredSelection = () => {
  const preferredConnectionId =
    (props.preferredConnectionId && supportedConnections.value.some((item) => item.id === props.preferredConnectionId)
      ? props.preferredConnectionId
      : supportedConnections.value[0]?.id) || '';
  const preferredConnection =
    supportedConnections.value.find((item) => item.id === preferredConnectionId) || null;
  const preferredDatabaseName =
    props.preferredDatabaseName || preferredConnection?.database || '';

  if (preferredConnectionId) {
    if (!manualBackupForm.connectionId) {
      manualBackupForm.connectionId = preferredConnectionId;
    }
    if (!restoreForm.connectionId) {
      restoreForm.connectionId = preferredConnectionId;
    }
    if (!planForm.connectionId) {
      planForm.connectionId = preferredConnectionId;
    }
  }

  if (preferredDatabaseName) {
    if (!manualBackupForm.databaseName) {
      manualBackupForm.databaseName = preferredDatabaseName;
    }
    if (!restoreForm.databaseName) {
      restoreForm.databaseName = preferredDatabaseName;
    }
    if (!planForm.databaseName) {
      planForm.databaseName = preferredDatabaseName;
    }
  }
};

const loadState = async () => {
  if (!isTauriRuntime) {
    return;
  }

  try {
    const raw = await DbmApi.getBackupPlans();
    plans.value = raw.map(normalizePlan).filter((item): item is BackupPlan => !!item && !!item.id && !!item.connectionId);
  } catch (error) {
    console.error('加载备份中心状态失败:', error);
  }
};

const saveState = async () => {
  if (!isTauriRuntime) {
    return;
  }

  try {
    const nextPlans = await DbmApi.saveBackupPlans(plans.value);
    plans.value = nextPlans.map(normalizePlan).filter((item): item is BackupPlan => !!item && !!item.id && !!item.connectionId);
  } catch (error) {
    console.error('保存备份中心状态失败:', error);
  }
};

const loadConnections = async () => {
  const result = await DbmApi.getConnections();
  connections.value = result;
  applyPreferredSelection();
};

const syncPlanStatusesWithTasks = async () => {
  let changed = false;
  const taskMap = new Map(tasks.value.map((task) => [task.id, task]));

  plans.value = plans.value.map((plan) => {
    if (!plan.lastTaskId) {
      return plan;
    }
    const task = taskMap.get(plan.lastTaskId);
    if (!task) {
      return plan;
    }

    const nextPlan = { ...plan };
    if (nextPlan.lastRunStatus !== task.status) {
      nextPlan.lastRunStatus = task.status;
      changed = true;
    }
    if (task.status === 'Completed' && nextPlan.lastSuccessAt !== task.updated_at) {
      nextPlan.lastSuccessAt = task.updated_at;
      nextPlan.lastErrorMessage = null;
      changed = true;
    }
    if (task.status === 'Failed' && nextPlan.lastErrorMessage !== (task.error_message || null)) {
      nextPlan.lastErrorMessage = task.error_message || null;
      changed = true;
    }
    return nextPlan;
  });

  if (changed) {
    await saveState();
  }
};

const refreshTasks = async () => {
  const response = await invoke<BackupTask[]>('get_all_tasks');
  tasks.value = response.map((task) => ({
    ...task,
    progress: roundProgress(task.progress),
    metadata: task.metadata || {}
  }));
  await syncPlanStatusesWithTasks();
};

const refreshAll = async () => {
  refreshing.value = true;
  try {
    await Promise.all([loadConnections(), refreshTasks(), refreshStorageInfo(activeStoragePath.value)]);
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.refreshFailed')));
  } finally {
    refreshing.value = false;
  }
};

const selectManualBackupDirectory = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: manualBackupForm.exportPath || undefined
  });
  if (selected) {
    manualBackupForm.exportPath = Array.isArray(selected) ? selected[0] : selected;
  }
};

const selectPlanDirectory = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: planForm.exportPath || undefined
  });
  if (selected) {
    planForm.exportPath = Array.isArray(selected) ? selected[0] : selected;
  }
};

const selectRestoreFile = async () => {
  const selected = await open({
    filters: [{ name: t('filters.sqlFiles'), extensions: ['sql'] }],
    multiple: false,
    defaultPath: restoreForm.backupPath || undefined
  });
  if (selected) {
    restoreForm.backupPath = Array.isArray(selected) ? selected[0] : selected;
  }
};

const triggerBackupTask = async (
  payload: { connectionId: string; databaseName: string; exportPath: string }
) => {
  const connection = supportedConnections.value.find((item) => item.id === payload.connectionId) || null;
  if (!connection) {
    throw new Error(t('messages.connectionMissing'));
  }

  const databaseName = resolveDatabaseName(connection, payload.databaseName);
  if (!databaseName) {
    throw new Error(t('messages.databaseRequired'));
  }

  const tables = await DbmApi.getTables(connection.id, databaseName);
  if (!tables.length) {
    throw new Error(t('messages.noTablesToBackup'));
  }

  const taskId = await DbmApi.backupDatabase(
    connection.id,
    databaseName,
    tables,
    payload.exportPath || undefined
  );

  await refreshTasks();
  ElMessage.success(t('messages.backupStarted', { taskId }));
};

const startManualBackup = async () => {
  manualBackupRunning.value = true;
  try {
    await triggerBackupTask({
      connectionId: manualBackupForm.connectionId,
      databaseName: manualBackupForm.databaseName,
      exportPath: manualBackupForm.exportPath
    });
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.startBackupFailed')));
  } finally {
    manualBackupRunning.value = false;
  }
};

const startRestore = async () => {
  restoreRunning.value = true;
  try {
    const connection = restoreConnection.value;
    if (!connection) {
      throw new Error(t('messages.selectTargetConnection'));
    }
    if (!restoreForm.backupPath) {
      throw new Error(t('messages.selectBackupFile'));
    }
    const databaseName = resolveDatabaseName(connection, restoreForm.databaseName);
    if (!databaseName) {
      throw new Error(t('messages.targetDatabaseRequired'));
    }

    const taskId = await DbmApi.restoreDatabaseFromBackup(
      connection.id,
      databaseName,
      restoreForm.backupPath
    );
    await refreshTasks();
    ElMessage.success(t('messages.restoreStarted', { taskId }));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.startRestoreFailed')));
  } finally {
    restoreRunning.value = false;
  }
};

const createEmptyPlanForm = async () => ({
  name: '',
  connectionId: props.preferredConnectionId || supportedConnections.value[0]?.id || '',
  databaseName: props.preferredDatabaseName || supportedConnections.value[0]?.database || '',
  exportPath: await buildDefaultBackupDirectory('schedule'),
  scheduleType: 'daily' as BackupPlan['scheduleType'],
  dailyTime: '02:00',
  intervalHours: 24,
  enabled: true,
  retentionDays: 20
});

const resetPlanForm = async () => {
  editingPlanId.value = '';
  const defaults = await createEmptyPlanForm();
  Object.assign(planForm, defaults);
};

const savePlan = async () => {
  const wasEditing = !!editingPlanId.value;
  const connection = planConnection.value;
  if (!connection) {
    ElMessage.warning(t('messages.selectBackupConnection'));
    return;
  }
  const databaseName = resolveDatabaseName(connection, planForm.databaseName);
  if (!databaseName) {
    ElMessage.warning(t('messages.databaseRequired'));
    return;
  }
  if (!planForm.exportPath.trim()) {
    ElMessage.warning(t('messages.selectBackupDirectory'));
    return;
  }

  const payload: BackupPlan = {
    id: editingPlanId.value || `backup-plan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: planForm.name.trim() || t('plans.defaultName', { connectionName: connection.name, databaseName }),
    connectionId: connection.id,
    databaseName,
    exportPath: planForm.exportPath.trim(),
    scheduleType: planForm.scheduleType,
    dailyTime: planForm.dailyTime || '02:00',
    intervalHours: Math.max(1, Number(planForm.intervalHours) || 24),
    enabled: !!planForm.enabled,
    retentionDays: Math.max(0, Math.round(Number(planForm.retentionDays) || 0)),
    createdAt: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
    lastTriggeredAt: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.lastTriggeredAt || null)
      : null,
    lastTaskId: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.lastTaskId || null)
      : null,
    lastRunStatus: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.lastRunStatus || null)
      : null,
    lastSuccessAt: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.lastSuccessAt || null)
      : null,
    lastErrorMessage: editingPlanId.value
      ? (plans.value.find((item) => item.id === editingPlanId.value)?.lastErrorMessage || null)
      : null
  };

  const nextPlans = plans.value.filter((item) => item.id !== payload.id);
  nextPlans.unshift(payload);
  plans.value = nextPlans;
  await saveState();
  await resetPlanForm();
  ElMessage.success(wasEditing ? t('messages.planSaved') : t('messages.planAdded'));
};

const editPlan = (plan: BackupPlan) => {
  editingPlanId.value = plan.id;
  Object.assign(planForm, {
    name: plan.name,
    connectionId: plan.connectionId,
    databaseName: plan.databaseName,
    exportPath: plan.exportPath,
    scheduleType: plan.scheduleType,
    dailyTime: plan.dailyTime,
    intervalHours: plan.intervalHours,
    enabled: plan.enabled,
    retentionDays: Math.max(0, Math.round(Number(plan.retentionDays) || 0))
  });
};

const removePlan = async (plan: BackupPlan) => {
  try {
    await ElMessageBox.confirm(t('messages.removePlanConfirm', { name: plan.name }), t('messages.removePlanTitle'), {
      type: 'warning',
      confirmButtonText: t('buttons.delete'),
      cancelButtonText: t('buttons.cancel')
    });
    plans.value = plans.value.filter((item) => item.id !== plan.id);
    await saveState();
    if (editingPlanId.value === plan.id) {
      await resetPlanForm();
    }
    ElMessage.success(t('messages.planDeleted'));
  } catch {
    // ignore cancel
  }
};

const handlePlanToggle = async () => {
  await saveState();
};

const runPlanNow = async (plan: BackupPlan) => {
  try {
    const taskId = await DbmApi.triggerBackupPlan(plan.id);
    await refreshAll();
    ElMessage.success(t('messages.planTriggered', { taskId }));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.runPlanFailed')));
  }
};

const retryTask = async (taskId: string) => {
  try {
    const newTaskId = await invoke<string>('retry_task', { taskId });
    await refreshTasks();
    ElMessage.success(t('messages.taskRetried', { taskId: newTaskId }));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.retryTaskFailed')));
  }
};

const openDirectory = async (filePath: string) => {
  try {
    await openHostFsWindow(filePath);
    ElMessage.success(t('messages.openDirectoryStarted'));
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.openDirectoryFailed')));
  }
};

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      void refreshAll();
    }
  }
);

watch(
  () => [dialogVisible.value, activeStoragePath.value],
  ([visible]) => {
    if (!visible) {
      return;
    }
    scheduleRefreshStorageInfo();
  },
  { immediate: true }
);

watch(
  () => [props.preferredConnectionId, props.preferredDatabaseName, supportedConnections.value.length],
  () => {
    applyPreferredSelection();
  },
  { immediate: true }
);

watch(
  () => manualBackupForm.connectionId,
  async (connectionId) => {
    const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;
    if (!connection) {
      return;
    }
    manualBackupForm.databaseName = resolveDatabaseName(connection, manualBackupForm.databaseName);
    if (!manualBackupForm.exportPath) {
      manualBackupForm.exportPath = await buildDefaultBackupDirectory('manual');
    }
  },
  { immediate: true }
);

watch(
  () => restoreForm.connectionId,
  (connectionId) => {
    const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;
    if (!connection) {
      return;
    }
    restoreForm.databaseName = resolveDatabaseName(connection, restoreForm.databaseName);
  },
  { immediate: true }
);

watch(
  () => planForm.connectionId,
  (connectionId) => {
    const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;
    if (!connection) {
      return;
    }
    planForm.databaseName = resolveDatabaseName(connection, planForm.databaseName);
  },
  { immediate: true }
);

onMounted(async () => {
  if (isTauriRuntime) {
    await Promise.all([loadState(), loadConnections(), refreshTasks()]);
    await resetPlanForm();
  } else {
    await resetPlanForm();
  }

  if (isTauriRuntime) {
    taskListener = await listen('task-updated', () => {
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
      }
      refreshDebounceTimer = window.setTimeout(() => {
        void refreshTasks();
      }, 250);
    });

    backupPlansListener = await listen<BackupPlan[]>(BACKUP_PLANS_UPDATED_EVENT, (event) => {
      const payload = Array.isArray(event.payload) ? event.payload : [];
      plans.value = payload
        .map(normalizePlan)
        .filter((item): item is BackupPlan => !!item && !!item.id && !!item.connectionId);
    });
  }
});

onUnmounted(() => {
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = null;
  }
  if (taskListener) {
    taskListener();
    taskListener = null;
  }
  if (backupPlansListener) {
    backupPlansListener();
    backupPlansListener = null;
  }
  if (storageInfoDebounceTimer) {
    clearTimeout(storageInfoDebounceTimer);
    storageInfoDebounceTimer = null;
  }
});
</script>

<style scoped>
:deep(.backup-center-dialog) {
  max-width: 1160px;
  height: 90vh;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

:deep(.backup-center-dialog .el-dialog__header) {
  flex: 0 0 auto;
}

:deep(.backup-center-dialog .el-dialog__body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.backup-center {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  min-height: 0;
}

.summary-bar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.summary-left,
.summary-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.summary-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.storage-hint {
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--el-color-primary-light-9) 26%, var(--el-bg-color) 74%);
}

.storage-hint-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 6px;
}

.storage-hint-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.storage-hint-row {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  word-break: break-all;
}

.storage-hint-empty,
.storage-hint-error {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.storage-hint-error {
  color: var(--el-color-danger);
}

.empty-holder {
  min-height: min(540px, 58vh);
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.action-card,
.section-card {
  border-radius: 14px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.card-subtitle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.path-picker {
  display: flex;
  gap: 8px;
  width: 100%;
}

.card-actions {
  display: flex;
  justify-content: flex-end;
}

.plan-form-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.plan-form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plan-form-item label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.form-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.plan-form-item-wide {
  grid-column: span 2;
}

.plan-actions {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.plan-actions-right,
.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.row-secondary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.mt-12px {
  margin-top: 12px;
}

@media (max-width: 1100px) {
  .action-grid {
    grid-template-columns: 1fr;
  }

  .plan-form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .plan-form-item-wide {
    grid-column: span 2;
  }
}

@media (max-width: 720px) {
  .backup-center {
    height: 100%;
  }

  .plan-form-grid {
    grid-template-columns: 1fr;
  }

  .plan-form-item-wide {
    grid-column: span 1;
  }

  .path-picker {
    flex-direction: column;
  }
}
</style>
