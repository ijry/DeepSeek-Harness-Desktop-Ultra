<template>
  <el-dialog
    v-model="dialogVisible"
    class="ai-dashboard-dialog"
    :title="t('title')"
    width="96vw"
  >
    <div
      ref="dashboardLayoutRef"
      class="ai-dashboard-root"
      :class="{ 'panel-collapsed': sidePanelCollapsed }"
      :style="{ '--dashboard-side-width': `${sidePanelWidth}px` }"
    >
      <div class="preview-pane">
        <div class="preview-toolbar">
          <div class="preview-title">
            <span>{{ t('workspace.title') }}</span>
            <el-tag size="small" :type="previewStatusTag">
              {{ previewStatusText }}
            </el-tag>
          </div>
          <div class="preview-actions">
            <div class="context-bar">
              <div class="context-field context-field--target">
                <el-cascader
                  v-model="dashboardTargetValue"
                  class="w-full"
                  size="small"
                  filterable
                  :options="dashboardTargetOptions"
                  :props="dashboardTargetProps"
                  :placeholder="t('workspace.targetPlaceholder')"
                />
              </div>
            </div>
            <el-button size="small" @click="resetToDefault">{{ t('workspace.resetExample') }}</el-button>
            <el-button size="small" @click="renderPreviewNow">{{ t('workspace.rerender') }}</el-button>
          </div>
        </div>

        <div class="workspace-body">
          <el-tabs v-model="activeWorkspaceTab" class="workspace-tabs">
            <el-tab-pane :label="t('workspace.tabs.preview')" name="preview">
              <div class="workspace-panel workspace-panel-preview">
                <iframe
                  ref="previewFrameRef"
                  class="preview-frame"
                  sandbox="allow-scripts allow-same-origin"
                  :title="t('workspace.previewFrameTitle')"
                />
              </div>
            </el-tab-pane>
            <el-tab-pane :label="t('workspace.tabs.code')" name="code">
              <el-scrollbar class="workspace-code-scroll">
                <pre>{{ generatedCode }}</pre>
              </el-scrollbar>
            </el-tab-pane>
          </el-tabs>
        </div>
      </div>

      <div class="side-rail">
        <SplitResizeHandle
          v-show="!sidePanelCollapsed"
          class="dashboard-side-resize-handle"
          :dragging="sidePanelResizing"
          @pointerdown="startSidePanelResize"
        />

        <button
          class="collapse-toggle"
          type="button"
          @click="toggleSidePanel"
        >
          {{ sidePanelCollapsed ? '<<' : '>>' }}
        </button>
      </div>

      <aside class="side-pane" v-show="!sidePanelCollapsed">
        <div class="side-header">
          <span>{{ t('side.title') }}</span>
          <el-tag size="small" type="info">Dashboard.vue</el-tag>
        </div>

        <div class="schema-panel">
          <div class="schema-panel-header">
            <span>{{ t('schema.title') }}</span>
            <el-tag size="small" :type="schemaError ? 'danger' : 'success'">
              {{ schemaPanelStatus }}
            </el-tag>
          </div>
          <div class="schema-panel-body">
            <div class="schema-panel-main">
              <span>{{ schemaSummaryBaseText }}</span>
              <template v-if="schemaLoadedAtText">
                <span class="schema-panel-loaded-at">{{ schemaLoadedAtText }}</span>
                <el-link
                  size="small"
                  class="schema-panel-refresh-text text-12px cursor-pointer"
                  :loading="schemaLoading"
                  @click="refreshSchema(true, true)"
                >
                  {{ t('schema.reanalyze') }}
                </el-link>
              </template>
            </div>
          </div>
        </div>

        <AiChatPanel
          class="dashboard-ai-chat"
          v-model:messages="messages"
          v-model:input-value="promptInput"
          :chat-prefix="dashboardChatPrefix"
          :initial-messages="initialDashboardMessages"
          theme="dashboard"
          :loading="generating"
          :error-text="generationError"
          :submit-disabled="!canGenerate"
          :placeholder="t('chat.placeholder')"
          :hint-text="t('chat.hint')"
          :submit-button-text="t('chat.submit')"
          :empty-description="t('chat.empty')"
          @submit="submitDashboardPrompt"
        >
          <template #actions>
            <el-button size="small" :loading="fixingCode" :disabled="!generatedCode.trim()" @click="repairDashboardCode">
              {{ t('chat.repair') }}
            </el-button>
          </template>
        </AiChatPanel>
      </aside>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { invoke } from '@tauri-apps/api/core';
import AiChatPanel from '@/platform/ui/common/ai/AiChatPanel.vue';
import SplitResizeHandle from '@/platform/ui/common/SplitResizeHandle.vue';
import { useDragResize } from '@/platform/ui/common/useDragResize';
import {
  DbmApi,
  extractDbmErrorMessage,
  type DbConnection,
  type QueryResult,
  type TableStruct
} from './service';
import { createAiChatMessage, type AiChatMessage } from '@/utils/ai';
import { useDbSchemaContext } from './useDbSchemaContext';
import { useI18nScope } from '@/platform/i18n';

type PreviewStatus = 'idle' | 'loading' | 'success' | 'error';

interface PreviewHostRequestMessage {
  type: 'dbm-ai-dashboard-host-request';
  requestId?: string;
  method?: string;
  payload?: Record<string, unknown>;
}

interface DashboardTargetOption {
  value: string;
  label: string;
  leaf?: boolean;
  children?: DashboardTargetOption[];
}

const MAX_SCHEMA_PROMPT_CHARS = 48000;
const DASHBOARD_SIDE_WIDTH_STORAGE_KEY = 'dbm-ai-dashboard-side-width';
const DASHBOARD_SIDE_WIDTH_DEFAULT = 300;
const DASHBOARD_SIDE_WIDTH_MIN = 220;
const DASHBOARD_PREVIEW_MIN_WIDTH = 420;
const { t } = useI18nScope('dbm.aiDashboard');

const props = defineProps<{
  modelValue: boolean;
  preferredConnectionId?: string;
  preferredDatabaseName?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const buildDefaultDashboardCode = () => `<template>
  <div class="screen-root">
    <header class="screen-header">
      <div>
        <h1>${t('defaultCode.title')}</h1>
        <p>{{ subtitle }}</p>
      </div>
      <div class="header-meta">
        <span>{{ nowText }}</span>
        <span>{{ context.databaseName || ${JSON.stringify(t('defaultCode.unselectedDatabase'))} }}</span>
      </div>
    </header>

    <section class="state-bar" v-if="loading || errorText">
      <span v-if="loading">${t('defaultCode.loading')}</span>
      <span v-else>{{ errorText }}</span>
    </section>

    <section class="kpi-grid">
      <article class="kpi-card" v-for="item in kpis" :key="item.label">
        <h3>{{ item.label }}</h3>
        <strong>{{ item.value }}</strong>
        <small>{{ item.hint }}</small>
      </article>
    </section>

    <section class="chart-grid">
      <div ref="tableChartRef" class="chart-card"></div>
      <div ref="schemaChartRef" class="chart-card"></div>
    </section>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as echarts from 'echarts';

const dashboard = window.__dbmDashboard;
const context = dashboard?.getContext?.() || {};
const tableChartRef = ref(null);
const schemaChartRef = ref(null);
const loading = ref(false);
const errorText = ref('');
const nowText = ref('');
const subtitle = ref(${JSON.stringify(t('defaultCode.subtitle'))});
const kpis = ref([
  { label: ${JSON.stringify(t('defaultCode.kpis.tableCount.label'))}, value: '--', hint: ${JSON.stringify(t('defaultCode.kpis.tableCount.hint'))} },
  { label: ${JSON.stringify(t('defaultCode.kpis.columnCount.label'))}, value: '--', hint: ${JSON.stringify(t('defaultCode.kpis.columnCount.hint'))} },
  { label: ${JSON.stringify(t('defaultCode.kpis.primaryKeyTables.label'))}, value: '--', hint: ${JSON.stringify(t('defaultCode.kpis.primaryKeyTables.hint'))} },
  { label: ${JSON.stringify(t('defaultCode.kpis.foreignKeyRelations.label'))}, value: '--', hint: ${JSON.stringify(t('defaultCode.kpis.foreignKeyRelations.hint'))} }
]);

let timer = null;
let tableChart = null;
let schemaChart = null;

const updateClock = () => {
  nowText.value = new Date().toLocaleString();
};

const renderCharts = (tableRows, relationRows) => {
  tableChart && tableChart.dispose();
  schemaChart && schemaChart.dispose();

  tableChart = echarts.init(tableChartRef.value);
  tableChart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 46, right: 18, top: 42, bottom: 36 },
    xAxis: {
      type: 'category',
      data: tableRows.map((item) => item.name),
      axisLabel: { color: '#c7deef', rotate: 18 }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#9fc0d6' },
      splitLine: { lineStyle: { color: 'rgba(148, 196, 230, .15)' } }
    },
    series: [{
      type: 'bar',
      name: ${JSON.stringify(t('defaultCode.charts.columnCountSeries'))},
      data: tableRows.map((item) => item.value),
      itemStyle: {
        color: '#24c0ff',
        borderRadius: [8, 8, 0, 0]
      }
    }]
  });

  schemaChart = echarts.init(schemaChartRef.value);
  schemaChart.setOption({
    tooltip: { trigger: 'item' },
    legend: {
      bottom: 0,
      textStyle: { color: '#d6ebf8' }
    },
    series: [{
      type: 'pie',
      radius: ['38%', '64%'],
      data: relationRows
    }]
  });
};

const loadData = async () => {
  loading.value = true;
  errorText.value = '';

  try {
    const tables = Array.isArray(context.tables) ? context.tables : [];
    const tableMetrics = tables
      .map((table) => ({
        name: table.tableName,
        value: Array.isArray(table.columns) ? table.columns.length : 0
      }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 8);

    const relationMetrics = [
      {
        value: tables.filter((table) => Array.isArray(table.primaryKeys) && table.primaryKeys.length).length,
        name: ${JSON.stringify(t('defaultCode.relations.primaryKeyTables'))}
      },
      {
        value: tables.reduce((sum, table) => sum + ((table.foreignKeys || []).length || 0), 0),
        name: ${JSON.stringify(t('defaultCode.relations.foreignKeyRelations'))}
      },
      {
        value: tables.reduce((sum, table) => sum + ((table.indexes || []).length || 0), 0),
        name: ${JSON.stringify(t('defaultCode.relations.indexDefinitions'))}
      }
    ];

    if (dashboard?.query) {
      const sampled = await dashboard.query('SELECT CURRENT_TIMESTAMP AS sampled_at, 1 AS available');
      const row = dashboard.first(sampled) || {};
      subtitle.value = ${JSON.stringify(t('defaultCode.queryBridgeReady'))};
      if (row.sampled_at) {
        nowText.value = String(row.sampled_at);
      }
    }

    const totalColumns = tables.reduce((sum, table) => sum + ((table.columns || []).length || 0), 0);
    kpis.value = [
      { label: ${JSON.stringify(t('defaultCode.kpis.tableCount.label'))}, value: String(tables.length || 0), hint: context.databaseName || ${JSON.stringify(t('defaultCode.kpis.tableCount.hint'))} },
      { label: ${JSON.stringify(t('defaultCode.kpis.columnCount.label'))}, value: String(totalColumns), hint: ${JSON.stringify(t('defaultCode.kpis.columnCount.hint'))} },
      {
        label: ${JSON.stringify(t('defaultCode.kpis.primaryKeyTables.label'))},
        value: String(relationMetrics[0].value || 0),
        hint: ${JSON.stringify(t('defaultCode.kpis.primaryKeyTables.hint'))}
      },
      {
        label: ${JSON.stringify(t('defaultCode.kpis.foreignKeyRelations.label'))},
        value: String(relationMetrics[1].value || 0),
        hint: ${JSON.stringify(t('defaultCode.kpis.foreignKeyRelations.runtimeHint'))}
      }
    ];

    renderCharts(
      tableMetrics.length ? tableMetrics : [{ name: ${JSON.stringify(t('defaultCode.noTables'))}, value: 0 }],
      relationMetrics
    );
  } catch (error) {
    errorText.value = String(error && error.message ? error.message : error);
  } finally {
    loading.value = false;
  }
};

const resizeCharts = () => {
  tableChart && tableChart.resize();
  schemaChart && schemaChart.resize();
};

onMounted(() => {
  updateClock();
  timer = setInterval(updateClock, 1000);
  loadData();
  window.addEventListener('resize', resizeCharts);
});

onBeforeUnmount(() => {
  timer && clearInterval(timer);
  window.removeEventListener('resize', resizeCharts);
  tableChart && tableChart.dispose();
  schemaChart && schemaChart.dispose();
});
<\/script>

<style scoped>
.screen-root {
  min-height: 100vh;
  padding: 20px;
  color: #e6f4ff;
  background:
    radial-gradient(circle at 18% 0%, rgba(36, 192, 255, .18), transparent 32%),
    radial-gradient(circle at 100% 10%, rgba(23, 211, 153, .16), transparent 28%),
    linear-gradient(135deg, #07131c 0%, #0d2434 46%, #10293c 100%);
}

.screen-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-end;
}

.screen-header h1 {
  margin: 0;
  font-size: 30px;
  letter-spacing: 1px;
}

.screen-header p {
  margin: 8px 0 0;
  color: #9fc4dd;
}

.header-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-end;
  color: #b7d6ea;
  font-size: 13px;
}

.state-bar {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  color: #ffd7d7;
  background: rgba(229, 80, 80, .12);
  border: 1px solid rgba(229, 80, 80, .24);
}

.kpi-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.kpi-card {
  padding: 16px;
  border-radius: 14px;
  border: 1px solid rgba(166, 214, 242, .2);
  background: rgba(7, 28, 40, .62);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04);
}

.kpi-card h3 {
  margin: 0;
  font-size: 13px;
  color: #9bc5de;
}

.kpi-card strong {
  display: block;
  margin-top: 10px;
  font-size: 28px;
}

.kpi-card small {
  display: block;
  margin-top: 8px;
  color: #7faac4;
}

.chart-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 14px;
}

.chart-card {
  min-height: 340px;
  border-radius: 14px;
  border: 1px solid rgba(166, 214, 242, .18);
  background: rgba(4, 22, 34, .55);
}

@media (max-width: 960px) {
  .screen-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .header-meta {
    align-items: flex-start;
  }

  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
`;

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});

const readDashboardSideWidth = () => {
  if (typeof window === 'undefined') {
    return DASHBOARD_SIDE_WIDTH_DEFAULT;
  }

  const raw = Number(window.localStorage.getItem(DASHBOARD_SIDE_WIDTH_STORAGE_KEY));
  return Number.isFinite(raw) ? raw : DASHBOARD_SIDE_WIDTH_DEFAULT;
};

const previewFrameRef = ref<HTMLIFrameElement | null>(null);
const dashboardLayoutRef = ref<HTMLElement | null>(null);
const sidePanelCollapsed = ref(false);
const sidePanelWidth = ref(readDashboardSideWidth());
const activeWorkspaceTab = ref<'preview' | 'code'>('preview');
const previewStatus = ref<PreviewStatus>('idle');
const previewStatusText = ref(t('status.waiting'));
const generatedCode = ref(buildDefaultDashboardCode());
const promptInput = ref(t('chat.defaultPrompt'));
const generating = ref(false);
const fixingCode = ref(false);
const generationError = ref('');
const initialDashboardMessages = [
  createAiChatMessage(
    'assistant',
    t('chat.initialAssistantMessage')
  )
];
const messages = ref<AiChatMessage[]>([...initialDashboardMessages]);

const connections = ref<DbConnection[]>([]);
const selectedConnectionId = ref('');
const selectedDatabaseName = ref('');
const databaseOptionsByConnection = ref<Record<string, string[]>>({});
const previewQueryCount = ref(0);
const previewRuntimeError = ref('');

let previewMountToken = 0;
let isInitializingDialog = false;
let lastSchemaAnnouncementKey = '';

const supportedConnections = computed(() =>
  connections.value.filter((connection) =>
    ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(connection.db_type)
  )
);

const currentConnection = computed(() =>
  supportedConnections.value.find((connection) => connection.id === selectedConnectionId.value) || null
);

const buildDatabaseChildren = (databaseNames: string[]) =>
  databaseNames.map((databaseName) => ({
    value: databaseName,
    label: databaseName,
    leaf: true,
  }));

const cacheDatabaseOptions = (connectionId: string, databaseNames: string[]) => {
  const normalized = Array.from(new Set(databaseNames.filter((name) => !!name)));
  databaseOptionsByConnection.value = {
    ...databaseOptionsByConnection.value,
    [connectionId]: normalized,
  };
  return normalized;
};

const loadDatabaseOptionsForConnection = async (connectionId: string, force = false) => {
  const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;
  if (!connection) {
    return [];
  }

  if (connection.db_type === 'sqlite') {
    return cacheDatabaseOptions(connectionId, connection.database ? [connection.database] : []);
  }

  if (!force && databaseOptionsByConnection.value[connectionId]?.length) {
    return databaseOptionsByConnection.value[connectionId];
  }

  try {
    const databases = await DbmApi.getDatabases(connectionId);
    return cacheDatabaseOptions(
      connectionId,
      Array.from(new Set([...(databases || []), connection.database].filter((name) => !!name)))
    );
  } catch (error) {
    console.error('加载数据库列表失败:', error);
    return cacheDatabaseOptions(connectionId, connection.database ? [connection.database] : []);
  }
};

const resolvedDatabaseName = computed(() => {
  const connection = currentConnection.value;
  if (!connection) {
    return '';
  }
  if (connection.db_type === 'sqlite') {
    return connection.database || '';
  }
  return selectedDatabaseName.value.trim() || connection.database || '';
});

const dashboardTargetValue = computed<string[]>({
  get: () => {
    if (!selectedConnectionId.value || !resolvedDatabaseName.value) {
      return [];
    }
    return [selectedConnectionId.value, resolvedDatabaseName.value];
  },
  set: (value) => {
    if (!Array.isArray(value) || value.length < 2) {
      return;
    }

    const [connectionId, databaseName] = value;
    const nextConnectionId = String(connectionId || '');
    const connection = supportedConnections.value.find((item) => item.id === nextConnectionId) || null;

    selectedConnectionId.value = nextConnectionId;
    selectedDatabaseName.value = connection?.db_type === 'sqlite'
      ? (connection.database || String(databaseName || ''))
      : String(databaseName || '');
  },
});

const dashboardTargetOptions = computed<DashboardTargetOption[]>(() =>
  supportedConnections.value.map((connection) => ({
    value: connection.id,
    label: connection.name,
    leaf: false,
    children: connection.db_type === 'sqlite'
      ? buildDatabaseChildren(connection.database ? [connection.database] : [])
      : (databaseOptionsByConnection.value[connection.id]?.length
        ? buildDatabaseChildren(databaseOptionsByConnection.value[connection.id])
        : undefined),
  }))
);

const dashboardTargetProps = {
  value: 'value',
  label: 'label',
  children: 'children',
  leaf: 'leaf',
  emitPath: true,
  lazy: true,
  lazyLoad: (node: { data?: DashboardTargetOption; value?: string }, resolve: (data: DashboardTargetOption[]) => void) => {
    const connectionId = String(node.data?.value || node.value || '');
    if (!connectionId) {
      resolve([]);
      return;
    }

    void loadDatabaseOptionsForConnection(connectionId)
      .then((databaseNames) => {
        resolve(buildDatabaseChildren(databaseNames));
      })
      .catch(() => {
        resolve([]);
      });
  },
};

const {
  tableStructs,
  schemaLoading,
  schemaError,
  schemaLoadedAt,
  ensureSchemaLoaded,
} = useDbSchemaContext({
  connectionId: selectedConnectionId,
  databaseName: resolvedDatabaseName,
  errorFallback: t('messages.loadSchemaCacheFailed'),
});

const dashboardChatPrefix = computed(
  () => `dbm-dashboard-${selectedConnectionId.value || 'none'}-${resolvedDatabaseName.value || 'default'}`
);

const canGenerate = computed(() =>
  !!selectedConnectionId.value
  && !!resolvedDatabaseName.value
  && !!promptInput.value.trim()
  && !!tableStructs.value.length
  && !schemaLoading.value
);

const previewStatusTag = computed(() => {
  switch (previewStatus.value) {
    case 'loading':
      return 'warning';
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
});

const getDashboardSideMaxWidth = () => {
  const layoutWidth = dashboardLayoutRef.value?.clientWidth ?? window.innerWidth ?? 0;
  return Math.max(
    DASHBOARD_SIDE_WIDTH_MIN,
    Math.round(layoutWidth - DASHBOARD_PREVIEW_MIN_WIDTH)
  );
};

const clampDashboardSideWidth = (value: number) =>
  Math.min(
    Math.max(Math.round(value), DASHBOARD_SIDE_WIDTH_MIN),
    getDashboardSideMaxWidth()
  );

const syncDashboardSideWidth = (value: number) => {
  sidePanelWidth.value = clampDashboardSideWidth(value);
};

const handleDashboardWindowResize = () => {
  syncDashboardSideWidth(sidePanelWidth.value);
};

const { dragging: sidePanelResizing, startDragging: startSidePanelResize } = useDragResize({
  axis: 'x',
  min: DASHBOARD_SIDE_WIDTH_MIN,
  max: () => getDashboardSideMaxWidth(),
  getInitialValue: () => sidePanelWidth.value,
  onChange: (value) => {
    syncDashboardSideWidth(value);
  },
  getValueFromPointer: (event, state) => state.startValue - (event.clientX - state.startX),
});

const schemaSummaryBaseText = computed(() => {
  if (!selectedConnectionId.value) {
    return t('schema.selectConnection');
  }
  if (!resolvedDatabaseName.value) {
    return t('schema.selectDatabase');
  }
  if (schemaLoading.value) {
    return t('schema.loading', { databaseName: resolvedDatabaseName.value });
  }
  if (schemaError.value) {
    return schemaError.value;
  }
  if (!tableStructs.value.length) {
    return t('schema.noTables', { databaseName: resolvedDatabaseName.value });
  }

  return t('schema.loaded', {
    databaseName: resolvedDatabaseName.value,
    tableCount: tableStructs.value.length
  });
});

const schemaLoadedAtText = computed(() => {
  if (
    schemaLoading.value
    || !!schemaError.value
    || !tableStructs.value.length
    || !schemaLoadedAt.value
  ) {
    return '';
  }

  return t('schema.loadedAt', { time: formatDateTime(schemaLoadedAt.value) });
});

const schemaSummaryText = computed(() => {
  if (!schemaLoadedAtText.value) {
    return schemaSummaryBaseText.value;
  }

  return `${schemaSummaryBaseText.value} ${schemaLoadedAtText.value}`;
});

const schemaPanelStatus = computed(() => {
  if (schemaLoading.value) {
    return t('schema.status.analyzing');
  }
  if (schemaError.value) {
    return t('schema.status.failed');
  }
  if (tableStructs.value.length) {
    return t('schema.status.ready');
  }
  return t('schema.status.unloaded');
});

const addMessage = (role: 'user' | 'assistant', content: string) => {
  messages.value.push(createAiChatMessage(role, content));
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

const formatTableForPrompt = (table: TableStruct) => {
  const columns = table.columns.map((column) => {
    const descriptors = [];
    if (column.is_primary_key) {
      descriptors.push('PK');
    }
    if (!column.is_nullable) {
      descriptors.push('NOT NULL');
    }
    if (column.default_value !== null && column.default_value !== undefined && column.default_value !== '') {
      descriptors.push(`DEFAULT ${column.default_value}`);
    }
    if (column.column_comment) {
      descriptors.push(t('prompt.labels.commentWithValue', { comment: column.column_comment }));
    }
    return `${column.name} ${column.data_type}${descriptors.length ? ` [${descriptors.join(', ')}]` : ''}`;
  });

  const indexText = table.indexes.length
    ? table.indexes
      .slice(0, 6)
      .map((index) => `${index.name}${index.is_unique ? '(UNIQUE)' : ''}:${index.columns.join('+')}`)
      .join('; ')
    : t('prompt.values.none');

  const foreignKeyText = table.foreign_keys.length
    ? table.foreign_keys
      .slice(0, 6)
      .map((foreignKey) => `${foreignKey.column_name}->${foreignKey.referenced_table}.${foreignKey.referenced_column}`)
      .join('; ')
    : t('prompt.values.none');

  return [
    t('prompt.labels.tableLine', {
      tableName: table.table_name,
      comment: table.comment ? ` (${table.comment})` : '',
    }),
    t('prompt.labels.columnsLine', { columns: columns.join('; ') }),
    t('prompt.labels.primaryKeysLine', {
      primaryKeys: table.primary_keys.length ? table.primary_keys.join(', ') : t('prompt.values.none'),
    }),
    t('prompt.labels.indexesLine', { indexes: indexText }),
    t('prompt.labels.foreignKeysLine', { foreignKeys: foreignKeyText }),
  ].join('\n');
};

const buildSchemaPromptContext = () => {
  const allTableNames = tableStructs.value.map((table) => table.table_name).join(', ');
  const detailBlocks: string[] = [];
  let usedChars = 0;

  tableStructs.value.forEach((table, index) => {
    const block = `${index + 1}. ${formatTableForPrompt(table)}`;
    if (usedChars + block.length > MAX_SCHEMA_PROMPT_CHARS) {
      return;
    }
    detailBlocks.push(block);
    usedChars += block.length;
  });

  const omittedCount = Math.max(tableStructs.value.length - detailBlocks.length, 0);

  return [
    t('prompt.labels.connectionName', { value: currentConnection.value?.name || '-' }),
    t('prompt.labels.databaseType', { value: currentConnection.value?.db_type || '-' }),
    t('prompt.labels.databaseName', { value: resolvedDatabaseName.value || '-' }),
    t('prompt.labels.tableCount', { count: tableStructs.value.length }),
    t('prompt.labels.allTableNames', { value: allTableNames || t('prompt.values.none') }),
    t('prompt.labels.fullStructure'),
    ...detailBlocks,
    omittedCount > 0 ? t('prompt.labels.omittedTables', { count: omittedCount }) : ''
  ]
    .filter(Boolean)
    .join('\n');
};

const buildSqlDialectHint = () => {
  switch (currentConnection.value?.db_type) {
    case 'mysql':
    case 'mariadb':
      return t('prompt.dialect.mysql');
    case 'postgresql':
    case 'kingbasees':
      return t('prompt.dialect.postgresql');
    case 'sqlserver':
      return t('prompt.dialect.sqlserver');
    case 'dameng':
      return t('prompt.dialect.dameng');
    case 'sqlite':
      return t('prompt.dialect.sqlite');
    default:
      return t('prompt.dialect.default');
  }
};

const buildChartSafetyHint = () => t('prompt.chartSafetyHint');

const buildSchemaAnnouncement = () =>
  t('schema.loaded', {
    databaseName: resolvedDatabaseName.value,
    tableCount: tableStructs.value.length,
  });

const applyPreferredSelection = () => {
  const availableConnections = supportedConnections.value;
  const currentSelected = availableConnections.find((item) => item.id === selectedConnectionId.value) || null;
  const preferred = availableConnections.find((item) => item.id === props.preferredConnectionId) || null;
  const nextConnection = currentSelected || preferred || availableConnections[0] || null;

  if (!nextConnection) {
    selectedConnectionId.value = '';
    selectedDatabaseName.value = '';
    return;
  }

  selectedConnectionId.value = nextConnection.id;
  if (nextConnection.db_type === 'sqlite') {
    selectedDatabaseName.value = nextConnection.database || '';
  } else if (!selectedDatabaseName.value) {
    selectedDatabaseName.value = props.preferredDatabaseName || nextConnection.database || '';
  }
};

const loadConnections = async () => {
  connections.value = await DbmApi.getConnections();
  applyPreferredSelection();
};

const loadDatabasesForConnection = async (connectionId: string) => {
  const connection = supportedConnections.value.find((item) => item.id === connectionId) || null;
  if (!connection) {
    selectedDatabaseName.value = '';
    return;
  }

  const options = await loadDatabaseOptionsForConnection(connectionId);
  const preferredDatabase = connection.id === props.preferredConnectionId
    ? (props.preferredDatabaseName || '').trim()
    : '';

  if (selectedDatabaseName.value && options.includes(selectedDatabaseName.value)) {
    return;
  }
  if (preferredDatabase && options.includes(preferredDatabase)) {
    selectedDatabaseName.value = preferredDatabase;
    return;
  }
  selectedDatabaseName.value = options[0] || connection.database || '';
};

const refreshSchema = async (announce = true, force = false) => {
  if (!selectedConnectionId.value || !resolvedDatabaseName.value) {
    return;
  }

  const schemaKey = `${selectedConnectionId.value}:${resolvedDatabaseName.value}`;
  await ensureSchemaLoaded(force);

  if (announce && !schemaError.value) {
    const announcement = buildSchemaAnnouncement();
    if (lastSchemaAnnouncementKey !== `${schemaKey}:${tableStructs.value.length}`) {
      addMessage('assistant', announcement);
      lastSchemaAnnouncementKey = `${schemaKey}:${tableStructs.value.length}`;
    }
  }
};

const toSerializable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const quotePreviewText = (key: string, params?: Record<string, unknown>) =>
  JSON.stringify(t(`previewHost.${key}`, params));

const buildPreviewContext = () =>
  toSerializable({
    connectionId: selectedConnectionId.value,
    connectionName: currentConnection.value?.name || '',
    databaseName: resolvedDatabaseName.value,
    databaseType: currentConnection.value?.db_type || '',
    tableCount: tableStructs.value.length,
    generatedAt: new Date().toISOString(),
    tables: tableStructs.value.map((table) => ({
      tableName: table.table_name,
      comment: table.comment || '',
      primaryKeys: [...table.primary_keys],
      indexes: table.indexes.map((index) => ({
        name: index.name,
        columns: [...index.columns],
        isUnique: index.is_unique
      })),
      foreignKeys: table.foreign_keys.map((foreignKey) => ({
        constraintName: foreignKey.constraint_name,
        columnName: foreignKey.column_name,
        referencedTable: foreignKey.referenced_table,
        referencedColumn: foreignKey.referenced_column
      })),
      columns: table.columns.map((column) => ({
        name: column.name,
        dataType: column.data_type,
        isNullable: column.is_nullable,
        isPrimaryKey: column.is_primary_key,
        defaultValue: column.default_value,
        comment: column.column_comment || ''
      }))
    }))
  });

const buildPreviewHostHtml = () => `<!DOCTYPE html>
<html lang="${String(t('previewHost.lang') || 'en-US')}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html {
        margin: 0;
        width: 100%;
        height: 100%;
      }
      body {
        margin: 0;
        width: 100%;
        min-height: 100%;
        overflow: auto;
        background: #091520;
        overscroll-behavior: contain;
      }
      #app {
        width: 100%;
        min-height: 100%;
      }
      #status {
        position: fixed;
        right: 10px;
        top: 10px;
        z-index: 30;
        color: #d9e7f2;
        background: rgba(7, 22, 34, .62);
        border: 1px solid rgba(134, 174, 204, .35);
        border-radius: 6px;
        padding: 2px 8px;
        font: 12px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .preview-error {
        margin: 14px;
        color: #f56c6c;
        font: 13px/1.6 Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        white-space: pre-wrap;
      }
    </style>
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"><\/script>
    <script src="https://unpkg.com/vue3-sfc-loader/dist/vue3-sfc-loader.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>
  </head>
  <body>
    <div id="status">${t('previewHost.initializing')}</div>
    <div id="app"></div>
    <script>
      (function () {
        const statusEl = document.getElementById('status');
        const rootEl = document.getElementById('app');
        let currentApp = null;
        let requestSeq = 1;
        const pendingRequests = new Map();

        const setStatus = (status, message) => {
          statusEl.textContent = message || status;
          parent.postMessage({
            type: 'dbm-ai-dashboard-status',
            status: status,
            message: message || ''
          }, '*');
        };

        const callHost = (method, payload) => new Promise((resolve, reject) => {
          const requestId = 'req_' + requestSeq++;
          const timer = window.setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error(${quotePreviewText('errors.hostTimeout')}));
          }, 30000);

          pendingRequests.set(requestId, { resolve, reject, timer });
          parent.postMessage({
            type: 'dbm-ai-dashboard-host-request',
            requestId,
            method,
            payload: payload || {}
          }, '*');
        });

        const normalizeRows = (result) => {
          if (!result) {
            return [];
          }
          if (Array.isArray(result.rows) && result.rows.length && !Array.isArray(result.rows[0])) {
            return result.rows;
          }

          const columns = Array.isArray(result.columns) ? result.columns : [];
          const rows = Array.isArray(result.rows) ? result.rows : [];
          return rows.map((row) => {
            const objectRow = {};
            columns.forEach((column, index) => {
              objectRow[column] = Array.isArray(row) ? row[index] : undefined;
            });
            return objectRow;
          });
        };

        window.__DBM_DASHBOARD_CONTEXT__ = {};
        window.__dbmDashboard = {
          getContext() {
            return window.__DBM_DASHBOARD_CONTEXT__ || {};
          },
          async query(sql) {
            return callHost('query', { sql: String(sql || '') });
          },
          rows(result) {
            return normalizeRows(result);
          },
          first(result) {
            const rows = normalizeRows(result);
            return rows[0] || null;
          },
          value(result, field) {
            const row = this.first(result);
            if (!row) {
              return null;
            }
            if (field) {
              return row[field] ?? null;
            }
            const keys = Object.keys(row);
            return keys.length ? row[keys[0]] : null;
          }
        };

        const renderSfc = async (code) => {
          try {
            setStatus('loading', ${quotePreviewText('rendering')});
            if (!window.Vue || !window['vue3-sfc-loader']) {
              throw new Error(${quotePreviewText('errors.loaderUnavailable')});
            }
            const { loadModule } = window['vue3-sfc-loader'];
            const filePath = '/Dashboard.vue';
            const files = { [filePath]: code };
            const normalizeUrl = (url) => String(url || '').split('#')[0].split('?')[0];

            const options = {
              moduleCache: {
                vue: window.Vue,
                echarts: window.echarts
              },
              getFile(url) {
                const normalizedUrl = normalizeUrl(url);
                if (files[normalizedUrl]) {
                  return Promise.resolve(files[normalizedUrl]);
                }
                throw new Error(${quotePreviewText('errors.moduleMissingPrefix')} + normalizedUrl);
              },
              addStyle(textContent) {
                const style = document.createElement('style');
                style.textContent = textContent;
                document.head.appendChild(style);
              }
            };

            if (currentApp) {
              try {
                currentApp.unmount();
              } catch (_) {}
              rootEl.innerHTML = '';
            }

            const component = await loadModule(filePath + '?t=' + Date.now(), options);
            currentApp = window.Vue.createApp(component);
            currentApp.config.errorHandler = (err) => {
              setStatus('error', String(err));
            };
            currentApp.mount(rootEl);
            setStatus('success', ${quotePreviewText('renderSuccess')});
          } catch (error) {
            const message = String(error && error.message ? error.message : error);
            rootEl.innerHTML = '<pre class="preview-error">' + message.replace(/</g, '&lt;') + '</pre>';
            setStatus('error', message);
          }
        };

        window.addEventListener('message', (event) => {
          const payload = event.data || {};
          if (!payload) {
            return;
          }

          if (payload.type === 'dbm-ai-dashboard-render') {
            window.__DBM_DASHBOARD_CONTEXT__ = payload.context || {};
            renderSfc(String(payload.code || ''));
            return;
          }

          if (payload.type === 'dbm-ai-dashboard-host-response' && payload.requestId) {
            const pending = pendingRequests.get(payload.requestId);
            if (!pending) {
              return;
            }
            window.clearTimeout(pending.timer);
            pendingRequests.delete(payload.requestId);
            if (payload.ok) {
              pending.resolve(payload.data);
            } else {
              pending.reject(new Error(String(payload.error || ${quotePreviewText('errors.hostCallFailed')})));
            }
          }
        });

        setStatus('idle', ${quotePreviewText('waitingForCode')});
      })();
    <\/script>
  </body>
</html>`;

const mountPreviewHost = async () => {
  const frame = previewFrameRef.value;
  if (!frame) {
    return;
  }

  previewMountToken += 1;
  const currentToken = previewMountToken;
  previewStatus.value = 'loading';
  previewStatusText.value = t('previewHost.containerInitializing');
  frame.srcdoc = buildPreviewHostHtml();
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });

  if (currentToken !== previewMountToken) {
    return;
  }
};

const postRenderMessage = () => {
  const frame = previewFrameRef.value;
  if (!frame?.contentWindow) {
    return;
  }

  previewQueryCount.value = 0;
  previewRuntimeError.value = '';
  frame.contentWindow.postMessage(
    {
      type: 'dbm-ai-dashboard-render',
      code: generatedCode.value,
      context: buildPreviewContext()
    },
    '*'
  );
};

const renderPreviewNow = async () => {
  if (!dialogVisible.value) {
    return;
  }
  const frame = previewFrameRef.value;
  if (!frame?.contentWindow) {
    await mountPreviewHost();
  }
  postRenderMessage();
};

const toObjectRows = (result: QueryResult) => {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return rows.map((row) => {
    const objectRow: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      objectRow[column] = Array.isArray(row) ? row[index] ?? null : null;
    });
    return objectRow;
  });
};

const postPreviewHostResponse = (requestId: string, payload: Record<string, unknown>) => {
  const frame = previewFrameRef.value;
  if (!frame?.contentWindow) {
    return;
  }
  frame.contentWindow.postMessage(
    {
      type: 'dbm-ai-dashboard-host-response',
      requestId,
      ...payload
    },
    '*'
  );
};

const handlePreviewHostRequest = async (payload: PreviewHostRequestMessage) => {
  const requestId = String(payload.requestId || '');
  if (!requestId) {
    return;
  }

  if (payload.method !== 'query') {
    postPreviewHostResponse(requestId, {
      ok: false,
      error: t('messages.unsupportedHostMethod')
    });
    return;
  }

  const sql = String(payload.payload?.sql || '').trim();
  if (!sql) {
    postPreviewHostResponse(requestId, {
      ok: false,
      error: t('messages.sqlRequired')
    });
    return;
  }

  if (!selectedConnectionId.value || !resolvedDatabaseName.value) {
    postPreviewHostResponse(requestId, {
      ok: false,
      error: t('messages.databaseNotSelected')
    });
    return;
  }

  try {
    previewQueryCount.value += 1;
    const result = await DbmApi.executeDashboardQuery(
      selectedConnectionId.value,
      sql,
      resolvedDatabaseName.value
    );
    previewRuntimeError.value = '';
    postPreviewHostResponse(requestId, {
      ok: true,
      data: {
        sql,
        columns: result.columns,
        rows: toObjectRows(result),
        rowCount: result.row_count ?? null,
        executionTime: result.execution_time ?? null
      }
    });
  } catch (error) {
    const message = extractDbmErrorMessage(error, t('messages.dashboardQueryFailed'));
    previewRuntimeError.value = message;
    postPreviewHostResponse(requestId, {
      ok: false,
      error: message
    });
  }
};

const extractVueCode = (raw: string) => {
  const content = (raw || '').trim();
  if (!content) {
    return '';
  }

  const blocks: string[] = [];
  const regex = /```(?:vue|html|js|javascript|ts|typescript)?\s*([\s\S]*?)```/gi;
  let matched: RegExpExecArray | null = regex.exec(content);
  while (matched) {
    blocks.push((matched[1] || '').trim());
    matched = regex.exec(content);
  }

  if (!blocks.length) {
    return content;
  }

  const best = blocks.find((item) => item.includes('<template') || item.includes('<script'));
  return (best || blocks[0] || '').trim();
};

const normalizeGeneratedCode = (raw: string) => {
  const candidate = extractVueCode(raw);
  if (!candidate) {
    return buildDefaultDashboardCode();
  }
  if (candidate.includes('<template')) {
    return candidate;
  }
  return buildDefaultDashboardCode();
};

const buildConversationContext = () =>
  messages.value
    .slice(-8)
    .map((item) => `${item.role === 'user' ? t('prompt.roles.user') : t('prompt.roles.assistant')}: ${item.content}`)
    .join('\n');

const submitDashboardPrompt = async (prompt: string) => {
  await generateDashboard(prompt);
};

const generateDashboard = async (promptOverride?: string) => {
  const prompt = (promptOverride ?? promptInput.value).trim();
  if (!prompt) {
    ElMessage.warning(t('messages.promptRequired'));
    return;
  }
  if (!selectedConnectionId.value || !resolvedDatabaseName.value) {
    ElMessage.warning(t('messages.selectDatabaseFirst'));
    return;
  }
  if (!tableStructs.value.length) {
    await refreshSchema(false, false);
  }
  if (!tableStructs.value.length) {
    ElMessage.warning(t('messages.noSchemaTables'));
    return;
  }

  generationError.value = '';
  generating.value = true;
  addMessage('user', prompt);

  const systemPrompt = t('prompt.generateSystem');

  const userPrompt = t('prompt.generateUser', {
    userPrompt: prompt,
    connectionName: currentConnection.value?.name || '-',
    databaseName: resolvedDatabaseName.value,
    sqlDialectHint: buildSqlDialectHint(),
    chartSafetyHint: buildChartSafetyHint(),
    schemaContext: buildSchemaPromptContext(),
    conversationContext: buildConversationContext(),
  });

  try {
    const response = await invoke<string>('otools_ai_generate_text', {
      request: {
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        maxTokens: 4200
      }
    });

    generatedCode.value = normalizeGeneratedCode(response);
    addMessage(
      'assistant',
      t('messages.generatedBySchema', { databaseName: resolvedDatabaseName.value })
    );
    await nextTick();
    try {
      await renderPreviewNow();
    } catch (previewError) {
      const previewMessage = extractDbmErrorMessage(previewError, t('messages.previewRenderFailed'));
      generationError.value = t('messages.generatedButPreviewFailed', { error: previewMessage });
      addMessage('assistant', t('messages.generatedButPreviewFailed', { error: previewMessage }));
    }
  } catch (error) {
    const message = extractDbmErrorMessage(error, t('messages.aiGenerateFailed'));
    generationError.value = message;
    addMessage('assistant', t('messages.generateFailed', { error: message }));
  } finally {
    generating.value = false;
  }
};

const repairDashboardCode = async () => {
  if (!generatedCode.value.trim()) {
    ElMessage.warning(t('messages.noCodeToRepair'));
    return;
  }

  fixingCode.value = true;
  generationError.value = '';

  const errorHint = previewRuntimeError.value || previewStatusText.value || t('messages.previewRuntimeFailed');
  const prompt = promptInput.value.trim() || t('chat.defaultRepairPrompt');

  const systemPrompt = t('prompt.repairSystem');

  const userPrompt = t('prompt.repairUser', {
    userPrompt: prompt,
    databaseName: resolvedDatabaseName.value,
    sqlDialectHint: buildSqlDialectHint(),
    chartSafetyHint: buildChartSafetyHint(),
    previewError: errorHint,
    schemaContext: buildSchemaPromptContext(),
    currentCode: generatedCode.value,
  });

  try {
    const response = await invoke<string>('otools_ai_generate_text', {
      request: {
        systemPrompt,
        userPrompt,
        temperature: 0.05,
        maxTokens: 4200
      }
    });

    generatedCode.value = normalizeGeneratedCode(response);
    addMessage('assistant', t('messages.repairAttempted', { error: errorHint }));
    await nextTick();
    await renderPreviewNow();
  } catch (error) {
    const message = extractDbmErrorMessage(error, t('messages.repairCodeFailed'));
    generationError.value = message;
    addMessage('assistant', t('messages.repairFailed', { error: message }));
  } finally {
    fixingCode.value = false;
  }
};

const resetToDefault = async () => {
  generatedCode.value = buildDefaultDashboardCode();
  generationError.value = '';
  addMessage('assistant', t('messages.resetDefaultDone'));
  await nextTick();
  await renderPreviewNow();
};

const toggleSidePanel = () => {
  sidePanelCollapsed.value = !sidePanelCollapsed.value;
};

const initializeDialog = async () => {
  isInitializingDialog = true;
  try {
    await loadConnections();
    if (selectedConnectionId.value) {
      await loadDatabasesForConnection(selectedConnectionId.value);
    }
    await refreshSchema(false, false);
  } finally {
    isInitializingDialog = false;
  }
};

const handleWindowMessage = (event: MessageEvent) => {
  const frame = previewFrameRef.value;
  if (!frame || event.source !== frame.contentWindow) {
    return;
  }

  const payload = event.data as PreviewHostRequestMessage | { type?: string; status?: string; message?: string };
  if (!payload || typeof payload !== 'object' || !payload.type) {
    return;
  }

  if (payload.type === 'dbm-ai-dashboard-status') {
    const status = String(payload.status || 'idle') as PreviewStatus;
    previewStatus.value = ['idle', 'loading', 'success', 'error'].includes(status) ? status : 'idle';
    if (previewRuntimeError.value && previewStatus.value !== 'success') {
      previewStatusText.value = previewRuntimeError.value;
      return;
    }
    previewStatusText.value = String(payload.message || t('status.waiting'));
    return;
  }

  if (payload.type === 'dbm-ai-dashboard-host-request') {
    void handlePreviewHostRequest(payload as PreviewHostRequestMessage);
  }
};

watch(
  () => dialogVisible.value,
  async (visible) => {
    if (!visible) {
      return;
    }
    await initializeDialog();
    await nextTick();
    await mountPreviewHost();
    postRenderMessage();
  }
);

watch(
  () => selectedConnectionId.value,
  async (connectionId, previousConnectionId) => {
    if (!dialogVisible.value || isInitializingDialog || !connectionId || connectionId === previousConnectionId) {
      return;
    }
    await loadDatabasesForConnection(connectionId);
  }
);

watch(
  () => resolvedDatabaseName.value,
  async (databaseName, previousDatabaseName) => {
    if (!dialogVisible.value || isInitializingDialog || !databaseName || databaseName === previousDatabaseName) {
      return;
    }
    await refreshSchema(true, false);
    await nextTick();
    postRenderMessage();
  }
);

onMounted(() => {
  syncDashboardSideWidth(sidePanelWidth.value);
  window.addEventListener('resize', handleDashboardWindowResize);
  window.addEventListener('message', handleWindowMessage);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleDashboardWindowResize);
  window.removeEventListener('message', handleWindowMessage);
});

watch(
  () => sidePanelWidth.value,
  (value) => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(DASHBOARD_SIDE_WIDTH_STORAGE_KEY, String(value));
  }
);
</script>

<style>
.el-dialog.ai-dashboard-dialog {
  margin: 2vh auto 0 !important;
  min-height: 94vh !important;
  height: 94vh !important;
  max-height: 94vh !important;
  display: flex !important;
  flex-direction: column !important;
  box-sizing: border-box;
  overflow: hidden !important;
}

.el-dialog.ai-dashboard-dialog > .el-dialog__header {
  flex: 0 0 auto;
  margin: 0;
  padding-bottom: 0;
  box-sizing: border-box;
}

.el-dialog.ai-dashboard-dialog > .el-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 0 0;
  overflow: hidden;
  box-sizing: border-box;
}

.el-dialog.ai-dashboard-dialog > .el-dialog__body > .ai-dashboard-root {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}

@media (max-width: 960px) {
  .el-dialog.ai-dashboard-dialog {
    margin-top: 1vh !important;
    min-height: 96vh !important;
    height: 96vh !important;
    max-height: 96vh !important;
  }
}
</style>

<style scoped>
.ai-dashboard-root {
  --dashboard-side-width: 300px;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 0;
  overflow: hidden;
}

.preview-pane {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.preview-toolbar {
  height: 42px;
  padding: 0 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.preview-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-primary);
  min-width: 0;
  flex-wrap: wrap;
}

.preview-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.context-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.context-field {
  gap: 6px;
  min-width: 0;
}

.context-field label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.context-metrics {
  display: inline-flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.context-summary {
  padding: 8px 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-extra-light);
}

.context-summary.is-error {
  color: var(--el-color-danger);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  overscroll-behavior: contain;
}

.workspace-tabs {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

:deep(.workspace-tabs.el-tabs) {
  flex: 1;
  min-height: 0;
}

:deep(.workspace-tabs > .el-tabs__header) {
  margin: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
}

:deep(.workspace-tabs > .el-tabs__content) {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

:deep(.workspace-tabs .el-tabs__content > .el-tab-pane) {
  height: 100%;
  min-height: 0;
}

:deep(.workspace-tabs .el-tab-pane.is-active) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.workspace-panel {
  flex: 1;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.workspace-panel-preview {
  display: flex;
}

.preview-frame {
  flex: 1;
  display: block;
  height: 100%;
  width: 100%;
  border: 0;
  background: #0f1722;
}

.workspace-code-scroll {
  height: 100%;
  background: #0d1721;
}

:deep(.workspace-code-scroll .el-scrollbar__wrap) {
  height: 100%;
  overscroll-behavior: contain;
}

.workspace-code-scroll pre {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #d2e3ef;
  white-space: pre-wrap;
  word-break: break-word;
}

.side-rail {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.dashboard-side-resize-handle {
  margin: 0 2px 0 4px;
  align-self: stretch;
}

.collapse-toggle {
  flex: 0 0 14px;
  align-self: stretch;
  width: 14px;
  height: auto;
  border: 1px solid var(--el-border-color-light);
  border-left: none;
  border-right: none;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  cursor: pointer;
  padding: 0;
  font-size: 11px;
}

.side-pane {
  flex: 0 0 var(--dashboard-side-width);
  width: var(--dashboard-side-width);
  min-width: 220px;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}

.side-header {
  height: 42px;
  padding: 0 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}

.schema-panel {
  padding: 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: color-mix(in srgb, var(--el-color-primary) 4%, var(--el-bg-color));
}

.schema-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.schema-panel-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.schema-panel-main {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.schema-panel-loaded-at {
  color: var(--el-text-color-secondary);
}

.schema-panel-refresh-text {
  padding: 0;
  min-height: auto;
}

.dashboard-ai-chat {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  box-sizing: border-box;
  padding: 10px;
}

:deep(.dashboard-ai-chat.ai-chat-panel) {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
}

.chat-list {
  flex: 1 1 auto;
  min-height: 0;
  border-bottom: 1px solid var(--el-border-color-light);
}

:deep(.chat-list .el-scrollbar__wrap) {
  overscroll-behavior: contain;
}

.chat-messages {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-item {
  border-radius: 8px;
  padding: 8px 10px;
}

.chat-item.role-user {
  background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
}

.chat-item.role-assistant {
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
}

.chat-role {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.chat-content {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.composer {
  border-bottom: 1px solid var(--el-border-color-light);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.composer-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.error-text {
  font-size: 12px;
  color: var(--el-color-danger);
}

.w-full {
  width: 100%;
}

@media (max-width: 960px) {
  .ai-dashboard-root {
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }

  .side-rail {
    width: 100%;
    justify-content: center;
  }

  .dashboard-side-resize-handle {
    display: none;
  }

  .preview-pane,
  .side-pane {
    width: 100%;
    flex-basis: auto;
  }

  .ai-dashboard-root.panel-collapsed .side-pane {
    display: none;
  }

  .collapse-toggle {
    width: 100%;
    height: 24px;
    border-radius: 6px;
    border: 1px solid var(--el-border-color-light);
  }

  .context-bar {
    grid-template-columns: minmax(0, 1fr);
  }

  .context-metrics {
    justify-content: flex-start;
    align-items: center;
  }

  .chat-list {
    flex-basis: 180px;
  }
}
</style>
