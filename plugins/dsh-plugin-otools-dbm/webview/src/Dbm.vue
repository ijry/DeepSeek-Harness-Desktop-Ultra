<template>
  <div class="dbm-container">
    <div ref="containerRef" class="dbm-layout">
      <!-- 左侧数据库连接列表 -->
      <div class="connection-panel" :style="{ width: `${sidebarWidth}px` }">
        <DbConnectionList
          ref="connectionListRef"
          :selected-connection="state.selectedConnection"
          :selected-tree-node="selectedTreeNode"
          :pinned-tables-map="dbmState.pinnedTables"
          :filter-texts-map="dbmState.filterTexts"
          :expanded-keys-map="dbmState.expandedKeysMap"
          @select-connection="handleSelectConnection"
          @add-connection="handleAddConnection"
          @edit-connection="handleEditConnection"
          @delete-connection="handleDeleteConnection"
          @open-table="handleOpenTable"
          @open-view="handleOpenView"
          @open-procedure="handleOpenProcedure"
          @export-table="handleExportTable"
          @create-table="handleCreateTable"
          @create-view="handleCreateView"
          @create-procedure="handleCreateProcedure"
          @drop-table="handleDropTable"
          @drop-view="handleDropView"
          @drop-procedure="handleDropProcedure"
          @pinned-changed="handlePinnedChanged"
          @filter-changed="handleFilterChanged"
          @show-task-panel="showTaskPanel"
          @select-node="handleSelectTreeNode"
          @active-connections-changed="handleActiveConnectionsChanged"
          @expanded-keys-changed="handleExpandedKeysChanged"
        />
      </div>

      <div
        class="resize-handle"
        :class="{ dragging: sidebarResizing }"
        @pointerdown="startSidebarResize"
      ></div>
      
      <!-- 右侧操作区域 -->
      <div ref="operationPanelRef" class="operation-panel flex-1">
        <DbOperationArea 
          :connection="state.selectedConnection"
          :selected-node="selectedTreeNode"
          :connection-id="state.selectedConnection?.id"
          ref="operationAreaRef"
          @open-table="handleOpenTable"
          @open-schema="handleOpenSchema"
          @export-table="handleExportTable"
          @table-created="handleTableCreated"
          @refresh-object-list="handleRefreshObjectList"
          @tabs-state-changed="handleTabsStateChanged"
        />
      </div>
    </div>
    
    <!-- 连接管理对话框 -->
    <el-drawer
      v-if="state.dialogVisible"
      v-model="state.dialogVisible"
      :title="dialogTitle"
      direction="rtl"
      :size="connectionDrawerSize"
      class="dbm-connection-drawer"
      modal-class="dbm-connection-drawer-mask"
    >
      <DbConnectionForm
        :connection="state.editingConnection"
        @save="handleSaveConnection"
        @cancel="state.dialogVisible = false"
      />
    </el-drawer>
    
    <!-- 长时间运行的任务面板 -->
      <LongRunningTasksPanel v-if="tasksPanelMounted" ref="tasksPanelRef" />

    <div v-if="showInteractionProbe" class="interaction-probe" aria-hidden="true">
      <div class="interaction-probe-title">{{ t('probe.title') }}</div>
      <div>{{ t('probe.moves') }}: {{ interactionProbe.moveCount }}</div>
      <div>{{ t('probe.clicks') }}: {{ interactionProbe.clickCount }}</div>
      <div>{{ t('probe.last') }}: {{ interactionProbe.lastEvent }}</div>
      <div>{{ t('probe.point') }}: {{ interactionProbe.pointerText }}</div>
      <div>{{ t('probe.target') }}: {{ interactionProbe.targetText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { DbmApi, extractDbmErrorMessage, type DbConnection } from './service';
import { ElMessage } from 'element-plus';
import DbConnectionList from './DbConnectionList.vue';
import DbOperationArea from './DbOperationArea.vue';
import DbConnectionForm from './DbConnectionForm.vue';
import LongRunningTasksPanel from './LongRunningTasksPanel.vue';
import type { DbTreeFilterState, DbTreeSelection } from './DbmTree.vue';
import { normalizeQueryWorkbenchState, type QueryWorkbenchState } from './queryWorkbenchState';
import { useDragResize } from '@/platform/ui/common/useDragResize';
import { hasHostBridgeRuntime } from '@/platform/runtime';
import { useI18nScope } from '@/platform/i18n';
import {
  getDbmPluginLegacyState,
  getDbmPluginUiState,
  saveDbmPluginLegacyState,
  saveDbmPluginUiState,
} from './service';

type DatabaseConnection = DbConnection;
type PersistedTabState = {
  name: string;
  title: string;
  kind: 'table' | 'view' | 'procedure' | 'create-table' | 'create-view' | 'create-procedure' | 'query';
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  connectionId: string;
  queryState?: QueryWorkbenchState | null;
};
type DbmStateFile = {
  selectedConnectionId?: string;
  pinnedTables?: Record<string, any[]>;
  filterTexts?: Record<string, DbTreeFilterState>;
  sidebarWidth?: number;
  activeConnectionIds?: string[];
  expandedKeysMap?: Record<string, string[]>;
  openTabsState?: Record<string, { activeTab: string; tabs: PersistedTabState[] }>;
  selectedTreeNode?: DbTreeSelection | null;
};

const isTauriRuntime = hasHostBridgeRuntime();
const { t } = useI18nScope('dbm.main');
const DBM_SIDEBAR_MIN_WIDTH = 220;
const DBM_SIDEBAR_MAX_WIDTH = 420;
const DBM_DEFAULT_SIDEBAR_WIDTH = 230;
const DBM_AUTO_RESTORE_TABS = true;
const DBM_AUTO_ACTIVATE_RESTORED_TAB = true;
const DBM_AUTO_RESTORE_CONNECTIONS = true;
const DBM_CONNECTION_RESTORE_DELAY_MS = 240;
const DBM_STATE_SAVE_DEBOUNCE_MS = 160;
const LEGACY_DBM_UI_KEYS = new Set(['selectedConnectionId', 'pinnedTables', 'filterTexts', 'sidebarWidth', 'activeConnectionIds', 'expandedKeysMap', 'openTabsState', 'selectedTreeNode']);
const showInteractionProbe = false;

const getNowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const getOpenTabsCount = (stateFile?: DbmStateFile) =>
  Object.values(stateFile?.openTabsState || {}).reduce((count, item) => count + (Array.isArray(item?.tabs) ? item.tabs.length : 0), 0);

const getExpandedKeysCount = (stateFile?: DbmStateFile) =>
  Object.values(stateFile?.expandedKeysMap || {}).reduce((count, keys) => count + (Array.isArray(keys) ? keys.length : 0), 0);

const logDbmRestore = (phase: string, detail?: Record<string, unknown>) => {
  if (detail) {
    console.log(`[dbm][restore][ui] ${phase}`, detail);
    return;
  }
  console.log(`[dbm][restore][ui] ${phase}`);
};

const normalizeSidebarWidth = (value?: number): number => {
  const width = Number(value);
  if (!Number.isFinite(width)) {
    return DBM_DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.max(DBM_SIDEBAR_MIN_WIDTH, Math.min(DBM_SIDEBAR_MAX_WIDTH, Math.round(width)));
};

const { dragging: sidebarResizing, startDragging: startSidebarResize } = useDragResize({
  axis: 'x',
  min: DBM_SIDEBAR_MIN_WIDTH,
  max: DBM_SIDEBAR_MAX_WIDTH,
  getInitialValue: () => sidebarWidth.value,
  onChange: (value) => {
    sidebarWidth.value = value;
  },
});

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDbType = (value: unknown): value is DatabaseConnection['db_type'] =>
  value === 'mysql'
    || value === 'mariadb'
    || value === 'postgresql'
    || value === 'sqlserver'
    || value === 'kingbasees'
    || value === 'dameng'
    || value === 'sqlite'
    || value === 'elasticsearch'
    || value === 'clickhouse'
    || value === 'kafka'
    || value === 'snowflake'
    || value === 'mongodb'
    || value === 'redis'
    || value === 'oracle';

const isPersistedConnection = (value: unknown): value is DatabaseConnection => {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && isDbType(value.db_type)
    && typeof value.host === 'string'
    && typeof value.port === 'number'
    && Number.isFinite(value.port)
    && typeof value.username === 'string'
    && typeof value.password === 'string'
    && typeof value.database === 'string'
    && typeof value.created_at === 'string'
    && typeof value.connection_string === 'string';
};

const normalizeFilterKeywords = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
};

const normalizeTreeFilterState = (value: unknown): DbTreeFilterState | null => {
  if (isRecord(value)) {
    const keywords = normalizeFilterKeywords(value.keywords);
    const enabled =
      typeof value.enabled === 'boolean'
        ? !!value.enabled
        : keywords.length > 0 || !!value.includeViewsAndProcedures;
    if (!keywords.length && !enabled) {
      return null;
    }
    return {
      keywords,
      enabled
    };
  }

  const keywords = normalizeFilterKeywords(value);
  if (!keywords.length) {
    return null;
  }

  return {
    keywords,
    enabled: true
  };
};

const normalizeKeywordFilterMap = (value: unknown): Record<string, DbTreeFilterState> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, itemValue]) => {
        const filterState = normalizeTreeFilterState(itemValue);
        return [key, filterState] as const;
      })
      .filter(([, filterState]) => !!filterState)
  );
};

const normalizeDbmUiState = (value: unknown): DbmStateFile => {
  if (!isRecord(value)) {
    return {};
  }

  const nextState: DbmStateFile = {};

  if (typeof value.selectedConnectionId === 'string' && value.selectedConnectionId) {
    nextState.selectedConnectionId = value.selectedConnectionId;
  }

  if (isRecord(value.pinnedTables)) {
    nextState.pinnedTables = Object.fromEntries(
      Object.entries(value.pinnedTables)
        .map(([key, pinned]) => [key, Array.isArray(pinned) ? pinned : []] as const)
        .filter(([, pinned]) => pinned.length > 0)
    );
  }

  const normalizedFilterTexts = normalizeKeywordFilterMap(value.filterTexts);
  if (Object.keys(normalizedFilterTexts).length > 0) {
    nextState.filterTexts = normalizedFilterTexts;
  }

  if (typeof value.sidebarWidth === 'number') {
    nextState.sidebarWidth = normalizeSidebarWidth(value.sidebarWidth);
  }

  if (Array.isArray(value.activeConnectionIds)) {
    nextState.activeConnectionIds = Array.from(new Set(value.activeConnectionIds.filter((item): item is string => typeof item === 'string' && item.length > 0)));
  }

  if (isRecord(value.expandedKeysMap)) {
    nextState.expandedKeysMap = Object.fromEntries(
      Object.entries(value.expandedKeysMap)
        .map(([key, itemValue]) => [
          key,
          Array.isArray(itemValue)
            ? Array.from(new Set(itemValue.filter((item): item is string => typeof item === 'string' && item.length > 0)))
            : []
        ] as const)
        .filter(([, keys]) => keys.length > 0)
    );
  }

  if (isRecord(value.openTabsState)) {
    nextState.openTabsState = Object.fromEntries(
      Object.entries(value.openTabsState).flatMap(([connectionId, itemValue]) => {
        if (!isRecord(itemValue) || !Array.isArray(itemValue.tabs) || typeof itemValue.activeTab !== 'string') {
          return [];
        }

        const tabs = itemValue.tabs.filter((tab): tab is PersistedTabState =>
          isRecord(tab)
          && typeof tab.name === 'string'
          && typeof tab.title === 'string'
          && ['table', 'view', 'procedure', 'create-table', 'create-view', 'create-procedure', 'query'].includes(String(tab.kind))
          && typeof tab.tableName === 'string'
          && typeof tab.connectionId === 'string'
          && (tab.databaseName === undefined || typeof tab.databaseName === 'string')
          && (tab.schemaName === undefined || typeof tab.schemaName === 'string')
        ).map((tab) => ({
          ...tab,
          queryState: tab.kind === 'query' ? normalizeQueryWorkbenchState(tab.queryState) : undefined
        }));

        return tabs.length || itemValue.activeTab === 'home'
          ? [[connectionId, { activeTab: itemValue.activeTab, tabs }]]
          : [];
      })
    );
  }

  if (isRecord(value.selectedTreeNode) && typeof value.selectedTreeNode.type === 'string' && typeof value.selectedTreeNode.connectionId === 'string' && typeof value.selectedTreeNode.label === 'string') {
    nextState.selectedTreeNode = {
      type: value.selectedTreeNode.type,
      connectionId: value.selectedTreeNode.connectionId,
      databaseName: typeof value.selectedTreeNode.databaseName === 'string' ? value.selectedTreeNode.databaseName : undefined,
      schemaName: typeof value.selectedTreeNode.schemaName === 'string' ? value.selectedTreeNode.schemaName : undefined,
      tableName: typeof value.selectedTreeNode.tableName === 'string' ? value.selectedTreeNode.tableName : undefined,
      label: value.selectedTreeNode.label
    };
  }

  return nextState;
};

const splitLegacyDbmState = (value: unknown) => {
  if (!isRecord(value)) {
    return {
      uiState: {} as DbmStateFile,
      connectionsState: {} as Record<string, DatabaseConnection>,
      hasLegacyUiState: false,
      shouldSanitizeConnections: false
    };
  }

  const uiState = normalizeDbmUiState(value);
  const connectionsState: Record<string, DatabaseConnection> = {};
  let shouldSanitizeConnections = false;

  for (const [key, itemValue] of Object.entries(value)) {
    if (isPersistedConnection(itemValue)) {
      connectionsState[key] = itemValue;
      continue;
    }

    if (LEGACY_DBM_UI_KEYS.has(key)) {
      shouldSanitizeConnections = true;
    }
  }

  return {
    uiState,
    connectionsState,
    hasLegacyUiState: Object.keys(uiState).length > 0,
    shouldSanitizeConnections
  };
};

const migrateLegacyDbmStorageIfNeeded = async (): Promise<DbmStateFile | null> => {
  const legacyState = await getDbmPluginLegacyState<unknown>();
  const storedUiState = await getDbmPluginUiState<DbmStateFile | null>();
  const { uiState: legacyUiState, connectionsState, hasLegacyUiState, shouldSanitizeConnections } =
    splitLegacyDbmState(legacyState);

  let migratedUiState: DbmStateFile | null = null;
  let migrated = false;

  if (!storedUiState && hasLegacyUiState) {
    migratedUiState = legacyUiState;
    await saveDbmPluginUiState(migratedUiState);
    migrated = true;
  }

  if (shouldSanitizeConnections) {
    await saveDbmPluginLegacyState(connectionsState);
    migrated = true;
  }

  if (migrated) {
    ElMessage.success(t('localStateFixed'));
  }

  return migratedUiState;
};

// 生成数据库连接字符串
function generateConnectionString(connection: DatabaseConnection): string {
  switch (connection.db_type) {
    case 'mysql':
      return `mysql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'mariadb':
      return `mariadb://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'postgresql':
      return `postgresql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'sqlserver':
      return `sqlserver://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'kingbasees':
      return `kingbasees://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'dameng':
      return connection.odbc?.connection_string || `odbc://${connection.host}:${connection.port}/${connection.database}`;
    case 'sqlite':
      return `sqlite://${connection.database}`;
    case 'elasticsearch':
      return `elasticsearch://${connection.host}:${connection.port}/${connection.database}`;
    case 'clickhouse':
      return `clickhouse://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'kafka':
      return `kafka://${connection.host}:${connection.port}/${connection.database || 'topics'}`;
    case 'snowflake':
      return `snowflake://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'mongodb':
      return (() => {
        const auth = connection.username
          ? `${connection.username}:${connection.password}@`
          : '';
        const base = `mongodb://${auth}${connection.host}:${connection.port}/${connection.database}`;
        const params = new URLSearchParams();
        if (connection.mongodb?.auth_source?.trim()) {
          params.set('authSource', connection.mongodb.auth_source.trim());
        }
        if (connection.mongodb?.auth_mechanism?.trim()) {
          params.set('authMechanism', connection.mongodb.auth_mechanism.trim());
        }
        if (connection.mongodb?.replica_set?.trim()) {
          params.set('replicaSet', connection.mongodb.replica_set.trim());
        }
        if (connection.mongodb?.read_preference?.trim()) {
          params.set('readPreference', connection.mongodb.read_preference.trim());
        }
        if (typeof connection.mongodb?.retry_writes === 'boolean') {
          params.set('retryWrites', connection.mongodb.retry_writes ? 'true' : 'false');
        }
        if (connection.mongodb?.tls) {
          params.set('tls', 'true');
        }
        if (connection.mongodb?.tls_allow_invalid_certificates) {
          params.set('tlsAllowInvalidCertificates', 'true');
        }
        if (connection.mongodb?.tls_ca_file?.trim()) {
          params.set('tlsCAFile', connection.mongodb.tls_ca_file.trim());
        }
        if (connection.mongodb?.tls_certificate_key_file?.trim()) {
          params.set('tlsCertificateKeyFile', connection.mongodb.tls_certificate_key_file.trim());
        }
        if (connection.mongodb?.tls_certificate_key_file_password?.trim()) {
          params.set('tlsCertificateKeyFilePassword', connection.mongodb.tls_certificate_key_file_password.trim());
        }
        const query = params.toString();
        return query ? `${base}?${query}` : base;
      })();
    case 'redis':
      return `redis://${connection.password ? `:${connection.password}@` : ''}${connection.host}:${connection.port}/${connection.database || '0'}`;
    case 'oracle':
      return `oracle://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    default:
      return '';
  }
}

// 添加对DbOperationArea和任务面板的引用
const operationAreaRef = ref();
const tasksPanelRef = ref();
const tasksPanelMounted = ref(false);
const connectionListRef = ref();
const containerRef = ref<HTMLElement | null>(null);
const operationPanelRef = ref<HTMLElement | null>(null);
const interactionProbe = reactive({
  moveCount: 0,
  clickCount: 0,
  lastEvent: 'none',
  pointerText: '-',
  targetText: 'waiting for pointer event'
});
const sidebarWidth = ref(DBM_DEFAULT_SIDEBAR_WIDTH);
const operationPanelWidth = ref(0);
const isRestoringWorkspace = ref(true);
const canPersistDbmState = ref(false);
let sidebarWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let dbmStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
let restoreConnectionsTimer: ReturnType<typeof setTimeout> | null = null;
let restoreConnectionsFrame: number | null = null;
let operationPanelResizeObserver: ResizeObserver | null = null;
let lastProbeMoveAt = 0;
let lastSavedDbmStateJson = '';
let pendingDbmStateJson: string | null = null;
let isSavingDbmState = false;

const describeProbeTarget = (target: EventTarget | null, clientX?: number, clientY?: number) => {
  const element = target instanceof Element
    ? target
    : (typeof clientX === 'number' && typeof clientY === 'number'
      ? document.elementFromPoint(clientX, clientY)
      : null);

  if (!element) {
    return 'none';
  }

  const classText = typeof element.className === 'string'
    ? element.className.trim().replace(/\s+/g, '.')
    : '';

  return [element.tagName.toLowerCase(), element.id ? `#${element.id}` : '', classText ? `.${classText}` : '']
    .filter(Boolean)
    .join('');
};

const updateInteractionProbe = (eventName: string, event: MouseEvent | PointerEvent) => {
  interactionProbe.lastEvent = eventName;
  interactionProbe.pointerText = `${Math.round(event.clientX)}, ${Math.round(event.clientY)}`;
  interactionProbe.targetText = describeProbeTarget(event.target, event.clientX, event.clientY);
};

const handleProbePointerMove = (event: PointerEvent) => {
  const now = Date.now();
  if (now - lastProbeMoveAt < 120) {
    return;
  }
  lastProbeMoveAt = now;
  interactionProbe.moveCount += 1;
  updateInteractionProbe('pointermove', event);
};

const handleProbeClick = (event: MouseEvent) => {
  interactionProbe.clickCount += 1;
  updateInteractionProbe('click', event);
};

// 使用 reactive 替代 ref 来管理 selectedConnection
const state = reactive({
  selectedConnection: null as DatabaseConnection | null,
  dialogVisible: false,
  editingConnection: null as DatabaseConnection | null,
  connections: [] as DatabaseConnection[]
});
const dbmState = ref<DbmStateFile>({});
const selectedTreeNode = ref<DbTreeSelection | null>(null);

const dialogTitle = computed(() => {
  return state.editingConnection ? t('editConnection') : t('addConnection');
});

const syncOperationPanelWidth = () => {
  operationPanelWidth.value = operationPanelRef.value?.clientWidth || 0;
};

const connectionDrawerSize = computed(() => {
  const width = Math.round(operationPanelWidth.value);
  if (width > 0) {
    return `${width}px`;
  }
  return '70%';
});

const loadDbmState = async () => {
  const startedAt = getNowMs();
  logDbmRestore('load-state:start', {
    tauriRuntime: isTauriRuntime
  });
  if (!isTauriRuntime) {
    dbmState.value = {};
    sidebarWidth.value = DBM_DEFAULT_SIDEBAR_WIDTH;
    logDbmRestore('load-state:skip-non-tauri', {
      elapsedMs: Math.round(getNowMs() - startedAt)
    });
    return;
  }

  try {
    const migratedUiState = await migrateLegacyDbmStorageIfNeeded();
    const storedUiState = migratedUiState || (await getDbmPluginUiState<DbmStateFile | null>());
    dbmState.value = normalizeDbmUiState(storedUiState);
    applyRestoreExpandedKeys(dbmState.value);
    sidebarWidth.value = normalizeSidebarWidth(dbmState.value.sidebarWidth);
    selectedTreeNode.value = dbmState.value.selectedTreeNode || null;
    lastSavedDbmStateJson = JSON.stringify(dbmState.value);
    pendingDbmStateJson = null;
    logDbmRestore('load-state:done', {
      selectedConnectionId: dbmState.value.selectedConnectionId || null,
      activeConnectionIds: dbmState.value.activeConnectionIds || [],
      openTabsCount: getOpenTabsCount(dbmState.value),
      expandedKeysCount: getExpandedKeysCount(dbmState.value),
      selectedTreeNode: dbmState.value.selectedTreeNode || null,
      elapsedMs: Math.round(getNowMs() - startedAt)
    });
  } catch (error) {
    console.error('读取 DBM 状态失败:', error);
    dbmState.value = {};
    sidebarWidth.value = DBM_DEFAULT_SIDEBAR_WIDTH;
    selectedTreeNode.value = null;
    lastSavedDbmStateJson = JSON.stringify(dbmState.value);
    pendingDbmStateJson = null;
    logDbmRestore('load-state:failed', {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(getNowMs() - startedAt)
    });
  }
};

const getInitialRestoreConnectionIds = (stateFile: DbmStateFile): string[] => {
  const ids = new Set<string>((stateFile.activeConnectionIds || []).filter(Boolean));

  if (ids.size > 0) {
    return Array.from(ids);
  }

  if (stateFile.selectedTreeNode?.connectionId) {
    ids.add(stateFile.selectedTreeNode.connectionId);
  } else if (stateFile.selectedConnectionId) {
    ids.add(stateFile.selectedConnectionId);
  }

  if (ids.size === 0 && stateFile.expandedKeysMap) {
    for (const connectionId of Object.keys(stateFile.expandedKeysMap)) {
      if (connectionId) {
        ids.add(connectionId);
      }
    }
  }

  if (ids.size === 0 && stateFile.openTabsState) {
    for (const connectionId of Object.keys(stateFile.openTabsState)) {
      if (connectionId) {
        ids.add(connectionId);
      }
    }
  }

  return Array.from(ids);
};

const mergeExpandedKeys = (...groups: Array<string[] | undefined>) =>
  Array.from(
    new Set(
      groups.flatMap((items) =>
        (items || []).filter((item): item is string => typeof item === 'string' && item.length > 0)
      )
    )
  );

const encodeTreeKeyPart = (value: string) => encodeURIComponent(value);
const createSchemaNodeId = (databaseName: string, schemaName: string) =>
  `schema::${encodeTreeKeyPart(databaseName)}::${encodeTreeKeyPart(schemaName)}`;
const createFolderNodeId = (
  type: 'tables' | 'views' | 'procedures',
  databaseName: string,
  schemaName?: string
) =>
  schemaName
    ? `${type}::${encodeTreeKeyPart(databaseName)}::${encodeTreeKeyPart(schemaName)}`
    : `${type}_${databaseName}`;
const createObjectNodeId = (
  type: 'table' | 'view' | 'proc',
  databaseName: string,
  objectName: string,
  schemaName?: string
) =>
  schemaName
    ? `${type}::${encodeTreeKeyPart(databaseName)}::${encodeTreeKeyPart(schemaName)}::${encodeTreeKeyPart(objectName)}`
    : `${type}_${databaseName}_${objectName}`;

const getExpandedKeysForTab = (tab: PersistedTabState): string[] => {
  const databaseName = tab.databaseName?.trim();
  if (!databaseName) {
    return [];
  }

  if (tab.kind === 'table' && tab.tableName) {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('tables', databaseName, tab.schemaName),
      createObjectNodeId('table', databaseName, tab.tableName, tab.schemaName)
    ];
  }

  if (tab.kind === 'view' && tab.tableName) {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('views', databaseName, tab.schemaName),
      createObjectNodeId('view', databaseName, tab.tableName, tab.schemaName)
    ];
  }

  if (tab.kind === 'procedure' && tab.tableName) {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('procedures', databaseName, tab.schemaName),
      createObjectNodeId('proc', databaseName, tab.tableName, tab.schemaName)
    ];
  }

  if (tab.kind === 'create-view') {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('views', databaseName, tab.schemaName)
    ];
  }

  if (tab.kind === 'create-procedure') {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('procedures', databaseName, tab.schemaName)
    ];
  }

  if (tab.kind === 'create-table') {
    return [
      `db_${databaseName}`,
      ...(tab.schemaName ? [createSchemaNodeId(databaseName, tab.schemaName)] : []),
      createFolderNodeId('tables', databaseName, tab.schemaName)
    ];
  }

  if (tab.kind === 'query') {
    return [`db_${databaseName}`];
  }

  return [];
};

const getExpandedKeysForSelection = (selection?: DbTreeSelection | null): string[] => {
  if (!selection?.databaseName) {
    return [];
  }

  if (selection.type === 'database') {
    return [`db_${selection.databaseName}`];
  }

  if (selection.type === 'table' && selection.tableName) {
    return [
      `db_${selection.databaseName}`,
      ...(selection.schemaName ? [createSchemaNodeId(selection.databaseName, selection.schemaName)] : []),
      createFolderNodeId('tables', selection.databaseName, selection.schemaName),
      createObjectNodeId('table', selection.databaseName, selection.tableName, selection.schemaName)
    ];
  }

  if (selection.type === 'view' && selection.tableName) {
    return [
      `db_${selection.databaseName}`,
      ...(selection.schemaName ? [createSchemaNodeId(selection.databaseName, selection.schemaName)] : []),
      createFolderNodeId('views', selection.databaseName, selection.schemaName),
      createObjectNodeId('view', selection.databaseName, selection.tableName, selection.schemaName)
    ];
  }

  if (selection.type === 'procedure' && selection.tableName) {
    return [
      `db_${selection.databaseName}`,
      ...(selection.schemaName ? [createSchemaNodeId(selection.databaseName, selection.schemaName)] : []),
      createFolderNodeId('procedures', selection.databaseName, selection.schemaName),
      createObjectNodeId('proc', selection.databaseName, selection.tableName, selection.schemaName)
    ];
  }

  if (selection.type === 'schema' && selection.schemaName) {
    return [`db_${selection.databaseName}`, createSchemaNodeId(selection.databaseName, selection.schemaName)];
  }

  return [`db_${selection.databaseName}`];
};

const applyRestoreExpandedKeys = (stateFile: DbmStateFile) => {
  const nextExpandedKeysMap = { ...(stateFile.expandedKeysMap || {}) };

  for (const [connectionId, tabsState] of Object.entries(stateFile.openTabsState || {})) {
    const tabExpandedKeys = mergeExpandedKeys(...tabsState.tabs.map((tab) => getExpandedKeysForTab(tab)));
    if (!tabExpandedKeys.length) {
      continue;
    }
    nextExpandedKeysMap[connectionId] = mergeExpandedKeys(nextExpandedKeysMap[connectionId], tabExpandedKeys);
  }

  if (stateFile.selectedTreeNode?.connectionId) {
    const selectionExpandedKeys = getExpandedKeysForSelection(stateFile.selectedTreeNode);
    if (selectionExpandedKeys.length) {
      const connectionId = stateFile.selectedTreeNode.connectionId;
      nextExpandedKeysMap[connectionId] = mergeExpandedKeys(nextExpandedKeysMap[connectionId], selectionExpandedKeys);
    }
  }

  stateFile.expandedKeysMap = Object.fromEntries(
    Object.entries(nextExpandedKeysMap).filter(([, keys]) => Array.isArray(keys) && keys.length > 0)
  );
};

const flushDbmStateSave = async () => {
  if (!isTauriRuntime || !canPersistDbmState.value) {
    return;
  }

  if (isSavingDbmState) {
    return;
  }

  const nextJson = pendingDbmStateJson;
  if (!nextJson || nextJson === lastSavedDbmStateJson) {
    pendingDbmStateJson = null;
    return;
  }

  let stateToPersist: DbmStateFile;
  try {
    stateToPersist = JSON.parse(nextJson) as DbmStateFile;
  } catch (error) {
    console.error('序列化 DBM 状态失败:', error);
    pendingDbmStateJson = null;
    return;
  }

  pendingDbmStateJson = null;
  isSavingDbmState = true;

  try {
    await saveDbmPluginUiState(stateToPersist);
    lastSavedDbmStateJson = nextJson;
  } catch (error) {
    console.error('保存 DBM 状态失败:', error);
    pendingDbmStateJson = pendingDbmStateJson ?? nextJson;
  } finally {
    isSavingDbmState = false;
    if (pendingDbmStateJson && pendingDbmStateJson !== lastSavedDbmStateJson) {
      void flushDbmStateSave();
    }
  }
};

const saveDbmState = async (options: { immediate?: boolean } = {}) => {
  if (!isTauriRuntime || !canPersistDbmState.value) {
    return;
  }

  const nextJson = JSON.stringify(dbmState.value);
  if (nextJson === lastSavedDbmStateJson && !pendingDbmStateJson) {
    return;
  }

  pendingDbmStateJson = nextJson;

  if (dbmStateSaveTimer) {
    clearTimeout(dbmStateSaveTimer);
    dbmStateSaveTimer = null;
  }

  if (options.immediate) {
    await flushDbmStateSave();
    return;
  }

  dbmStateSaveTimer = setTimeout(() => {
    dbmStateSaveTimer = null;
    void flushDbmStateSave();
  }, DBM_STATE_SAVE_DEBOUNCE_MS);
};

const syncSelectedConnectionAfterLoad = () => {
  const preferredId = state.selectedConnection?.id || dbmState.value.selectedConnectionId;
  if (!preferredId) {
    return;
  }

  const matched = state.connections.find((item) => item.id === preferredId);
  if (matched) {
    state.selectedConnection = { ...matched };
    return;
  }

  if (state.selectedConnection?.id === preferredId) {
    state.selectedConnection = null;
  }
};

const loadConnections = async () => {
  const startedAt = getNowMs();
  logDbmRestore('load-connections:start');
  try {
    const result = await DbmApi.getConnections();
    state.connections = result.map(conn => ({
      ...conn,
      id: conn.id,
      last_used: conn.last_used
    }));
    syncSelectedConnectionAfterLoad();
    logDbmRestore('load-connections:done', {
      count: state.connections.length,
      selectedConnectionId: state.selectedConnection?.id || dbmState.value.selectedConnectionId || null,
      elapsedMs: Math.round(getNowMs() - startedAt)
    });
  } catch (error) {
    console.error('加载连接列表失败:', error);
    ElMessage.error(t('loadConnectionsFailed', { error: extractDbmErrorMessage(error, t('unknownError')) }));
    logDbmRestore('load-connections:failed', {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(getNowMs() - startedAt)
    });
  }
};

const refreshConnectionPanels = async () => {
  await loadConnections();
  await connectionListRef.value?.refreshConnections?.();
};

const handleSelectConnection = (connection: DatabaseConnection) => {
  console.log('=== Dbm.vue handleSelectConnection START ===');
  console.log('Received connection data:', connection);
  console.log('Current selectedConnection value:', state.selectedConnection);
  
  if (!connection) {
    console.error('Connection data is null or undefined');
    return;
  }
  
  state.selectedConnection = {
    ...connection,
    ssh: connection.ssh ? { ...connection.ssh } : null
  };
  dbmState.value.selectedConnectionId = connection.id;
  void saveDbmState();
  console.log('Set selectedConnection to:', state.selectedConnection);
  console.log('=== Dbm.vue handleSelectConnection END ===');
};

const handleSelectTreeNode = (selection: DbTreeSelection) => {
  selectedTreeNode.value = selection;
  dbmState.value.selectedTreeNode = selection;
  void saveDbmState();
};

const handleAddConnection = () => {
  state.editingConnection = null;
  state.dialogVisible = true;
};

const handleEditConnection = (connection: DatabaseConnection) => {
  console.log('=== Dbm.vue handleEditConnection START ===');
  console.log('Received connection data:', connection);
  console.log('Current editingConnection value:', state.editingConnection);
  console.log('Current dialogVisible value:', state.dialogVisible);
  
  if (!connection) {
    console.error('Connection data is null or undefined');
    return;
  }
  
  // 创建连接对象的副本以避免可能的只读问题
  state.editingConnection = {
    ...connection,
    ssh: connection.ssh ? { ...connection.ssh } : null
  };
  console.log('Set editingConnection to:', state.editingConnection);
  
  state.dialogVisible = true;
  console.log('Set dialogVisible to:', state.dialogVisible);
  console.log('Dialog should now be visible');
  console.log('=== Dbm.vue handleEditConnection END ===');
};

const handleDeleteConnection = async (id: string) => {
  try {
    await DbmApi.deleteConnection(id);
    await refreshConnectionPanels();
    if (state.selectedConnection?.id === id) {
      state.selectedConnection = null;
      selectedTreeNode.value = null;
      dbmState.value.selectedConnectionId = undefined;
      dbmState.value.selectedTreeNode = undefined;
      void saveDbmState();
    }
    if (dbmState.value.activeConnectionIds?.length) {
      dbmState.value.activeConnectionIds = dbmState.value.activeConnectionIds.filter((item) => item !== id);
    }
    if (dbmState.value.expandedKeysMap?.[id]) {
      delete dbmState.value.expandedKeysMap[id];
    }
    if (dbmState.value.pinnedTables?.[id]) {
      delete dbmState.value.pinnedTables[id];
    }
    if (dbmState.value.filterTexts?.[id]) {
      delete dbmState.value.filterTexts[id];
    }
    if (dbmState.value.openTabsState?.[id]) {
      delete dbmState.value.openTabsState[id];
    }
    void saveDbmState();
    ElMessage.success(t('deleteConnectionSuccess'));
  } catch (error) {
    console.error('删除连接失败:', error);
    ElMessage.error(t('deleteConnectionFailed', { error: (error as Error).message }));
  }
};

const handleSaveConnection = async (connection: DatabaseConnection) => {
  try {
    if (state.editingConnection && state.editingConnection.id) {
      // 更新现有连接
      console.log('Updating existing connection:', connection);
      await DbmApi.updateConnection(connection.id!, connection as DbConnection);
      await refreshConnectionPanels();
      ElMessage.success(t('updateConnectionSuccess'));
    } else {
      // 添加新连接
      console.log('Adding new connection:', connection);
      const newConnection = {
        ...connection,
        id: Date.now().toString(),
        created_at: new Date().toISOString(),
        connection_string: generateConnectionString({ 
          ...connection, 
          id: Date.now().toString(), 
          created_at: new Date().toISOString()
        } as DbConnection)
      } as DbConnection;
      await DbmApi.addConnection(newConnection);
      await refreshConnectionPanels();
      ElMessage.success(t('addConnectionSuccess'));
    }
    state.dialogVisible = false;
    state.editingConnection = null; // 清空编辑状态
  } catch (error) {
    console.error('保存连接失败:', error);
    ElMessage.error(t('saveConnectionFailed', { error: extractDbmErrorMessage(error, t('unknownError')) }));
  }
};

const handleOpenTable = (connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => {
  if (operationAreaRef.value && typeof operationAreaRef.value.handleOpenTable === 'function') {
    operationAreaRef.value.handleOpenTable(connectionId, tableName, databaseName, schemaName);
  }
};

const handleOpenView = (connectionId: string, viewName: string, databaseName?: string, schemaName?: string) => {
  if (operationAreaRef.value && typeof operationAreaRef.value.handleOpenView === 'function') {
    operationAreaRef.value.handleOpenView(connectionId, viewName, databaseName, schemaName);
  }
};

const handleOpenProcedure = (connectionId: string, procedureName: string, databaseName?: string, schemaName?: string) => {
  if (operationAreaRef.value && typeof operationAreaRef.value.handleOpenProcedure === 'function') {
    operationAreaRef.value.handleOpenProcedure(connectionId, procedureName, databaseName, schemaName);
  }
};

// 新增处理导出表事件的方法
const handleExportTable = (connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => {
  console.log('=== Dbm.vue handleExportTable START ===');
  console.log('Connection ID:', connectionId);
  console.log('Table Name:', tableName);
  console.log('Database Name:', databaseName);
  
  // 直接调用DbOperationArea组件的方法来处理导出
  if (operationAreaRef.value && typeof operationAreaRef.value.handleExportTable === 'function') {
    operationAreaRef.value.handleExportTable(connectionId, tableName, databaseName, schemaName);
  } else {
    console.error('DbOperationArea reference not available or handleExportTable method not found');
  }
};

const handlePinnedChanged = (connectionId: string, pinnedTables: any[]) => {
  if (!dbmState.value.pinnedTables) dbmState.value.pinnedTables = {};
  dbmState.value.pinnedTables[connectionId] = pinnedTables;
  saveDbmState();
};

const handleCreateView = (connectionId: string, databaseName: string, schemaName?: string) => {
  if (operationAreaRef.value?.handleCreateView) {
    operationAreaRef.value.handleCreateView(connectionId, databaseName, schemaName);
  }
};

const handleCreateTable = (connectionId: string, databaseName: string, schemaName?: string) => {
  if (operationAreaRef.value?.handleCreateTable) {
    operationAreaRef.value.handleCreateTable(connectionId, databaseName, schemaName);
  }
};

const handleCreateProcedure = (connectionId: string, databaseName: string, schemaName?: string) => {
  if (operationAreaRef.value?.handleCreateProcedure) {
    operationAreaRef.value.handleCreateProcedure(connectionId, databaseName, schemaName);
  }
};

const handleRefreshObjectList = async (
  connectionId: string,
  databaseName: string | undefined,
  schemaName: string | undefined,
  objectType: 'tables' | 'views' | 'procedures'
) => {
  const treeRef = connectionListRef.value?.getDbmTreeRef(connectionId);
  if (treeRef?.refreshObjectList) {
    await treeRef.refreshObjectList(objectType, databaseName, schemaName);
    return;
  }
  if (treeRef?.refreshTree) {
    await treeRef.refreshTree();
  }
};

const handleTableCreated = async (connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => {
  await nextTick();
  await handleRefreshObjectList(connectionId, databaseName, schemaName, 'tables');

  if (databaseName) {
    selectedTreeNode.value = {
      type: 'table',
      connectionId,
      databaseName,
      schemaName,
      tableName,
      label: tableName
    };
  }
};

const getConnectionById = (connectionId: string) =>
  state.connections.find((item) => item.id === connectionId)
  || (state.selectedConnection?.id === connectionId ? state.selectedConnection : undefined);

const quoteDoubleIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteBacktickIdentifier = (value: string) => `\`${value.replace(/`/g, '``')}\``;
const quoteSqlServerIdentifier = (value: string) => `[${value.replace(/\]/g, ']]')}]`;

const buildDropQualifiedName = (
  connection: DatabaseConnection | undefined,
  objectName: string,
  databaseName: string,
  schemaName?: string
) => {
  if (connection?.db_type === 'postgresql' || connection?.db_type === 'kingbasees' || connection?.db_type === 'oracle') {
    return `${schemaName ? `${quoteDoubleIdentifier(schemaName)}.` : ''}${quoteDoubleIdentifier(objectName)}`;
  }
  if (connection?.db_type === 'sqlserver') {
    return `${schemaName ? `${quoteSqlServerIdentifier(schemaName)}.` : ''}${quoteSqlServerIdentifier(objectName)}`;
  }
  if (connection?.db_type === 'dameng') {
    return `${schemaName ? `${quoteDoubleIdentifier(schemaName)}.` : ''}${quoteDoubleIdentifier(objectName)}`;
  }

  return `${databaseName ? `${quoteBacktickIdentifier(databaseName)}.` : ''}${quoteBacktickIdentifier(objectName)}`;
};

const handleDropTable = async (connectionId: string, tableName: string, databaseName: string, schemaName?: string) => {
  try {
    await DbmApi.dropTable(connectionId, databaseName, tableName, schemaName);
    ElMessage.success(t('dropTableSuccess', { tableName }));

    if (dbmState.value.pinnedTables?.[connectionId]) {
      dbmState.value.pinnedTables[connectionId] = (dbmState.value.pinnedTables[connectionId] || []).filter((item: any) =>
        !(item?.dbName === databaseName && item?.tableName === tableName)
      );
      void saveDbmState();
    }

    await handleRefreshObjectList(connectionId, databaseName, schemaName, 'tables');
  } catch (error) {
    ElMessage.error(t('dropTableFailed', { error: (error as Error).message }));
  }
};

const handleDropView = async (connectionId: string, viewName: string, databaseName: string, schemaName?: string) => {
  try {
    const connection = getConnectionById(connectionId);
    const qualifiedName = buildDropQualifiedName(connection, viewName, databaseName, schemaName);
    await DbmApi.executeQuery(connectionId, `DROP VIEW ${qualifiedName}`, databaseName);
    ElMessage.success(t('dropViewSuccess', { viewName }));
    await handleRefreshObjectList(connectionId, databaseName, schemaName, 'views');
  } catch (error) {
    ElMessage.error(t('dropViewFailed', { error: (error as Error).message }));
  }
};

const handleDropProcedure = async (connectionId: string, procedureName: string, databaseName: string, schemaName?: string) => {
  try {
    const connection = getConnectionById(connectionId);
    const qualifiedName = buildDropQualifiedName(connection, procedureName, databaseName, schemaName);
    await DbmApi.executeQuery(connectionId, `DROP PROCEDURE ${qualifiedName}`, databaseName);
    ElMessage.success(t('dropProcedureSuccess', { procedureName }));
    await handleRefreshObjectList(connectionId, databaseName, schemaName, 'procedures');
  } catch (error) {
    ElMessage.error(t('dropProcedureFailed', { error: (error as Error).message }));
  }
};

const handleFilterChanged = (connectionId: string, filterState: DbTreeFilterState) => {
  if (!dbmState.value.filterTexts) dbmState.value.filterTexts = {};
  if (filterState.keywords.length || filterState.enabled) {
    dbmState.value.filterTexts[connectionId] = filterState;
  } else {
    delete dbmState.value.filterTexts[connectionId];
  }
  saveDbmState();
};

const handleActiveConnectionsChanged = (activeConnectionIds: string[]) => {
  const activeConnectionIdSet = new Set(activeConnectionIds);

  state.connections = state.connections.map((connection) => ({
    ...connection,
    isConnected: activeConnectionIdSet.has(connection.id)
  }));

  if (state.selectedConnection?.id) {
    state.selectedConnection = {
      ...state.selectedConnection,
      isConnected: activeConnectionIdSet.has(state.selectedConnection.id)
    };
  }

  if (isRestoringWorkspace.value) {
    return;
  }
  dbmState.value.activeConnectionIds = activeConnectionIds;
  void saveDbmState();
};

const handleExpandedKeysChanged = (connectionId: string, expandedKeys: string[]) => {
  if (!dbmState.value.expandedKeysMap) {
    dbmState.value.expandedKeysMap = {};
  }

  if (expandedKeys.length) {
    dbmState.value.expandedKeysMap[connectionId] = expandedKeys;
  } else {
    delete dbmState.value.expandedKeysMap[connectionId];
  }

  void saveDbmState();
};

const handleTabsStateChanged = (openTabsState: Record<string, { activeTab: string; tabs: PersistedTabState[] }>) => {
  if (isRestoringWorkspace.value) {
    return;
  }
  dbmState.value.openTabsState = openTabsState;
  void saveDbmState();
};

const handleOpenSchema = (schemaName: string) => {
  console.log('打开表结构:', schemaName);
  // 这里可以实现打开新标签页的逻辑
};

const showTaskPanel = async () => {
  console.log('=== Dbm.vue showTaskPanel called ===');
  console.log('tasksPanelRef value:', tasksPanelRef.value);
  console.log('tasksPanelRef.show function exists:', tasksPanelRef.value && typeof tasksPanelRef.value.show === 'function');

  if (!tasksPanelMounted.value) {
    tasksPanelMounted.value = true;
    await nextTick();
  }
  
  if (tasksPanelRef.value && typeof tasksPanelRef.value.show === 'function') {
    console.log('Calling tasksPanelRef.value.show()');
    tasksPanelRef.value.show();
  } else {
    console.error('LongRunningTasksPanel reference not available or show method not found');
  }
};

onMounted(async () => {
  if (showInteractionProbe) {
    document.addEventListener('pointermove', handleProbePointerMove, true);
    document.addEventListener('click', handleProbeClick, true);
  }

  syncOperationPanelWidth();
  if (typeof ResizeObserver !== 'undefined') {
    operationPanelResizeObserver = new ResizeObserver(() => {
      syncOperationPanelWidth();
    });
    if (operationPanelRef.value) {
      operationPanelResizeObserver.observe(operationPanelRef.value);
    }
  }

  isRestoringWorkspace.value = true;
  canPersistDbmState.value = false;
  await loadDbmState();
  const initialActiveConnectionIds = getInitialRestoreConnectionIds(dbmState.value);
  const initialOpenTabsState = dbmState.value.openTabsState || {};
  await loadConnections();
  await nextTick();
  if (DBM_AUTO_RESTORE_TABS) {
    operationAreaRef.value?.restoreTabsState?.(initialOpenTabsState, {
      activateRestoredTab: DBM_AUTO_ACTIVATE_RESTORED_TAB
    });
  } else if (Object.keys(initialOpenTabsState).length > 0) {
    dbmState.value.openTabsState = {};
  }
  isRestoringWorkspace.value = false;
  canPersistDbmState.value = true;
  await saveDbmState({ immediate: true });

  if (DBM_AUTO_RESTORE_CONNECTIONS && initialActiveConnectionIds.length) {
    const scheduleRestore = () => {
      restoreConnectionsTimer = window.setTimeout(() => {
        restoreConnectionsTimer = null;
        void connectionListRef.value?.restoreActiveConnections?.(initialActiveConnectionIds);
      }, DBM_CONNECTION_RESTORE_DELAY_MS);
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      restoreConnectionsFrame = window.requestAnimationFrame(() => {
        restoreConnectionsFrame = null;
        scheduleRestore();
      });
    } else {
      scheduleRestore();
    }
  }
});

onBeforeUnmount(() => {
  if (showInteractionProbe) {
    document.removeEventListener('pointermove', handleProbePointerMove, true);
    document.removeEventListener('click', handleProbeClick, true);
  }

  if (operationPanelResizeObserver) {
    operationPanelResizeObserver.disconnect();
    operationPanelResizeObserver = null;
  }

  if (restoreConnectionsFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(restoreConnectionsFrame);
    restoreConnectionsFrame = null;
  }

  if (restoreConnectionsTimer) {
    clearTimeout(restoreConnectionsTimer);
    restoreConnectionsTimer = null;
  }

  if (dbmStateSaveTimer) {
    clearTimeout(dbmStateSaveTimer);
    dbmStateSaveTimer = null;
  }
});

watch(
  () => sidebarWidth.value,
  (value) => {
    const normalized = normalizeSidebarWidth(value);
    if (sidebarWidth.value !== normalized) {
      sidebarWidth.value = normalized;
      return;
    }

    dbmState.value.sidebarWidth = normalized;

    if (!isTauriRuntime) {
      return;
    }

    if (sidebarWidthSaveTimer) {
      clearTimeout(sidebarWidthSaveTimer);
    }

    sidebarWidthSaveTimer = setTimeout(() => {
      sidebarWidthSaveTimer = null;
      void saveDbmState();
    }, 180);
  }
);
</script>

<style scoped>
.dbm-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--el-bg-color);
}

.dbm-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.connection-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.operation-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.resize-handle {
  position: relative;
  width: 10px;
  margin: 0 -4px;
  flex-shrink: 0;
  background: transparent;
  cursor: col-resize;
  user-select: none;
  touch-action: none;
  z-index: 5;
}

.resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--layout-border-color);
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}

.resize-handle:hover::before,
.resize-handle.dragging::before {
  background: color-mix(in srgb, var(--el-color-primary) 72%, white 28%);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 14%, transparent);
}

.interaction-probe {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 9999;
  min-width: 220px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--el-bg-color) 88%, black 12%);
  border: 1px solid color-mix(in srgb, var(--layout-border-color) 86%, transparent 14%);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
  color: var(--el-text-color-regular);
  font-size: 11px;
  line-height: 1.45;
  pointer-events: none;
  backdrop-filter: blur(10px);
}

.interaction-probe-title {
  margin-bottom: 4px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

</style>

<style>
.dbm-connection-drawer-mask {
  background: transparent !important;
  backdrop-filter: none;
}

.dbm-connection-drawer {
  box-shadow: -2px 0 10px rgb(15 23 42 / 0.05) !important;
}

.dbm-connection-drawer .el-drawer__body {
  display: flex;
  min-height: 0;
  padding-top: 12px;
}
</style>
