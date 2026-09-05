<template>
  <div class="operation-area">
    <div class="dbm-toolbar">
      <div class="toolbar-group toolbar-group-left">
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!connection || !supportsQueryWorkbench"
          @click="openQueryWorkbench"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarQueryWorkbenchSvg"></span>
            <span>{{ t('toolbar.queryWorkbench') }}</span>
          </div>
        </el-button>
      </div>

      <div class="toolbar-group toolbar-group-center">
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canImportDatabase"
          @click="handleImportDatabase"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarImportDatabaseSvg"></span>
            <span>{{ t('toolbar.importDatabase') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canExportDatabase"
          @click="handleExportDatabase"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarExportDatabaseSvg"></span>
            <span>{{ t('toolbar.exportDatabase') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canImportTable"
          @click="handleImportTable"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarImportTableSvg"></span>
            <span>{{ t('toolbar.importTable') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canExportTableFromToolbar"
          @click="handleExportSelectedTable"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarExportTableSvg"></span>
            <span>{{ t('toolbar.exportTable') }}</span>
          </div>
        </el-button>
      </div>

      <div class="toolbar-group toolbar-group-right">
        <el-button
          class="toolbar-button"
          type="default"
          @click="openBackupCenter"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarBackupCenterSvg"></span>
            <span>{{ t('toolbar.backupCenter') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canOpenSyncCenter"
          @click="openSyncCenter"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarSyncCenterSvg"></span>
            <span>{{ t('toolbar.syncCenter') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          @click="openAiDashboard"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarQueryWorkbenchSvg"></span>
            <span>{{ t('toolbar.aiDashboard') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canOpenDataDictionary"
          @click="openDataDictionary"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarExportTableSvg"></span>
            <span>{{ t('toolbar.dataDictionary') }}</span>
          </div>
        </el-button>
        <el-button
          class="toolbar-button"
          type="default"
          :disabled="!canOpenUserManager"
          @click="openUserManager"
        >
          <div class="toolbar-button-content">
            <span class="toolbar-icon" aria-hidden="true" v-html="toolbarUserManageSvg"></span>
            <span>{{ t('toolbar.userManager') }}</span>
          </div>
        </el-button>
      </div>
    </div>

    <div class="operation-main">
      <div v-if="!connection" class="empty-state">
        <el-empty :description="t('empty.selectConnection')" />
      </div>

      <!-- 每个连接独立一组tabs，用v-show切换 -->
      <div
        v-for="connId in Object.keys(connectionTabsMap)"
        :key="connId"
        v-show="connection && connection.id === connId"
        class="connected-state"
      >
        <el-tabs class="tabs-container"
          v-model="connectionTabsMap[connId].activeTab"
          type="border-card"
          closable
          @tab-remove="(name: string) => removeTab(connId, name)"
          @tab-click="(tab: any) => handleTabClick(connId, tab)"
        >
          <!-- 主页标签 -->
          <el-tab-pane
            name="home"
            :label="t('home.title')"
            :closable="false"
          >
            <div class="database-info px-10px py-15px">
              <el-card class="info-card" shadow="none">
                <template #header>
                  <div class="card-header">
                    <span>{{ t('home.connectionInfo') }}</span>
                  </div>
                </template>
                <el-descriptions :column="1" border>
                  <el-descriptions-item :label="t('home.connectionName')">{{ getConnInfo(connId)?.name || t('home.notAvailable') }}</el-descriptions-item>
                  <el-descriptions-item :label="t('home.databaseType')">{{ getConnectionTypeLabel(getConnInfo(connId)?.db_type) }}</el-descriptions-item>
                  <el-descriptions-item :label="t('home.host')">{{ getConnInfo(connId)?.host || t('home.notAvailable') }}</el-descriptions-item>
                  <el-descriptions-item :label="t('home.port')">{{ getConnInfo(connId)?.port || t('home.notAvailable') }}</el-descriptions-item>
                  <el-descriptions-item :label="t('home.username')">{{ getConnInfo(connId)?.username || t('home.notAvailable') }}</el-descriptions-item>
                  <el-descriptions-item :label="t('home.databaseName')">{{ getConnInfo(connId)?.database || t('home.notAvailable') }}</el-descriptions-item>
                </el-descriptions>
              </el-card>
            </div>
          </el-tab-pane>

          <!-- 动态标签页 -->
          <el-tab-pane
            v-for="tab in connectionTabsMap[connId].tabs"
            :key="tab.kind === 'query' ? `${tab.name}:${tab.queryResetToken || 0}` : tab.name"
            :label="tab.title"
            :name="tab.name"
            lazy
          >
            <div
              v-if="!canRenderTabContent(tab)"
              class="tab-restore-placeholder"
            >
              <el-empty :description="t('tabRestoring')" :image-size="72" />
            </div>
            <DbQueryWorkbench
              v-else-if="tab.kind === 'query'"
              :connection-id="tab.connectionId"
              :table-name="tab.tableName"
              :database-name="tab.databaseName"
              :initial-state="tab.queryState"
              :reset-token="tab.queryResetToken || 0"
              @state-changed="(state) => handleQueryStateChanged(connId, tab.name, state)"
            />
            <component
              :is="tab.component"
              v-else
              v-bind="getTabComponentProps(tab)"
              :connection-id="tab.connectionId"
              :table-name="tab.tableName"
              :database-name="tab.databaseName"
              :schema-name="tab.schemaName"
              :db-type="getConnInfo(tab.connectionId)?.db_type"
              @close="closeTab(connId, tab.name)"
              @export-table="handleExportTableFromContent"
              @created-table="(payload) => handleCreatedTable(connId, tab.name, payload)"
              @refresh-object-list="handleRefreshObjectList"
            />
          </el-tab-pane>
        </el-tabs>
      </div>
    </div>

    <ExportDatabaseDialog
      v-if="exportDatabaseDialogVisible"
      v-model="exportDatabaseDialogVisible"
      :tables="exportTables"
      @confirm="handleExportDatabaseConfirm"
    />

    <singleTableExport
      v-if="singleTableExportVisible"
      v-model="singleTableExportVisible"
      :connection-id="selectedTableContext?.connectionId || ''"
      :database-name="selectedTableContext?.databaseName"
      :schema-name="selectedTableContext?.schemaName"
      :table-name="selectedTableContext?.tableName || ''"
    />

    <DbUserManagerDialog
      v-if="userManagerVisible"
      v-model="userManagerVisible"
      :connection="connection"
      :database-name="selectedDatabaseName"
    />

    <DbDataDictionaryDialog
      v-model="dataDictionaryVisible"
      :connection="connection"
      :database-name="selectedDatabaseName || connection?.database || undefined"
      :schema-name="selectedSchemaName"
    />

    <DbBackupCenter
      v-model="backupCenterVisible"
      :preferred-connection-id="connection?.id"
      :preferred-database-name="selectedDatabaseName || connection?.database || undefined"
    />

    <DbSyncCenter
      v-model="syncCenterVisible"
      :preferred-connection-id="connection?.id"
      :preferred-database-name="selectedDatabaseName || connection?.database || undefined"
    />

    <DbAiDashboardDialog
      v-model="aiDashboardVisible"
      :preferred-connection-id="connection?.id"
      :preferred-database-name="selectedDatabaseName || connection?.database || undefined"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, ElOption, ElSelect } from 'element-plus';
import { open } from '@tauri-apps/plugin-dialog';
import { DbmApi, exportMultipleTables, type DbConnection } from './service';
import TableContent from './TableContent.vue';
import TableStruct from './TableStruct.vue';
import ViewDefinition from './ViewDefinition.vue';
import ProcedureDefinition from './ProcedureDefinition.vue';
import DbQueryWorkbench from './DbQueryWorkbench.vue';
import RedisKeyContent from './RedisKeyContent.vue';
import ExportDatabaseDialog from './ExportDatabaseDialog.vue';
import singleTableExport from './singleTableExport.vue';
import DbUserManagerDialog from './DbUserManagerDialog.vue';
import DbBackupCenter from './DbBackupCenter.vue';
import DbDataDictionaryDialog from './DbDataDictionaryDialog.vue';
import DbSyncCenter from './DbSyncCenter.vue';
import DbAiDashboardDialog from './DbAiDashboardDialog.vue';
import type { DbTreeSelection } from './DbmTree.vue';
import type { QueryWorkbenchState } from './queryWorkbenchState';
import { getDbTypeMeta } from './dbTypeMeta';
import toolbarUserManageIconRaw from '@/assets/dbm/toolbar/user-manage.svg?raw';
import toolbarQueryWorkbenchIconRaw from '@/assets/dbm/toolbar/query-workbench.svg?raw';
import toolbarImportDatabaseIconRaw from '@/assets/dbm/toolbar/import-database.svg?raw';
import toolbarExportDatabaseIconRaw from '@/assets/dbm/toolbar/export-database.svg?raw';
import toolbarImportTableIconRaw from '@/assets/dbm/toolbar/import-table.svg?raw';
import toolbarExportTableIconRaw from '@/assets/dbm/toolbar/export-table.svg?raw';
import toolbarBackupCenterIconRaw from '@/assets/dbm/toolbar/backup-center.svg?raw';
import toolbarSyncCenterIconRaw from '@/assets/dbm/toolbar/sync-center.svg?raw';
import { useI18nScope } from '@/platform/i18n';

type DatabaseConnection = DbConnection;
interface TabItem {
  name: string;
  title: string;
  kind: 'table' | 'view' | 'procedure' | 'create-table' | 'create-view' | 'create-procedure' | 'query';
  component: any;
  connectionId: string;
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  queryState?: QueryWorkbenchState | null;
  queryResetToken?: number;
}
interface ConnTabs {
  activeTab: string;
  tabs: TabItem[];
}

type PersistedTabState = {
  name: string;
  title: string;
  kind: TabItem['kind'];
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  connectionId: string;
  queryState?: QueryWorkbenchState | null;
};

type PersistedTabsState = Record<string, { activeTab: string; tabs: PersistedTabState[] }>;
type RestoreTabsOptions = {
  activateRestoredTab?: boolean;
};

const toThemeableToolbarSvg = (svg: string) => svg.replace(/#356A7C/gi, 'currentColor');

const toolbarUserManageSvg = toThemeableToolbarSvg(toolbarUserManageIconRaw);
const toolbarQueryWorkbenchSvg = toThemeableToolbarSvg(toolbarQueryWorkbenchIconRaw);
const toolbarImportDatabaseSvg = toThemeableToolbarSvg(toolbarImportDatabaseIconRaw);
const toolbarExportDatabaseSvg = toThemeableToolbarSvg(toolbarExportDatabaseIconRaw);
const toolbarImportTableSvg = toThemeableToolbarSvg(toolbarImportTableIconRaw);
const toolbarExportTableSvg = toThemeableToolbarSvg(toolbarExportTableIconRaw);
const toolbarBackupCenterSvg = toThemeableToolbarSvg(toolbarBackupCenterIconRaw);
const toolbarSyncCenterSvg = toThemeableToolbarSvg(toolbarSyncCenterIconRaw);
const { t } = useI18nScope('dbm.operationArea');

const props = defineProps<{
  connection: DatabaseConnection | null;
  selectedNode?: DbTreeSelection | null;
}>();

const emit = defineEmits<{
  (e: 'open-table', connectionId: string, tableName: string, databaseName?: string, schemaName?: string): void;
  (e: 'open-schema', schemaName: string): void;
  (e: 'export-table', connectionId: string, tableName: string, databaseName?: string): void;
  (e: 'table-created', connectionId: string, tableName: string, databaseName?: string, schemaName?: string): void;
  (e: 'refresh-object-list', connectionId: string, databaseName: string | undefined, schemaName: string | undefined, objectType: 'tables' | 'views' | 'procedures'): void;
  (e: 'tabs-state-changed', state: PersistedTabsState): void;
}>();

// 每个连接独立的tabs map
const connectionTabsMap = reactive<Record<string, ConnTabs>>({});
// 记录连接信息用于显示
const connectionInfoMap = reactive<Record<string, DatabaseConnection>>({});
const exportDatabaseDialogVisible = ref(false);
const singleTableExportVisible = ref(false);
const userManagerVisible = ref(false);
const dataDictionaryVisible = ref(false);
const backupCenterVisible = ref(false);
const syncCenterVisible = ref(false);
const aiDashboardVisible = ref(false);
const exportTables = ref<string[]>([]);
let lastEmittedTabsStateJson = '';
let tabsStateEmitTimer: ReturnType<typeof setTimeout> | null = null;

// 连接变化时确保有对应的tabs组
watch(() => props.connection, (newVal) => {
  if (newVal && newVal.id && !connectionTabsMap[newVal.id]) {
    connectionTabsMap[newVal.id] = { activeTab: 'home', tabs: [] };
  }
  if (newVal && newVal.id) {
    connectionInfoMap[newVal.id] = { ...newVal };
  }
}, { immediate: true });

const currentSelection = computed(() => {
  if (!props.connection || !props.selectedNode) {
    return null;
  }
  return props.selectedNode.connectionId === props.connection.id ? props.selectedNode : null;
});

const selectedDatabaseName = computed(() => {
  if (!currentSelection.value) {
    return undefined;
  }
  if (currentSelection.value.type === 'database') {
    return currentSelection.value.databaseName || currentSelection.value.label;
  }
  return currentSelection.value.databaseName;
});

const selectedTableContext = computed(() => {
  if (!currentSelection.value || currentSelection.value.type !== 'table') {
    return null;
  }
  return {
    connectionId: currentSelection.value.connectionId,
    databaseName: currentSelection.value.databaseName,
    schemaName: currentSelection.value.schemaName,
    tableName: currentSelection.value.tableName || currentSelection.value.label
  };
});

const selectedSchemaName = computed(() => {
  if (!currentSelection.value) {
    return undefined;
  }
  if (currentSelection.value.type === 'schema') {
    return currentSelection.value.schemaName || currentSelection.value.label;
  }
  return currentSelection.value.schemaName;
});

const canImportDatabase = computed(() =>
  !!props.connection
  && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
  && currentSelection.value?.type === 'database'
  && !!selectedDatabaseName.value
);
const canExportDatabase = computed(() =>
  !!props.connection
  && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
  && currentSelection.value?.type === 'database'
  && !!selectedDatabaseName.value
);
const canImportTable = computed(() =>
  !!selectedTableContext.value && !!props.connection && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
);
const canExportTableFromToolbar = computed(() =>
  !!selectedTableContext.value && !!props.connection && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
);
const supportsQueryWorkbench = computed(() =>
  !!props.connection && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
);
const canOpenDataDictionary = computed(() =>
  !!props.connection
  && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'dameng', 'sqlite', 'oracle'].includes(props.connection.db_type)
  && !!(selectedDatabaseName.value || props.connection.database)
);
const canOpenSyncCenter = computed(() =>
  !!props.connection && ['mysql', 'mariadb', 'sqlite', 'oracle', 'sqlserver', 'kingbasees', 'dameng'].includes(props.connection.db_type)
);
const canOpenUserManager = computed(() =>
  !!props.connection && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'oracle', 'dameng'].includes(props.connection.db_type)
);

const getConnInfo = (connId: string) => connectionInfoMap[connId] || null;

const isConnectionReady = (connectionId: string) => !!getConnInfo(connectionId)?.isConnected;

const canRenderTabContent = (tab: TabItem) => {
  if (tab.kind === 'query' || tab.kind === 'create-table' || tab.kind === 'create-view' || tab.kind === 'create-procedure') {
    return true;
  }

  return isConnectionReady(tab.connectionId);
};

const getTabComponentProps = (tab: TabItem) => {
  if (tab.kind === 'create-table') {
    return {
      mode: 'create'
    };
  }

  return {};
};

const getConnectionTypeLabel = (type?: string) =>
  type ? getDbTypeMeta(type).label : t('unknownType');

const resolveTableComponent = (connectionId: string) => {
  const dbType = getConnInfo(connectionId)?.db_type;
  if (dbType === 'redis') {
    return RedisKeyContent;
  }
  return TableContent;
};

const ensureConnTabs = (connectionId: string) => {
  if (!connectionTabsMap[connectionId]) {
    connectionTabsMap[connectionId] = { activeTab: 'home', tabs: [] };
  }
  return connectionTabsMap[connectionId];
};

const scheduleTabsStateChangedEmit = () => {
  if (tabsStateEmitTimer) {
    clearTimeout(tabsStateEmitTimer);
  }

  tabsStateEmitTimer = setTimeout(() => {
    tabsStateEmitTimer = null;
    emitTabsStateChangedIfNeeded();
  }, 80);
};

const resetQueryTabViewState = (queryState?: QueryWorkbenchState | null): QueryWorkbenchState => ({
  sqlContent: queryState?.sqlContent || '',
  queryHistory: queryState?.queryHistory || [],
  resultSummary: null,
  errorMessage: '',
  aiSidebarWidth: queryState?.aiSidebarWidth
});

const formatObjectTabTitle = (prefix: string, name: string, schemaName?: string) =>
  schemaName ? `${prefix}${schemaName}.${name}` : `${prefix}${name}`;

const buildSchemaScopedTabKey = (
  prefix: string,
  connectionId: string,
  databaseName?: string,
  schemaName?: string,
  objectName?: string
) =>
  [prefix, connectionId, databaseName || 'default', schemaName || 'default', objectName || '']
    .join('_');

const handleOpenTable = (
  connectionId: string,
  tableName: string,
  databaseName?: string,
  schemaName?: string
) => {
  if (!connectionId || !tableName) return;
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('table', connectionId, databaseName, schemaName, tableName);
  const existing = connTabs.tabs.find(t => t.name === tabName);
  if (existing) {
    connTabs.activeTab = tabName;
    scheduleTabsStateChangedEmit();
    return;
  }
  connTabs.tabs.push({
    name: tabName,
    title: schemaName ? `${schemaName}.${tableName}` : tableName,
    kind: 'table',
    component: resolveTableComponent(connectionId),
    connectionId,
    tableName,
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleOpenView = (
  connectionId: string,
  viewName: string,
  databaseName?: string,
  schemaName?: string
) => {
  if (!connectionId || !viewName) return;
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('view', connectionId, databaseName, schemaName, viewName);
  const existing = connTabs.tabs.find(t => t.name === tabName);
  if (existing) {
    connTabs.activeTab = tabName;
    scheduleTabsStateChangedEmit();
    return;
  }
  connTabs.tabs.push({
    name: tabName,
    title: formatObjectTabTitle('[V] ', viewName, schemaName),
    kind: 'view',
    component: ViewDefinition,
    connectionId,
    tableName: viewName,
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleOpenProcedure = (
  connectionId: string,
  procedureName: string,
  databaseName?: string,
  schemaName?: string
) => {
  if (!connectionId || !procedureName) return;
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('proc', connectionId, databaseName, schemaName, procedureName);
  const existing = connTabs.tabs.find(t => t.name === tabName);
  if (existing) {
    connTabs.activeTab = tabName;
    scheduleTabsStateChangedEmit();
    return;
  }
  connTabs.tabs.push({
    name: tabName,
    title: formatObjectTabTitle('[P] ', procedureName, schemaName),
    kind: 'procedure',
    component: ProcedureDefinition,
    connectionId,
    tableName: procedureName,
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleExportTable = (
  connectionId: string,
  tableName: string,
  databaseName?: string,
  schemaName?: string
) => {
  if (!connectionId || !tableName) return;
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('table', connectionId, databaseName, schemaName, tableName);
  const existing = connTabs.tabs.find(t => t.name === tabName);
  if (!existing) {
    handleOpenTable(connectionId, tableName, databaseName, schemaName);
  } else {
    connTabs.activeTab = tabName;
    scheduleTabsStateChangedEmit();
  }
  setTimeout(() => emit('export-table', connectionId, tableName, databaseName), 100);
};

const handleCreateView = (connectionId: string, databaseName: string, schemaName?: string) => {
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('create_view', connectionId, databaseName, schemaName, String(Date.now()));
  connTabs.tabs.push({
    name: tabName,
    title: schemaName ? t('tabTitles.createViewWithSchema', { schemaName }) : t('tabTitles.createView'),
    kind: 'create-view',
    component: ViewDefinition,
    connectionId,
    tableName: '',
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleCreateTable = (connectionId: string, databaseName: string, schemaName?: string) => {
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('create_table', connectionId, databaseName, schemaName, String(Date.now()));
  connTabs.tabs.push({
    name: tabName,
    title: schemaName ? t('tabTitles.createTableWithSchema', { schemaName }) : t('tabTitles.createTable'),
    kind: 'create-table',
    component: TableStruct,
    connectionId,
    tableName: '',
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleCreateProcedure = (connectionId: string, databaseName: string, schemaName?: string) => {
  const connTabs = ensureConnTabs(connectionId);
  const tabName = buildSchemaScopedTabKey('create_proc', connectionId, databaseName, schemaName, String(Date.now()));
  connTabs.tabs.push({
    name: tabName,
    title: schemaName ? t('tabTitles.createProcedureWithSchema', { schemaName }) : t('tabTitles.createProcedure'),
    kind: 'create-procedure',
    component: ProcedureDefinition,
    connectionId,
    tableName: '',
    databaseName,
    schemaName
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleCreatedTable = (
  connId: string,
  sourceTabName: string,
  payload: { connectionId: string; databaseName?: string; schemaName?: string; tableName: string }
) => {
  removeTab(connId, sourceTabName);
  handleOpenTable(payload.connectionId, payload.tableName, payload.databaseName, payload.schemaName);
  emit('table-created', payload.connectionId, payload.tableName, payload.databaseName, payload.schemaName);
};

const handleRefreshObjectList = (payload: {
  connectionId: string;
  databaseName?: string;
  schemaName?: string;
  objectType: 'tables' | 'views' | 'procedures';
}) => {
  emit('refresh-object-list', payload.connectionId, payload.databaseName, payload.schemaName, payload.objectType);
};

const openQueryWorkbench = () => {
  if (!props.connection) {
    return;
  }

  const connectionId = props.connection.id;
  const databaseName = selectedDatabaseName.value || props.connection.database || undefined;
  const connTabs = ensureConnTabs(connectionId);
  const databaseKey = databaseName || 'default';
  const existingQueryTabs = connTabs.tabs.filter(
    (item) => item.kind === 'query' && (item.databaseName || 'default') === databaseKey
  );
  const preservedQueryState = existingQueryTabs.length
    ? resetQueryTabViewState(existingQueryTabs[0].queryState)
    : undefined;

  if (existingQueryTabs.length) {
    const existingNames = new Set(existingQueryTabs.map((item) => item.name));
    connTabs.tabs = connTabs.tabs.filter((item) => !existingNames.has(item.name));
  }

  const tabName = `query_${connectionId}_${databaseKey}_${Date.now()}`;

  connTabs.tabs.push({
    name: tabName,
    title: databaseName ? t('tabTitles.queryWithDatabase', { databaseName }) : t('tabTitles.query'),
    kind: 'query',
    component: DbQueryWorkbench,
    connectionId,
    tableName: '',
    databaseName,
    queryState: preservedQueryState,
    queryResetToken: 0
  });
  connTabs.activeTab = tabName;
  scheduleTabsStateChangedEmit();
};

const handleExportTableFromContent = (connectionId: string, tableName: string, databaseName?: string) => {
  emit('export-table', connectionId, tableName, databaseName);
};

const openUserManager = () => {
  if (!canOpenUserManager.value) {
    ElMessage.warning(t('messages.userManagerUnsupported'));
    return;
  }
  userManagerVisible.value = true;
};

const openDataDictionary = () => {
  if (!canOpenDataDictionary.value) {
    return;
  }
  dataDictionaryVisible.value = true;
};

const openBackupCenter = () => {
  backupCenterVisible.value = true;
};

const openSyncCenter = () => {
  if (!canOpenSyncCenter.value) {
    return;
  }
  syncCenterVisible.value = true;
};

const openAiDashboard = () => {
  aiDashboardVisible.value = true;
};

const handleExportDatabase = async () => {
  if (!props.connection || !selectedDatabaseName.value) {
    return;
  }

  try {
    const tables = await DbmApi.getTables(props.connection.id, selectedDatabaseName.value);
    if (!tables.length) {
      ElMessage.warning(t('messages.databaseHasNoTables'));
      return;
    }
    exportTables.value = tables;
    exportDatabaseDialogVisible.value = true;
  } catch (error) {
    ElMessage.error(t('messages.getTablesFailed', { error: (error as Error).message }));
  }
};

const handleExportDatabaseConfirm = async (payload: {
  selectedTables: string[];
  selectedFormat: 'excel' | 'sql';
}) => {
  if (!props.connection || !selectedDatabaseName.value) {
    return;
  }
  if (!payload.selectedTables.length) {
    ElMessage.warning(t('messages.selectAtLeastOneTable'));
    return;
  }

  exportDatabaseDialogVisible.value = false;
  try {
    const taskId = await exportMultipleTables(
      props.connection.id,
      selectedDatabaseName.value,
      payload.selectedTables,
      payload.selectedFormat,
      undefined,
      selectedSchemaName.value
    );
    ElMessage.success(t('messages.exportTaskStarted', { taskId }));
  } catch (error) {
    ElMessage.error(t('messages.startExportFailed', { error: (error as Error).message }));
  }
};

const handleImportDatabase = async () => {
  if (!props.connection || !selectedDatabaseName.value) {
    return;
  }

  try {
    const selectedPath = await open({
      filters: [{ name: t('filters.sqlFiles'), extensions: ['sql'] }],
      multiple: false
    });

    if (!selectedPath) {
      return;
    }

    const taskId = await DbmApi.importDatabaseFromSql(
      props.connection.id,
      selectedDatabaseName.value,
      Array.isArray(selectedPath) ? selectedPath[0] : selectedPath
    );
    ElMessage.success(t('messages.importDatabaseStarted', { taskId }));
  } catch (error) {
    ElMessage.error(t('messages.importDatabaseFailed', { error: (error as Error).message }));
  }
};

const handleExportSelectedTable = () => {
  if (!selectedTableContext.value) {
    return;
  }
  singleTableExportVisible.value = true;
};

const handleImportTable = async () => {
  if (!selectedTableContext.value) {
    return;
  }

  try {
    const selectedPath = await open({
      filters: [
        {
          name: t('filters.dataFiles'),
          extensions: ['csv', 'xlsx', 'xls', 'sql']
        }
      ],
      multiple: false
    });

    if (!selectedPath) {
      return;
    }

    const filePath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
    const fileExtension = filePath.split('.').pop()?.toLowerCase();

    if (fileExtension === 'sql') {
      const taskId = await DbmApi.importTableFromSql(
        selectedTableContext.value.connectionId,
        selectedTableContext.value.databaseName || '',
        selectedTableContext.value.tableName,
        filePath,
        selectedTableContext.value.schemaName
      );
      ElMessage.success(t('messages.importTableStarted', { taskId }));
      return;
    }

    const tableStruct = await DbmApi.getTableStruct(
      selectedTableContext.value.connectionId,
      selectedTableContext.value.databaseName,
      selectedTableContext.value.tableName,
      selectedTableContext.value.schemaName
    );
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
                      style: 'width: 220px; margin-left: 10px;'
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
        width: '720px'
      });
    } catch {
      return;
    }

    const taskId = await DbmApi.importTableFromDataFile(
      selectedTableContext.value.connectionId,
      selectedTableContext.value.databaseName || '',
      selectedTableContext.value.tableName,
      filePath,
      columnMappings.value,
      selectedTableContext.value.schemaName
    );
    ElMessage.success(t('messages.importTableStarted', { taskId }));
  } catch (error) {
    ElMessage.error(t('messages.importTableFailed', { error: (error as Error).message }));
  }
};

const removeTab = (connId: string, targetName: string) => {
  if (targetName === 'home') return;
  const connTabs = connectionTabsMap[connId];
  if (!connTabs) return;
  connTabs.tabs = connTabs.tabs.filter(t => t.name !== targetName);
  if (connTabs.activeTab === targetName) connTabs.activeTab = 'home';
  scheduleTabsStateChangedEmit();
};

const closeTab = (connId: string, tabName: string) => removeTab(connId, tabName);

const handleTabClick = (connId: string, tab: any) => {
  const connTabs = connectionTabsMap[connId];
  if (connTabs) {
    connTabs.activeTab = tab.paneName || tab.name;
    scheduleTabsStateChangedEmit();
  }
};

const handleQueryStateChanged = (connId: string, tabName: string, queryState: QueryWorkbenchState) => {
  const connTabs = connectionTabsMap[connId];
  const tab = connTabs?.tabs.find((item) => item.name === tabName && item.kind === 'query');
  if (!tab) {
    return;
  }

  const nextJson = JSON.stringify(queryState);
  const currentJson = JSON.stringify(tab.queryState || null);
  if (nextJson === currentJson) {
    return;
  }

  tab.queryState = queryState;
  scheduleTabsStateChangedEmit();
};

// 获取已打开的tabs信息用于持久化
const getOpenTabsState = (): PersistedTabsState => {
  const result: PersistedTabsState = {};
  for (const [connId, connTabs] of Object.entries(connectionTabsMap)) {
    result[connId] = {
      activeTab: connTabs.activeTab,
      tabs: connTabs.tabs.map(t => ({
        name: t.name,
        title: t.title,
        kind: t.kind,
        tableName: t.tableName,
        databaseName: t.databaseName,
        schemaName: t.schemaName,
        connectionId: t.connectionId,
        queryState: t.kind === 'query' ? (t.queryState || null) : undefined
      }))
    };
  }
  return result;
};

const emitTabsStateChangedIfNeeded = () => {
  const nextState = getOpenTabsState();
  const nextJson = JSON.stringify(nextState);
  if (nextJson === lastEmittedTabsStateJson) {
    return;
  }
  lastEmittedTabsStateJson = nextJson;
  emit('tabs-state-changed', nextState);
};

// 恢复tabs
const restoreTabsState = (state: PersistedTabsState, options: RestoreTabsOptions = {}) => {
  const activateRestoredTab = options.activateRestoredTab ?? true;
  const componentByKind: Record<TabItem['kind'], any> = {
    table: TableContent,
    view: ViewDefinition,
    procedure: ProcedureDefinition,
    'create-table': TableStruct,
    'create-view': ViewDefinition,
    'create-procedure': ProcedureDefinition,
    query: DbQueryWorkbench
  };

  for (const [connId, data] of Object.entries(state)) {
    const connTabs = ensureConnTabs(connId);
    for (const t of data.tabs) {
      if (!connTabs.tabs.find(x => x.name === t.name)) {
        connTabs.tabs.push({
          name: t.name,
          title: t.title,
          kind: t.kind,
          component: t.kind === 'table' ? resolveTableComponent(t.connectionId) : componentByKind[t.kind],
          connectionId: t.connectionId,
          tableName: t.tableName,
          databaseName: t.databaseName,
          schemaName: t.schemaName,
          queryState: t.kind === 'query' ? (t.queryState || null) : undefined
        });
      }
    }
    const hasActiveTab = data.activeTab === 'home' || connTabs.tabs.some((tab) => tab.name === data.activeTab);
    connTabs.activeTab = activateRestoredTab && hasActiveTab ? data.activeTab : 'home';
  }
  scheduleTabsStateChangedEmit();
};

defineExpose({ handleOpenTable, handleOpenView, handleOpenProcedure, handleCreateTable, handleCreateView, handleCreateProcedure, handleExportTable, getOpenTabsState, restoreTabsState });
</script>

<style scoped>
.operation-area {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dbm-toolbar {
  height: 55px;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px;
  border-bottom: 1px solid var(--layout-border-color);
  background: var(--toolbar-bg-color);
  flex-shrink: 0;
}

.toolbar-group {
  display: flex;
  align-items: stretch;
  gap: 0;
}

.toolbar-group-center {
  flex: 1;
  justify-content: center;
}

.toolbar-group-right {
  justify-content: flex-end;
}

.toolbar-button {
  height: 45px;
  margin: 5px 0 0 !important;
  border-width: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  padding: 0 14px !important;
  color: var(--el-text-color-secondary) !important;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.toolbar-button-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: inherit;
  transition: color 0.2s ease;
}

.toolbar-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  color: var(--theme-primary-icon-color);
  opacity: 0.96;
  line-height: 0;
  transition: opacity 0.18s ease, transform 0.18s ease, color 0.18s ease;
}

:deep(.toolbar-icon svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.toolbar-button:not(.is-disabled):hover {
  background: var(--theme-primary-soft-hover) !important;
  color: var(--el-color-primary) !important;
}

.toolbar-button:not(.is-disabled):hover .toolbar-icon {
  color: var(--theme-primary-icon-hover-color);
  transform: translateY(-1px);
}

:deep(.toolbar-button.is-disabled) .toolbar-icon {
  opacity: 0.36;
  color: color-mix(in srgb, var(--el-text-color-disabled) 88%, transparent 12%);
}

:deep(.toolbar-button.is-disabled) {
  color: var(--el-text-color-disabled) !important;
}

.operation-main {
  flex: 1;
  min-height: 0;
}

.tab-restore-placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.connected-state {
  height: 100%;
  min-height: 0;
}

:deep(.el-tabs__header) {
  margin-bottom: 8px;
}

:deep(.tabs-container) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.tabs-container .el-tabs__content) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

:deep(.tabs-container .el-tab-pane) {
  height: 100%;
}
</style>
