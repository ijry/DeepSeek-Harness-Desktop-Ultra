<template>
  <div
    class="connection-list-panel"
    :style="{ '--connection-item-padding-y': `${connectionItemVerticalPadding}px` }"
  >
      <div class="list-header p-2 flex justify-between items-center">
        <div class="list-header-copy">
          <h3 class="list-title text-lg font-semibold mb-0 flex items-center">SharkDBM</h3>
          <div class="list-subtitle">{{ t('subtitle') }}</div>
        </div>
      <el-button 
        type="primary" 
        size="small" 
        @click="emit('add-connection')"
        :icon="Plus"
        circle
        class="add-btn w-18px! h-18px p-2px!"
      >
      </el-button>
    </div>

    <div ref="treeLayoutRef" class="connection-body">
      <div class="connection-list-region">
        <el-scrollbar v-if="displayConnections.length > 0" class="connection-items mt-0px">
          <div
            v-for="connection in displayConnections"
            :key="connection.id"
            class="connection-item-group"
          >
            <div
              class="connection-item cursor-pointer"
              :class="{
                active: selectedConnection?.id === connection.id,
                'is-busy': isConnectionBusy(connection.id)
              }"
              @click="handleConnectionClick(connection)"
              @dblclick="handleConnectionDoubleClick(connection)"
            >
              <div class="connection-info">
                <div class="connection-heading">
                  <span
                    class="db-type-logo"
                    :style="getDbTypeLogoStyle(connection.db_type)"
                    :class="getConnectionLogoClass(connection)"
                  >
                    <component
                      :is="getDbTypeMeta(connection.db_type).iconComponent"
                      v-if="getDbTypeMeta(connection.db_type).iconComponent"
                      v-bind="getDbTypeMeta(connection.db_type).iconProps"
                      aria-hidden="true"
                      class="db-type-logo-image"
                    />
                    <span v-else>{{ getDbTypeMeta(connection.db_type).logoText }}</span>
                  </span>
                  <div class="connection-title-group">
                    <div class="connection-title-row">
                      <div class="connection-title">{{ connection.name }}</div>
                      <div class="connection-actions" @click.stop>
                        <el-dropdown @command="handleCommand" trigger="click" :disabled="isConnectionBusy(connection.id)">
                          <span
                            class="connection-smart-control"
                            :class="getConnectionStateActionClass(connection)"
                            role="button"
                            tabindex="0"
                            @click.stop
                          >
                            <span class="connection-smart-main">
                              <span
                                class="status-dot status-dot-inline"
                                :class="getConnectionStatusDotClass(connection)"
                              ></span>
                              <span class="connection-smart-label">{{ getConnectionStatusLabel(connection) }}</span>
                            </span>
                            <span class="connection-smart-caret">
                              <el-icon class="more-icon"><ArrowDown /></el-icon>
                            </span>
                          </span>
                          <template #dropdown>
                            <el-dropdown-menu>
                              <el-dropdown-item
                                :command="{ action: getPrimaryConnectionAction(connection), data: connection }"
                                :icon="getPrimaryConnectionAction(connection) === 'reconnect' ? RefreshLeft : Promotion"
                                :disabled="isConnectionBusy(connection.id)"
                              >
                                {{ getPrimaryConnectionActionLabel(connection) }}
                              </el-dropdown-item>
                              <el-dropdown-item
                                v-if="connection.isConnected"
                                :command="{ action: 'disconnect', data: connection }"
                                :icon="CircleClose"
                                :disabled="isConnectionBusy(connection.id)"
                              >
                                {{ t('actions.disconnect') }}
                              </el-dropdown-item>
                              <el-dropdown-item :command="{ action: 'edit', data: connection }" :icon="Edit" :disabled="isConnectionBusy(connection.id)">
                                {{ t('actions.edit') }}
                              </el-dropdown-item>
                              <el-dropdown-item
                                :command="{ action: 'delete', data: connection }"
                                :icon="Delete"
                                divided
                                :disabled="isConnectionBusy(connection.id)"
                              >
                                {{ t('actions.delete') }}
                              </el-dropdown-item>
                            </el-dropdown-menu>
                          </template>
                        </el-dropdown>
                      </div>
                    </div>
                    <div class="connection-subtitle" :title="getConnectionSubtitle(connection)">
                      {{ getConnectionSubtitle(connection) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-scrollbar>

        <div v-else-if="loading" class="loading p-2">
          <el-skeleton animated>
            <template #template>
              <el-skeleton-item variant="text" style="width: 60%" />
              <el-skeleton-item variant="text" style="width: 80%" />
            </template>
          </el-skeleton>
        </div>

        <div v-else class="empty p-2">
          <el-empty :description="t('empty.noConnections')" />
        </div>
      </div>

      <div
        v-if="showTreePanel"
        class="tree-panel-resizer"
        v-show="treePanelVisible"
        :class="{ dragging: treePanelResizing }"
        @pointerdown="startTreePanelResize"
        @dblclick="resetTreePanelHeight"
      >
        <div v-if="treePanelResizing" class="tree-resize-tooltip">{{ treePanelPercent }}%</div>
      </div>

      <div v-if="showTreePanel" v-show="treePanelVisible" class="tree-panel" :style="{ height: `${treePanelHeight}px` }">
        <div class="tree-panel-header">
          <div class="tree-panel-title-group flex items-center">
            <div class="tree-panel-title mr-10px">{{ t('tree.title') }}</div>
            <div class="tree-panel-subtitle">
              {{ activeTreeConnection?.name }}
            </div>
          </div>
        </div>
        <div class="tree-panel-content">
          <div
            v-for="connection in connectedConnections"
            v-show="selectedConnection?.id === connection.id"
            :key="connection.id"
            class="tree-panel-view"
          >
            <DbmTree
              :ref="(el: any) => setDbmTreeRef(connection.id!, el)"
              :connection="connection"
              :is-connected="connection.isConnected"
              :initial-pinned-tables="pinnedTablesMap?.[connection.id!] || []"
              :initial-filter-text="filterTextsMap?.[connection.id!] || ''"
              :initial-expanded-keys="expandedKeysMap?.[connection.id!] || []"
              :initial-selected-node="selectedTreeNode?.connectionId === connection.id ? selectedTreeNode : null"
              @open-table="(connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => handleTreeOpenTable(connection, connectionId, tableName, databaseName, schemaName)"
              @open-view="(connectionId: string, viewName: string, databaseName?: string, schemaName?: string) => handleTreeOpenView(connection, connectionId, viewName, databaseName, schemaName)"
              @open-procedure="(connectionId: string, procedureName: string, databaseName?: string, schemaName?: string) => handleTreeOpenProcedure(connection, connectionId, procedureName, databaseName, schemaName)"
              @export-table="(connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => handleTreeExportTable(connection, connectionId, tableName, databaseName, schemaName)"
              @create-table="(id: string, db: string, schema?: string) => emit('create-table', id, db, schema)"
              @create-view="(id: string, db: string, schema?: string) => emit('create-view', id, db, schema)"
              @create-procedure="(id: string, db: string, schema?: string) => emit('create-procedure', id, db, schema)"
              @drop-table="(id: string, name: string, db: string, schema?: string) => emit('drop-table', id, name, db, schema)"
              @drop-view="(id: string, name: string, db: string, schema?: string) => emit('drop-view', id, name, db, schema)"
              @drop-procedure="(id: string, name: string, db: string, schema?: string) => emit('drop-procedure', id, name, db, schema)"
              @pinned-changed="(pinned: any[]) => handlePinnedChanged(connection.id!, pinned)"
              @filter-changed="(filterState: DbTreeFilterState) => emit('filter-changed', connection.id!, filterState)"
              @select-node="(selection: any) => handleTreeSelectNode(connection, selection)"
              @expanded-keys-changed="(keys: string[]) => emit('expanded-keys-changed', connection.id!, keys)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 查看后台任务按钮 -->
    <div class="task-panel-button p-2">
      <el-button 
        type="default" 
        size="small" 
        @click="showTaskPanel"
        class="w-full"
      >
        {{ t('actions.showTasks') }}
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { DbmApi, extractDbmErrorMessage, type DbConnection } from './service';
import { Plus, Edit, Delete, Promotion, CircleClose, RefreshLeft, ArrowDown } from '@element-plus/icons-vue';
import DbmTree from './DbmTree.vue';
import { getDbTypeMeta } from './dbTypeMeta';
import type { DbTreeFilterState, DbTreeSelection } from './DbmTree.vue';
import { useDragResize } from '@/platform/ui/common/useDragResize';
import { useI18nScope } from '@/platform/i18n';

type DatabaseConnection = DbConnection;
type ConnectionAction = 'connect' | 'disconnect' | 'reconnect' | null;

const props = defineProps<{
  selectedConnection: DatabaseConnection | null;
  selectedTreeNode?: DbTreeSelection | null;
  pinnedTablesMap?: Record<string, any[]>;
  filterTextsMap?: Record<string, string | string[] | DbTreeFilterState>;
  expandedKeysMap?: Record<string, string[]>;
}>();

const emit = defineEmits<{
  (e: 'select-connection', connection: DatabaseConnection): void;
  (e: 'add-connection'): void;
  (e: 'edit-connection', connection: DatabaseConnection): void;
  (e: 'delete-connection', id: string): void;
  (e: 'open-table', connectionId: string, tableName: string, databaseName: string, schemaName?: string): void;
  (e: 'open-view', connectionId: string, viewName: string, databaseName?: string, schemaName?: string): void;
  (e: 'open-procedure', connectionId: string, procedureName: string, databaseName?: string, schemaName?: string): void;
  (e: 'export-table', connectionId: string, tableName: string, databaseName?: string, schemaName?: string): void;
  (e: 'create-table', connectionId: string, databaseName: string, schemaName?: string): void;
  (e: 'create-view', connectionId: string, databaseName: string, schemaName?: string): void;
  (e: 'create-procedure', connectionId: string, databaseName: string, schemaName?: string): void;
  (e: 'drop-table', connectionId: string, tableName: string, databaseName: string, schemaName?: string): void;
  (e: 'drop-view', connectionId: string, viewName: string, databaseName: string, schemaName?: string): void;
  (e: 'drop-procedure', connectionId: string, procedureName: string, databaseName: string, schemaName?: string): void;
  (e: 'pinned-changed', connectionId: string, pinnedTables: any[]): void;
  (e: 'filter-changed', connectionId: string, filterState: DbTreeFilterState): void;
  (e: 'show-task-panel'): void;
  (e: 'select-node', selection: DbTreeSelection): void;
  (e: 'active-connections-changed', activeConnectionIds: string[]): void;
  (e: 'expanded-keys-changed', connectionId: string, expandedKeys: string[]): void;
}>();

const connections = ref<DatabaseConnection[]>([]);
const loading = ref(false);
const dbmTreeRefs = ref<Record<string, any>>({});
const busyConnectionId = ref<string | null>(null);
const busyAction = ref<ConnectionAction>(null);
const failedConnectionIds = ref<Record<string, true>>({});
const connectionAttemptVersions = ref<Record<string, number>>({});
const treeLayoutRef = ref<HTMLElement | null>(null);
const treeLayoutHeight = ref(0);
const treePanelHeightOverride = ref<number | null>(null);
const RESTORE_CONNECTION_TIMEOUT_MS = 8000;
const SQL_SERVER_CONNECTION_TIMEOUT_MS = 15000; // SQL Server 连接超时时间：15 秒
const CONNECTION_LIST_MIN_HEIGHT = 148;
const TREE_PANEL_MIN_HEIGHT = 176;
const TREE_PANEL_HANDLE_HEIGHT = 8;
const TREE_PANEL_DEFAULT_RATIO = 0.6;
const CONNECTION_ITEM_BASE_VERTICAL_PADDING = 8;
const CONNECTION_ITEM_MIN_VERTICAL_PADDING = 3;
const { t } = useI18nScope('dbm.connectionList');
let treeLayoutResizeObserver: ResizeObserver | null = null;
let usingWindowResizeFallback = false;

const connectedConnections = computed(() =>
  connections.value.filter((connection) => !!connection.id && !!connection.isConnected)
);

const displayConnections = computed(() => {
  return connections.value
    .map((connection, index) => ({
      connection,
      index
    }))
    .sort((left, right) => {
      if (!!left.connection.isConnected === !!right.connection.isConnected) {
        return left.index - right.index;
      }
      return left.connection.isConnected ? -1 : 1;
    })
    .map(({ connection }) => connection);
});

const showTreePanel = computed(() => connectedConnections.value.length > 0);

const activeTreeConnection = computed(() => {
  const selectedId = props.selectedConnection?.id;
  if (!selectedId) {
    return null;
  }
  return connectedConnections.value.find((connection) => connection.id === selectedId) || null;
});

const treePanelVisible = computed(() => !!activeTreeConnection.value);

const updateTreeLayoutHeight = () => {
  treeLayoutHeight.value = treeLayoutRef.value?.clientHeight || 0;
};

const treePanelMaxHeight = computed(() => {
  if (!showTreePanel.value) {
    return 0;
  }
  return Math.max(0, treeLayoutHeight.value - CONNECTION_LIST_MIN_HEIGHT - TREE_PANEL_HANDLE_HEIGHT);
});

const treePanelMinHeight = computed(() => Math.min(TREE_PANEL_MIN_HEIGHT, treePanelMaxHeight.value));

const defaultTreePanelHeight = computed(() => {
  const maxValue = treePanelMaxHeight.value;
  if (maxValue <= 0) {
    return 0;
  }
  const preferred = Math.floor(treeLayoutHeight.value * TREE_PANEL_DEFAULT_RATIO);
  return Math.min(Math.max(treePanelMinHeight.value, preferred), maxValue);
});

const treePanelHeight = computed(() => {
  if (!showTreePanel.value) {
    return 0;
  }
  const maxValue = treePanelMaxHeight.value;
  if (maxValue <= 0) {
    return 0;
  }
  const baseValue = treePanelHeightOverride.value ?? defaultTreePanelHeight.value;
  return Math.min(Math.max(treePanelMinHeight.value, baseValue), maxValue);
});

const treePanelPercent = computed(() => {
  if (!showTreePanel.value || treeLayoutHeight.value <= 0) {
    return 0;
  }
  return Math.round((treePanelHeight.value / treeLayoutHeight.value) * 100);
});

const connectionItemVerticalPadding = computed(() => {
  if (!treePanelVisible.value) {
    return CONNECTION_ITEM_BASE_VERTICAL_PADDING;
  }

  const basePadding = CONNECTION_ITEM_BASE_VERTICAL_PADDING;
  const minPadding = CONNECTION_ITEM_MIN_VERTICAL_PADDING;
  const defaultHeight = defaultTreePanelHeight.value;
  const maxHeight = treePanelMaxHeight.value;

  if (maxHeight <= defaultHeight) {
    return basePadding;
  }

  const progress = Math.min(
    1,
    Math.max(0, (treePanelHeight.value - defaultHeight) / (maxHeight - defaultHeight))
  );

  return Number((basePadding - (basePadding - minPadding) * progress).toFixed(2));
});

watch(
  () => [showTreePanel.value, treePanelMaxHeight.value, treePanelMinHeight.value],
  () => {
    if (!showTreePanel.value) {
      treePanelHeightOverride.value = null;
      return;
    }

    if (treePanelHeightOverride.value !== null) {
      treePanelHeightOverride.value = Math.min(
        Math.max(treePanelMinHeight.value, treePanelHeightOverride.value),
        treePanelMaxHeight.value
      );
    }
  }
);

const { startDragging: startTreePanelResize, dragging: treePanelResizing } = useDragResize({
  axis: 'y',
  min: () => treePanelMinHeight.value,
  max: () => Math.max(treePanelMinHeight.value, treePanelMaxHeight.value),
  getInitialValue: () => treePanelHeight.value || defaultTreePanelHeight.value,
  getValueFromPointer: (event, state) => state.startValue - (event.clientY - state.startY),
  onChange: (value) => {
    treePanelHeightOverride.value = value;
  }
});

const handlePinnedChanged = (connectionId: string, pinnedTables: any[]) => {
  emit('pinned-changed', connectionId, pinnedTables);
};

const setDbmTreeRef = (connectionId: string, treeRef: any) => {
  if (!connectionId) {
    return;
  }

  if (treeRef) {
    dbmTreeRefs.value[connectionId] = treeRef;
    return;
  }

  delete dbmTreeRefs.value[connectionId];
};

const getDbmTreeRef = (connectionId: string) => dbmTreeRefs.value[connectionId];

const isConnectionBusy = (connectionId?: string) =>
  !!connectionId && busyConnectionId.value === connectionId;

const isConnectionConnecting = (connectionId?: string) =>
  isConnectionBusy(connectionId) && busyAction.value === 'connect';

const hasConnectionError = (connectionId?: string) =>
  !!connectionId && !!failedConnectionIds.value[connectionId];

const getBusyLabel = (connectionId?: string) => {
  if (!isConnectionBusy(connectionId)) {
    return '';
  }

  switch (busyAction.value) {
    case 'connect':
      return t('busy.connect');
    case 'disconnect':
      return t('busy.disconnect');
    case 'reconnect':
      return t('busy.reconnect');
    default:
      return t('busy.processing');
  }
};

const getConnectionStatusLabel = (connection: DatabaseConnection) => {
  if (isConnectionBusy(connection.id)) {
    return getBusyLabel(connection.id);
  }
  if (hasConnectionError(connection.id)) {
    return t('status.error');
  }
  return connection.isConnected ? t('status.connected') : t('status.disconnected');
};

const getConnectionStatusDotClass = (connection: DatabaseConnection) => {
  if (isConnectionBusy(connection.id)) {
    return 'bg-blue-500 status-dot-busy';
  }
  if (hasConnectionError(connection.id)) {
    return 'bg-red-500';
  }
  return connection.isConnected ? 'bg-green-500' : 'bg-gray-300';
};

const getConnectionStateActionClass = (connection: DatabaseConnection) => {
  if (isConnectionBusy(connection.id)) {
    return 'connection-state-action-busy';
  }
  if (hasConnectionError(connection.id)) {
    return 'connection-state-action-error';
  }
  return connection.isConnected ? 'connection-state-action-online' : 'connection-state-action-offline';
};

const getPrimaryConnectionAction = (connection: DatabaseConnection): 'connect' | 'reconnect' => {
  if (connection.isConnected) {
    return 'reconnect';
  }
  return 'connect';
};

const getPrimaryConnectionActionLabel = (connection: DatabaseConnection) => {
  if (hasConnectionError(connection.id)) {
    return t('actions.retryConnect');
  }
  return connection.isConnected ? t('actions.reconnect') : t('actions.connect');
};

const getConnectionLogoClass = (connection: DatabaseConnection) => {
  if (isConnectionBusy(connection.id)) {
    return 'db-type-logo-busy';
  }
  if (hasConnectionError(connection.id)) {
    return 'db-type-logo-error';
  }
  if (connection.isConnected) {
    return 'db-type-logo-online';
  }
  return 'db-type-logo-offline';
};

const getDbTypeLogoStyle = (dbType?: string) => {
  const meta = getDbTypeMeta(dbType);
  return {
    background: meta.logoBg,
    color: meta.logoColor
  };
};

const getConnectionSubtitle = (connection: DatabaseConnection) => {
  if (connection.db_type === 'sqlite') {
    return connection.database || t('sqliteFileUnset');
  }
  if (connection.username) {
    return `${connection.username}@${connection.host}:${connection.port}`;
  }
  return `${connection.host}:${connection.port}`;
};

const updateConnectionState = (connectionId: string, patch: Partial<DatabaseConnection>) => {
  const index = connections.value.findIndex((item) => item.id === connectionId);
  if (index === -1) {
    return;
  }

  connections.value[index] = {
    ...connections.value[index],
    ...patch
  };
};

const clearConnectionError = (connectionId?: string) => {
  if (!connectionId || !failedConnectionIds.value[connectionId]) {
    return;
  }

  const nextState = { ...failedConnectionIds.value };
  delete nextState[connectionId];
  failedConnectionIds.value = nextState;
};

const markConnectionError = (connectionId?: string) => {
  if (!connectionId) {
    return;
  }

  failedConnectionIds.value = {
    ...failedConnectionIds.value,
    [connectionId]: true
  };
};

const setBusyState = (connectionId: string, action: ConnectionAction) => {
  busyConnectionId.value = connectionId;
  busyAction.value = action;
};

const beginConnectionAttempt = (connectionId: string, action: ConnectionAction) => {
  const nextVersion = (connectionAttemptVersions.value[connectionId] || 0) + 1;
  connectionAttemptVersions.value = {
    ...connectionAttemptVersions.value,
    [connectionId]: nextVersion
  };
  setBusyState(connectionId, action);
  return nextVersion;
};

const isCurrentConnectionAttempt = (connectionId: string, version: number) =>
  connectionAttemptVersions.value[connectionId] === version;

const clearBusyState = (connectionId?: string) => {
  if (connectionId && busyConnectionId.value !== connectionId) {
    return;
  }
  busyConnectionId.value = null;
  busyAction.value = null;
};

const cancelConnectingState = async (connection: DatabaseConnection) => {
  const connectionId = connection.id;
  connectionAttemptVersions.value = {
    ...connectionAttemptVersions.value,
    [connectionId]: (connectionAttemptVersions.value[connectionId] || 0) + 1
  };
  clearBusyState(connectionId);
  updateConnectionState(connectionId, { isConnected: false });
  clearConnectionError(connectionId);
  emitActiveConnectionsChanged();

  try {
    await DbmApi.closeConnection(connectionId);
  } catch (error) {
    console.warn(`取消连接 ${connectionId} 时关闭连接失败:`, error);
  }

  ElMessage.info(t('messages.cancelled'));
};

const emitActiveConnectionsChanged = () => {
  emit(
    'active-connections-changed',
    connections.value.filter((item) => !!item.isConnected).map((item) => item.id)
  );
};

const loadConnections = async () => {
  try {
    loading.value = true;
    const previousConnections = new Map(
      connections.value.map((item) => [item.id, item])
    );
    const result = await DbmApi.getConnections();
    connections.value = result.map(conn => ({
      ...conn,
      id: conn.id,
      last_used: conn.last_used,
      isConnected: previousConnections.get(conn.id)?.isConnected ?? false
    }));
    emitActiveConnectionsChanged();
  } catch (error) {
    console.error('加载连接列表失败:', error);
    ElMessage.error(t('messages.loadFailed', { error: extractDbmErrorMessage(error, t('messages.unknownError')) }));
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  loadConnections();
  nextTick(() => {
    updateTreeLayoutHeight();

    if (treeLayoutRef.value && typeof ResizeObserver !== 'undefined') {
      treeLayoutResizeObserver = new ResizeObserver(() => {
        updateTreeLayoutHeight();
      });
      treeLayoutResizeObserver.observe(treeLayoutRef.value);
      return;
    }

    window.addEventListener('resize', updateTreeLayoutHeight);
    usingWindowResizeFallback = true;
  });
});

onBeforeUnmount(() => {
  treeLayoutResizeObserver?.disconnect();
  if (usingWindowResizeFallback) {
    window.removeEventListener('resize', updateTreeLayoutHeight);
  }
});

const resetTreePanelHeight = () => {
  treePanelHeightOverride.value = null;
};

const handleCommand = async (command: { action: string; data: DatabaseConnection }) => {
  if (isConnectionBusy(command.data.id)) {
    return;
  }

  console.log('=== DbConnectionList handleCommand START ===');
  console.log('Received command:', command);
  console.log('Command action:', command.action);
  console.log('Command data:', command.data);
  
  switch (command.action) {
    case 'edit':
      console.log('EDIT case matched');
      console.log('About to emit edit-connection event');
      console.log('Data to emit:', command.data);
      if(typeof emit === 'function') {
        emit('edit-connection', command.data);
        console.log('edit-connection event emitted successfully');
      } else {
        console.error('emit is not a function');
      }
      break;
      
    case 'delete':
      console.log('DELETE case matched');
      if(typeof emit === 'function') {
        emit('delete-connection', command.data.id!);
        console.log('delete-connection event emitted successfully');
      } else {
        console.error('emit is not a function');
      }
      break;
      
    case 'connect':
      console.log('connect case matched');
      let connectAttemptVersion = 0;
      try {
        connectAttemptVersion = beginConnectionAttempt(command.data.id, 'connect');
        clearConnectionError(command.data.id);
        
        // 根据数据库类型设置不同的超时时间
        let result: boolean;
        if (command.data.db_type === 'sqlserver') {
          // 对于 SQL Server，使用 Promise.race 设置超时
          result = await Promise.race<boolean>([
            DbmApi.openConnection(command.data),
            new Promise<boolean>((_, reject) => {
              setTimeout(() => {
                reject(new Error(t('messages.sqlServerTimeout', { seconds: Math.round(SQL_SERVER_CONNECTION_TIMEOUT_MS / 1000) })));
              }, SQL_SERVER_CONNECTION_TIMEOUT_MS);
            })
          ]);
        } else {
          // 其他数据库类型使用默认行为
          result = await DbmApi.openConnection(command.data);
        }
        
        if (!isCurrentConnectionAttempt(command.data.id, connectAttemptVersion)) {
          if (result) {
            await DbmApi.closeConnection(command.data.id).catch((error) => {
              console.warn(`忽略已取消连接 ${command.data.id} 的迟到结果失败:`, error);
            });
          }
          return;
        }
        if (result) {
          updateConnectionState(command.data.id, { isConnected: true });
          clearConnectionError(command.data.id);
          emitActiveConnectionsChanged();
          ElMessage.success(t('messages.connectSuccess'));
        } else {
          updateConnectionState(command.data.id, { isConnected: false });
          markConnectionError(command.data.id);
          emitActiveConnectionsChanged();
          ElMessage.error(t('messages.connectFailed'));
        }
      } catch (error) {
        if (!isCurrentConnectionAttempt(command.data.id, connectAttemptVersion)) {
          return;
        }
        updateConnectionState(command.data.id, { isConnected: false });
        markConnectionError(command.data.id);
        emitActiveConnectionsChanged();
        const errorMessage = extractDbmErrorMessage(error, t('messages.connectFailed'));
        // 对 SQL Server 显示更详细的错误信息
        if (command.data.db_type === 'sqlserver') {
          ElMessage.error(t('messages.sqlServerConnectFailed', { error: errorMessage }));
        } else {
          ElMessage.error(t('messages.connectFailedWithReason', { error: errorMessage }));
        }
      } finally {
        clearBusyState(command.data.id);
      }
      break;
      
    case 'disconnect':
      console.log('disconnect case matched');
      try {
        setBusyState(command.data.id, 'disconnect');
        const result = await DbmApi.closeConnection(command.data.id);
        if (result) {
          updateConnectionState(command.data.id, { isConnected: false });
          clearConnectionError(command.data.id);
          emitActiveConnectionsChanged();
          ElMessage.success(t('messages.disconnectSuccess'));
        } else {
          markConnectionError(command.data.id);
          ElMessage.error(t('messages.disconnectFailed'));
        }
      } catch (error) {
        markConnectionError(command.data.id);
        ElMessage.error(t('messages.disconnectFailedWithReason', {
          error: extractDbmErrorMessage(error, t('messages.disconnectFailed'))
        }));
      } finally {
        clearBusyState(command.data.id);
      }
      break;
      
    case 'reconnect':
      console.log('reconnect case matched');
      try {
        setBusyState(command.data.id, 'reconnect');
        clearConnectionError(command.data.id);
        updateConnectionState(command.data.id, { isConnected: false });

        // 断开连接
        await DbmApi.closeConnection(command.data.id);
        await new Promise(resolve => setTimeout(resolve, 500));

        // 重新连接
        const connectResult = await DbmApi.openConnection(command.data);
        if (connectResult) {
          updateConnectionState(command.data.id, { isConnected: true });
          clearConnectionError(command.data.id);
          emitActiveConnectionsChanged();
          ElMessage.success(t('messages.reconnectSuccess'));
        } else {
          updateConnectionState(command.data.id, { isConnected: false });
          markConnectionError(command.data.id);
          emitActiveConnectionsChanged();
          ElMessage.error(t('messages.reconnectFailed'));
        }
      } catch (error) {
        console.error('重新连接过程中发生错误:', error);
        updateConnectionState(command.data.id, { isConnected: false });
        markConnectionError(command.data.id);
        emitActiveConnectionsChanged();
        ElMessage.error(t('messages.reconnectFailedWithReason', {
          error: extractDbmErrorMessage(error, t('messages.reconnectFailed'))
        }));
      } finally {
        clearBusyState(command.data.id);
      }
      break;
      
    default:
      console.log('Unknown action:', command.action);
  }
  
  console.log('=== DbConnectionList handleCommand END ===');
};

const handleConnectionClick = (connection: DatabaseConnection) => {
  console.log('=== DbConnectionList handleConnectionClick START ===');
  console.log('Clicked connection:', connection);
  console.log('Emit function exists:', typeof emit);
  if (typeof emit === 'function') {
    emit('select-connection', connection);
    console.log('select-connection event emitted successfully');
  } else {
    console.error('emit is not a function');
  }
  console.log('=== DbConnectionList handleConnectionClick END ===');
};

const handleConnectionDoubleClick = async (connection: DatabaseConnection) => {
  if (!isConnectionConnecting(connection.id)) {
    return;
  }

  await cancelConnectingState(connection);
};

const syncConnectionSelection = (connection: DatabaseConnection) => {
  if (props.selectedConnection?.id !== connection.id) {
    emit('select-connection', connection);
  }
};

const handleTreeSelectNode = (connection: DatabaseConnection, selection: DbTreeSelection) => {
  syncConnectionSelection(connection);
  emit('select-node', selection);
};

const handleTreeOpenTable = (
  connection: DatabaseConnection,
  connectionId: string,
  tableName: string,
  databaseName?: string,
  schemaName?: string
) => {
  syncConnectionSelection(connection);
  handleOpenTable(connectionId, tableName, databaseName, schemaName);
};

const handleTreeOpenView = (
  connection: DatabaseConnection,
  connectionId: string,
  viewName: string,
  databaseName?: string,
  schemaName?: string
) => {
  syncConnectionSelection(connection);
  handleOpenView(connectionId, viewName, databaseName, schemaName);
};

const handleTreeOpenProcedure = (
  connection: DatabaseConnection,
  connectionId: string,
  procedureName: string,
  databaseName?: string,
  schemaName?: string
) => {
  syncConnectionSelection(connection);
  handleOpenProcedure(connectionId, procedureName, databaseName, schemaName);
};

const handleTreeExportTable = (
  connection: DatabaseConnection,
  connectionId: string,
  tableName: string,
  databaseName?: string,
  schemaName?: string
) => {
  syncConnectionSelection(connection);
  handleExportTable(connectionId, tableName, databaseName, schemaName);
};

const handleOpenTable = (connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => {
  emit('open-table', connectionId, tableName, databaseName || '', schemaName);
};

const handleOpenView = (connectionId: string, viewName: string, databaseName?: string, schemaName?: string) => {
  emit('open-view', connectionId, viewName, databaseName, schemaName);
};

const handleOpenProcedure = (connectionId: string, procedureName: string, databaseName?: string, schemaName?: string) => {
  emit('open-procedure', connectionId, procedureName, databaseName, schemaName);
};

const handleExportTable = (connectionId: string, tableName: string, databaseName?: string, schemaName?: string) => {
  emit('export-table', connectionId, tableName, databaseName, schemaName);
};

const restoreActiveConnections = async (connectionIds: string[]) => {
  const normalizedIds = Array.from(new Set(connectionIds.filter(Boolean)));
  if (!connections.value.length) {
    await loadConnections();
  }
  if (!normalizedIds.length) {
    emitActiveConnectionsChanged();
    return;
  }

  for (const connectionId of normalizedIds) {
    const connection = connections.value.find((item) => item.id === connectionId);
    if (!connection || connection.isConnected) {
      continue;
    }

    try {
      const attemptVersion = beginConnectionAttempt(connectionId, 'connect');
      clearConnectionError(connectionId);
      const result = await Promise.race<boolean>([
        DbmApi.openConnection(connection),
        new Promise<boolean>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error(`恢复连接超时（${Math.round(RESTORE_CONNECTION_TIMEOUT_MS / 1000)} 秒）`));
          }, RESTORE_CONNECTION_TIMEOUT_MS);
        })
      ]);
      if (!isCurrentConnectionAttempt(connectionId, attemptVersion)) {
        if (result) {
          await DbmApi.closeConnection(connectionId).catch((error) => {
            console.warn(`忽略已取消恢复连接 ${connectionId} 的迟到结果失败:`, error);
          });
        }
        continue;
      }
      updateConnectionState(connectionId, { isConnected: !!result });
      if (!result) {
        markConnectionError(connectionId);
      }
    } catch (error) {
      console.error(`恢复数据库连接 ${connectionId} 失败:`, error);
      updateConnectionState(connectionId, { isConnected: false });
      markConnectionError(connectionId);
      await DbmApi.closeConnection(connectionId).catch((closeError) => {
        console.warn(`恢复连接失败后关闭连接 ${connectionId} 失败:`, closeError);
      });
    } finally {
      clearBusyState(connectionId);
    }
  }

  emitActiveConnectionsChanged();
};

const showTaskPanel = () => {
  emit('show-task-panel');
};

defineExpose({
  getDbmTreeRef,
  refreshConnections: loadConnections,
  restoreActiveConnections
});
</script>

<style scoped>
.connection-list-panel {
  width: 100%;
  background-color: var(--sidebar-bg-color);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.list-header {
  background-color: var(--toolbar-bg-color);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 0px solid var(--layout-border-color);
}

.list-header-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.list-title {
  line-height: 1.15;
  color: var(--el-text-color-primary);
}

.list-subtitle {
  font-size: 11px;
  line-height: 1.35;
  color: var(--el-text-color-secondary);
}

.connection-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.connection-list-region {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.connection-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.connection-item-group {
  display: flex;
  flex-direction: column;
  /* background-color: var(--el-bg-color); */
}

.connection-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: var(--connection-item-padding-y, 8px) 8px;
  background-color: var(--el-bg-color);
  border-bottom: 1px solid var(--layout-border-color);
  transition: padding 0.18s ease, background-color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}

.connection-item-group:first-child .connection-item {
  border-top: 1px solid var(--layout-border-color);
}

.connection-item.is-busy {
  cursor: progress;
}

.connection-item:hover {
  background-color: var(--sidebar-item-bg-color-hover);
}

.connection-item.active {
  background-color: var(--sidebar-item-bg-color-active);
  border-bottom: 0px solid var(--layout-border-color);
  box-shadow:
    inset 3px 0 0 var(--el-color-primary);
}

.connection-item.active .connection-title {
  color: var(--el-color-primary);
}

.connection-item.active .connection-subtitle {
  color: color-mix(in srgb, var(--el-color-primary) 62%, var(--el-text-color-secondary) 38%);
}

.connection-info {
  flex: 1;
  min-width: 0;
}

.connection-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.connection-title-group {
  flex: 1;
  min-width: 0;
}

.connection-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.connection-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.connection-subtitle {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.connection-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.connection-smart-control {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-width: 0;
  max-width: 100%;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  background-color: var(--el-fill-color-light);
  overflow: hidden;
  transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.connection-state-action-online {
  color: var(--el-color-success);
  background-color: color-mix(in srgb, var(--el-color-success-light-9) 84%, white 16%);
}

.connection-state-action-busy {
  color: var(--el-color-primary);
  background-color: color-mix(in srgb, var(--el-color-primary-light-9) 84%, white 16%);
}

.connection-state-action-error {
  color: var(--el-color-danger);
  background-color: color-mix(in srgb, var(--el-color-danger-light-9) 82%, white 18%);
}

.connection-state-action-offline {
  color: var(--el-text-color-secondary);
  background-color: color-mix(in srgb, var(--el-fill-color-light) 54%, white 46%);
}
.dark .connection-state-action-offline {
  background-color: var(--el-fill-color-light);
}

.connection-smart-control:hover {
  transform: translateY(-1px);
}

.connection-smart-control:focus,
.connection-smart-control:focus-visible {
  outline: none;
  box-shadow: none;
}

.connection-smart-main {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 5px 4px 5px 8px;
}
.connection-state-action-online .connection-smart-main {
  padding: 4px 4px 4px 8px;
}

.connection-smart-label {
  display: inline-block;
  white-space: nowrap;
}

.connection-smart-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  height: 100%;
  flex-shrink: 0;
  padding: 0 4px;
  border-left: 1px solid color-mix(in srgb, currentColor 8%, transparent 92%);
}

.db-type-logo {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  isolation: isolate;
}

.db-type-logo::before,
.db-type-logo::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.db-type-logo::before {
  border: 1.5px solid transparent;
}

.db-type-logo::after {
  inset: -2px;
  z-index: -1;
}

.db-type-logo-busy::before {
  opacity: 1;
  border-top-color: color-mix(in srgb, var(--el-color-primary) 88%, white 12%);
  border-right-color: color-mix(in srgb, var(--el-color-primary-light-5) 74%, white 26%);
  border-bottom-color: transparent;
  border-left-color: transparent;
  animation: dbm-logo-rotate 0.95s linear infinite;
}

.db-type-logo-busy::after {
  opacity: 1;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--el-color-primary-light-8) 58%, transparent 42%) 0%, transparent 72%);
  animation: dbm-logo-pulse 1.3s ease-in-out infinite;
}

.db-type-logo-error::before {
  opacity: 1;
  border-color: color-mix(in srgb, var(--el-color-danger) 58%, transparent 42%);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--el-color-danger-light-5) 38%, transparent 62%),
    0 0 14px color-mix(in srgb, var(--el-color-danger-light-5) 46%, transparent 54%);
}

.db-type-logo-error::after {
  opacity: 1;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--el-color-danger-light-8) 56%, transparent 44%) 0%, transparent 76%);
  animation: dbm-logo-error-pulse 1.1s ease-in-out infinite;
}

.db-type-logo-image {
  position: relative;
  z-index: 1;
  width: 16px;
  height: 16px;
  object-fit: contain;
  transition: filter 0.2s ease, opacity 0.2s ease;
}

:deep(.db-type-logo-mysql path) {
  fill: var(--db-type-logo-fill) !important;
}

.db-type-logo > span {
  position: relative;
  z-index: 1;
  transition: color 0.2s ease, opacity 0.2s ease;
}

.db-type-logo-offline .db-type-logo-image {
  filter: grayscale(1) saturate(0.15);
  opacity: 0.72;
}

.db-type-logo-offline {
  background: color-mix(in srgb, var(--el-fill-color) 76%, white 24%) !important;
}
.dark .db-type-logo-offline {
  background: rgb(255 255 255 / 0.03) !important;
}

.db-type-logo-offline > span {
  color: color-mix(in srgb, var(--el-text-color-secondary) 78%, white 22%);
  opacity: 0.78;
}

.db-type-logo-online .db-type-logo-image,
.db-type-logo-busy .db-type-logo-image,
.db-type-logo-error .db-type-logo-image {
  filter: none;
  opacity: 1;
}

.db-type-logo-online > span,
.db-type-logo-busy > span,
.db-type-logo-error > span {
  opacity: 1;
}

.more-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  font-size: 10px;
  color: inherit;
  line-height: 1;
  margin: 0;
}

:deep(.more-icon svg) {
  width: 10px;
  height: 10px;
}

.tree-panel-resizer {
  /* height: 2px; */
  margin: 0;
  cursor: row-resize;
  background: transparent;
  border-top: 1px solid var(--layout-border-color);
  border-bottom: 1px solid transparent;
  position: relative;
  flex-shrink: 0;
}

.tree-panel-resizer::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 88px;
  /* height: 3px; */
  transform: translateX(-50%);
  background: var(--el-color-primary-light-7);
  border-radius: 999px;
  opacity: 0.68;
}

.tree-panel-resizer:hover::before,
.tree-panel-resizer.dragging::before {
  opacity: 1;
  background: var(--el-color-primary-light-5);
}

.tree-resize-tooltip {
  position: absolute;
  left: 50%;
  top: -26px;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.25);
  pointer-events: none;
}

.tree-panel {
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: color-mix(in srgb, var(--el-bg-color) 78%, var(--el-fill-color-light) 22%);
  box-shadow: 0 -6px 14px rgba(15, 23, 42, 0.08);
  transition: height 0.18s ease;
}

.tree-panel-header {
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--layout-border-color);
  background: color-mix(in srgb, var(--toolbar-bg-color) 88%, var(--el-bg-color) 12%);
}

.tree-panel-title-group {
  min-width: 0;
}

.tree-panel-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.tree-panel-subtitle {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-panel-content {
  flex: 1;
  min-height: 0;
  position: relative;
}

.tree-panel-view {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 6px 12px 10px;
}

.status-dot {
  transition: background-color 0.2s ease, transform 0.2s ease;
}

.status-dot-inline {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.status-dot-busy {
  animation: dbm-connection-pulse 1.1s ease-in-out infinite;
}

.status-spinner {
  animation: dbm-connection-rotate 1s linear infinite;
}

.loading,
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  text-align: center;
  min-height: 0;
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.task-panel-button {
  border-top: 1px solid var(--layout-border-color);
  background-color: var(--toolbar-bg-color);
}

@keyframes dbm-connection-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.18);
    opacity: 0.6;
  }
}

@keyframes dbm-connection-rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes dbm-logo-rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes dbm-logo-pulse {
  0%,
  100% {
    transform: scale(0.98);
    opacity: 0.65;
  }
  50% {
    transform: scale(1.04);
    opacity: 1;
  }
}

@keyframes dbm-logo-error-pulse {
  0%,
  100% {
    transform: scale(0.98);
    opacity: 0.72;
  }
  50% {
    transform: scale(1.06);
    opacity: 1;
  }
}
</style>
