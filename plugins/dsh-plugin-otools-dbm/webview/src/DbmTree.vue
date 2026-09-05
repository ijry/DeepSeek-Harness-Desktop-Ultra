<template>
  <div class="dbm-tree">
    <!-- 表筛选输入框 -->
    <div class="tree-filter" v-if="treeData.length > 0">
      <div class="tree-filter-row">
        <el-input-tag
          v-model="filterKeywords"
          :placeholder="t('filterPlaceholder')"
          size="small"
          clearable
        />
        <button
          type="button"
          class="filter-toggle-button"
          :class="{ active: filterEnabled }"
          :title="filterToggleTitle"
          :aria-pressed="filterEnabled"
          @click="toggleFilterEnabled"
        >
          <svg
            class="filter-toggle-icon"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M3.5 4.5H16.5L11.75 9.9V14.3L8.25 16V9.9L3.5 4.5Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              v-if="!filterEnabled"
              d="M4.2 15.8L15.8 4.2"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <el-tree
      ref="treeRef"
      :data="treeData"
      :props="defaultProps"
      :load="loadNode"
      :filter-node-method="filterNode"
      lazy
      node-key="id"
      highlight-current
      :expand-on-click-node="false"
      @node-click="handleNodeClick"
      @node-expand="handleNodeExpand"
      @node-collapse="handleNodeCollapse"
      @node-contextmenu="handleNodeRightClick"
      class="db-tree"
    >
      <template #default="{ node, data }">
        <div class="tree-node">
          <el-icon v-if="data.type === 'database'">
            <Folder />
          </el-icon>
          <el-icon v-else-if="data.type === 'folder' || data.type === 'redis-prefix' || data.type === 'schema'">
            <Folder />
          </el-icon>
          <el-icon v-else-if="data.type === 'redis-load-more'">
            <MoreFilled />
          </el-icon>
          <el-icon v-else-if="data.type === 'table' && isPinned(data)">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              class="pinned-table-svg"
            >
              <path
                d="M15.5 3.5L20.5 8.5L16.8 9.8L14.2 12.4L18 16.2L16.2 18L12.4 14.2L9.8 16.8L8.5 20.5L3.5 15.5L8.3 13.9L13.9 8.3L15.5 3.5Z"
                fill="currentColor"
              />
            </svg>
          </el-icon>
          <el-icon v-else-if="data.type === 'table'">
            <Tickets />
          </el-icon>
          <el-icon v-else-if="data.type === 'view'">
            <View />
          </el-icon>
          <el-icon v-else-if="data.type === 'procedure'">
            <SetUp />
          </el-icon>
          <el-icon v-else-if="data.type === 'column'">
            <Document />
          </el-icon>
          <span class="node-label" :class="{ 'load-more-label': data.type === 'redis-load-more' }">{{ data.label }}</span>
          <div class="node-actions">
            <el-icon
              v-if="canCreateSchema(data)"
              class="node-action-icon"
              :title="t('actions.createSchema')"
              @click.stop="handleCreateSchema(data)"
            >
              <Plus />
            </el-icon>
            <el-icon
              v-if="canCreateTable(data)"
              class="node-action-icon"
              :title="t('actions.createTable')"
              @click.stop="handleCreateTable(data)"
            >
              <Plus />
            </el-icon>
            <el-icon
              v-if="canCreateRedisKey(data)"
              class="node-action-icon"
              :title="t('actions.createKey')"
              @click.stop="handleCreateRedisKey(data)"
            >
              <Plus />
            </el-icon>
            <el-icon
              v-if="canRefreshObjectList(data)"
              class="node-action-icon"
              :title="t('actions.refreshList')"
              @click.stop="handleRefreshObjectList(data)"
            >
              <RefreshRight />
            </el-icon>
            <el-icon v-if="data.type === 'table'" class="pin-icon" @click.stop="togglePin(data)">
              <Top v-if="!isPinned(data)" />
              <Bottom v-else />
            </el-icon>
          </div>
        </div>
      </template>
    </el-tree>
    
    <!-- 数据库右键菜单 -->
    <DbContextMenu
      ref="dbContextMenuRef"
      :node-type="contextMenuData.type"
      :node-id="contextMenuData.id"
      :node-label="contextMenuData.label"
      :db-id="contextMenuData.dbId"
      :db-type="props.connection.db_type"
      :db-name="contextMenuData.dbName"
      :schema-name="contextMenuData.schemaName"
      :table-name="contextMenuData.tableName"
      @close="hideContextMenu"
      @export-table="handleExportTable"
      @open-view="(id, name, db, schema) => emit('open-view', id, name, db, schema)"
      @open-procedure="(id, name, db, schema) => emit('open-procedure', id, name, db, schema)"
      @create-schema="handleCreateSchemaFromMenu"
      @rename-schema="handleRenameSchema"
      @drop-schema="handleDropSchema"
      @create-view="(id, db, schema) => emit('create-view', id, db, schema)"
      @create-procedure="(id, db, schema) => emit('create-procedure', id, db, schema)"
      @drop-table="(id, name, db, schema) => openDropTableDialog(id, name, db, schema)"
      @drop-view="(id, name, db, schema) => emit('drop-view', id, name, db, schema)"
      @drop-procedure="(id, name, db, schema) => emit('drop-procedure', id, name, db, schema)"
    />

    <DropTableConfirmDialog
      v-model="dropTableDialogVisible"
      :connection-id="pendingDropTable.connectionId"
      :database-name="pendingDropTable.databaseName"
      :schema-name="pendingDropTable.schemaName || undefined"
      :table-name="pendingDropTable.tableName"
      @confirm="handleDropTableConfirmed"
    />

    <RedisKeyEditorDialog
      v-model="redisEditorVisible"
      :title="t('redis.createTitle')"
      :initial-value="redisEditorDraft"
      @confirm="handleRedisKeyConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Folder, Tickets, View, Document, Top, Bottom, SetUp, Plus, RefreshRight, MoreFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DbmApi,
  extractDbmErrorMessage,
  type RedisKeyMutation,
  type RedisTreeChildrenPage,
  type RedisTreeNode as RedisTreeChild
} from './service';
import DbContextMenu from './DbContextMenu.vue';
import DropTableConfirmDialog from './DropTableConfirmDialog.vue';
import RedisKeyEditorDialog from './RedisKeyEditorDialog.vue';
import { useI18nScope } from '@/platform/i18n';

interface TreeData {
  id: string;
  label: string;
  type: string;
  dbId?: string; // 数据库连接ID
  dbName?: string; // 数据库名，用于表的加载
  schemaName?: string;
  tableName?: string; // 表名，用于列的加载
  redisPrefix?: string;
  redisCursor?: string;
  redisParentId?: string;
  isLeaf?: boolean;
}

interface TreeNode {
  id: string;
  label: string;
  type: string;
  dbId?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
  redisPrefix?: string;
  redisCursor?: string;
  redisParentId?: string;
  isLeaf?: boolean;
}

export interface DbTreeSelection {
  type: string;
  connectionId: string;
  databaseName?: string;
  schemaName?: string;
  tableName?: string;
  label: string;
}

export interface DbTreeFilterState {
  keywords: string[];
  enabled?: boolean;
}

const defaultProps = {
  children: 'children',
  label: 'label',
  isLeaf: 'isLeaf'
};

const treeData = ref<TreeData[]>([]);
const treeRef = ref();
const dbContextMenuRef = ref();

// 存储右键菜单的上下文数据
const contextMenuData = ref({
  id: '',
  label: '',
  type: '',
  dbId: '',
  dbName: '',
  schemaName: '',
  tableName: ''
});
const dropTableDialogVisible = ref(false);
const pendingDropTable = ref({
  connectionId: '',
  databaseName: '',
  schemaName: '',
  tableName: ''
});
const redisEditorVisible = ref(false);
const redisEditorDraft = ref<RedisKeyMutation | null>(null);
const pendingRedisTarget = ref({
  connectionId: '',
  databaseName: ''
});

// 筛选
const normalizeFilterKeywords = (value?: string | string[]) => {
  if (Array.isArray(value)) {
    return value.map(item => item.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
};

const normalizeFilterState = (
  value?: string | string[] | DbTreeFilterState | null
): DbTreeFilterState => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keywords = normalizeFilterKeywords((value as DbTreeFilterState).keywords);
    return {
      keywords,
      enabled:
        typeof (value as DbTreeFilterState).enabled === 'boolean'
          ? !!(value as DbTreeFilterState).enabled
          : keywords.length > 0 || !!(value as Record<string, unknown>).includeViewsAndProcedures
    };
  }

  const keywords = normalizeFilterKeywords(value);
  return {
    keywords,
    enabled: keywords.length > 0
  };
};

const filterKeywords = ref<string[]>([]);
const filterEnabled = ref(false);
let lastEmittedFilterStateJson = '';
let redisSearchReloadTimer: ReturnType<typeof setTimeout> | undefined;
const serializeStringArray = (value: string[]) => JSON.stringify(value);
const serializeFilterState = (value: DbTreeFilterState) => JSON.stringify({
  keywords: normalizeFilterKeywords(value.keywords),
  enabled: !!value.enabled
});

const getCurrentFilterState = (): DbTreeFilterState => ({
  keywords: [...filterKeywords.value],
  enabled: filterEnabled.value
});

const emitFilterChangedIfNeeded = (filterState: DbTreeFilterState) => {
  const nextJson = serializeFilterState(filterState);
  if (nextJson === lastEmittedFilterStateJson) {
    return;
  }
  lastEmittedFilterStateJson = nextJson;
  emit('filter-changed', filterState);
};

const applyCurrentFilter = () => {
  treeRef.value?.filter(getCurrentFilterState());
};

const isRedisConnection = computed(() => props.connection.db_type?.toLowerCase() === 'redis');
const getRedisSearchKeywords = () =>
  isRedisConnection.value && filterEnabled.value
    ? normalizeFilterKeywords(filterKeywords.value)
    : [];

const scheduleRedisTreeReloadForSearch = () => {
  if (!isRedisConnection.value || !props.isConnected) {
    return;
  }

  if (redisSearchReloadTimer) {
    clearTimeout(redisSearchReloadTimer);
  }

  redisSearchReloadTimer = setTimeout(() => {
    redisSearchReloadTimer = undefined;
    void loadDatabaseList({
      preserveExpandedKeys: expandedKeys.value,
      restoreSelection: true
    });
  }, 120);
};

watch(filterKeywords, (val) => {
  const normalized = normalizeFilterKeywords(val);
  if (serializeStringArray(normalized) !== serializeStringArray(val)) {
    filterKeywords.value = normalized;
    return;
  }

  applyCurrentFilter();
  emitFilterChangedIfNeeded({
    keywords: normalized,
    enabled: filterEnabled.value
  });
  scheduleRedisTreeReloadForSearch();
});

watch(filterEnabled, (value) => {
  applyCurrentFilter();
  emitFilterChangedIfNeeded({
    keywords: [...filterKeywords.value],
    enabled: value
  });
  scheduleRedisTreeReloadForSearch();
});

const toggleFilterEnabled = () => {
  filterEnabled.value = !filterEnabled.value;
};

const filterToggleTitle = computed(() =>
  filterEnabled.value
    ? t('filterEnabledTitle')
    : t('filterDisabledTitle')
);

const filterNode = (value: DbTreeFilterState | string[] | string, data: TreeData) => {
  const filterState = normalizeFilterState(value);
  const keywords = filterState.keywords;
  if (!filterState.enabled || !keywords.length) return true;

  if (data.type === 'table' || data.type === 'view' || data.type === 'procedure') {
    const candidates = [data.label, data.tableName]
      .filter((item): item is string => !!item)
      .map((item) => item.toLowerCase());
    return keywords.some((keyword) =>
      candidates.some((candidate) => candidate.includes(keyword.toLowerCase()))
    );
  }

  if (data.type === 'redis-prefix') {
    const candidates = [data.label, data.redisPrefix]
      .filter((item): item is string => !!item)
      .map((item) => item.toLowerCase());
    return keywords.some((keyword) =>
      candidates.some((candidate) => candidate.includes(keyword.toLowerCase()))
    );
  }

  if (data.type === 'redis-load-more') {
    return true;
  }

  return true;
};

// 置顶表
interface PinnedTable {
  id: string;
  label: string;
  dbId: string;
  dbName: string;
  schemaName?: string;
  tableName: string;
}
const pinnedTables = ref<PinnedTable[]>([]);
const expandedKeys = ref<string[]>([]);

const getPinnedKey = () => `dbm-pinned-tables-${props.connection.id}`;

const loadPinnedTables = () => {
  // 将由父组件通过 restorePinnedTables 调用
};

const isPinned = (data: TreeData) =>
  pinnedTables.value.some(
    (p) => p.id === data.id && p.dbName === data.dbName && p.schemaName === data.schemaName
  );

const isPinnedTableName = (dbName: string, tableName: string, schemaName?: string) =>
  pinnedTables.value.some(
    (item) =>
      item.dbName === dbName && item.tableName === tableName && item.schemaName === schemaName
  );

const compareTableNodes = (
  a: { label: string },
  b: { label: string },
  dbName: string,
  schemaName?: string
) => {
  const aPinned = isPinnedTableName(dbName, a.label, schemaName);
  const bPinned = isPinnedTableName(dbName, b.label, schemaName);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }
  return a.label.localeCompare(b.label, 'zh-Hans-CN');
};

const sortTableNodes = <T extends { label: string }>(nodes: T[], dbName: string, schemaName?: string) =>
  [...nodes].sort((a, b) => compareTableNodes(a, b, dbName, schemaName));

const reorderLoadedTableNodes = (dbName?: string, schemaName?: string) => {
  if (!dbName) {
    return;
  }

  const folderNode = treeRef.value?.getNode?.(createFolderNodeId('tables', dbName, schemaName));
  if (!folderNode?.childNodes?.length) {
    return;
  }

  folderNode.childNodes.sort((a: any, b: any) => compareTableNodes(a.data, b.data, dbName, schemaName));
  if (Array.isArray(folderNode.data?.children)) {
    folderNode.data.children.sort((a: TreeData, b: TreeData) => compareTableNodes(a, b, dbName, schemaName));
  }
};

const togglePin = (data: TreeData) => {
  if (isPinned(data)) {
    unpinTable(data as any);
  } else {
    pinnedTables.value.push({
      id: data.id,
      label: data.label,
      dbId: data.dbId || '',
      dbName: data.dbName || '',
      schemaName: data.schemaName,
      tableName: data.tableName || data.label
    });
    emitPinnedChanged();
    reorderLoadedTableNodes(data.dbName, data.schemaName);
  }
};

const unpinTable = (item: PinnedTable) => {
  pinnedTables.value = pinnedTables.value.filter(
    (p) => !(p.id === item.id && p.dbName === item.dbName && p.schemaName === item.schemaName)
  );
  emitPinnedChanged();
  reorderLoadedTableNodes(item.dbName, item.schemaName);
};

const emitPinnedChanged = () => {
  emit('pinned-changed', pinnedTables.value);
};

const restorePinnedTables = (data: PinnedTable[]) => {
  pinnedTables.value = data || [];
};

// 定义组件属性
interface Props {
  connection: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    database: string;
    db_type: string;
  };
  isConnected: boolean; // 添加连接状态属性
  initialPinnedTables?: PinnedTable[];
  initialFilterText?: string | string[] | DbTreeFilterState;
  initialExpandedKeys?: string[];
  initialSelectedNode?: DbTreeSelection | null;
}

// 定义 emits
const emit = defineEmits<{
  'open-table': [connectionId: string, tableName: string, databaseName?: string, schemaName?: string]
  'open-view': [connectionId: string, viewName: string, databaseName?: string, schemaName?: string]
  'open-procedure': [connectionId: string, procedureName: string, databaseName?: string, schemaName?: string]
  'export-table': [connectionId: string, tableName: string, databaseName?: string, schemaName?: string]
  'create-table': [connectionId: string, databaseName: string, schemaName?: string]
  'create-view': [connectionId: string, databaseName: string, schemaName?: string]
  'create-procedure': [connectionId: string, databaseName: string, schemaName?: string]
  'drop-table': [connectionId: string, tableName: string, databaseName: string, schemaName?: string]
  'drop-view': [connectionId: string, viewName: string, databaseName: string, schemaName?: string]
  'drop-procedure': [connectionId: string, procedureName: string, databaseName: string, schemaName?: string]
  'pinned-changed': [pinnedTables: PinnedTable[]]
  'filter-changed': [filterState: DbTreeFilterState]
  'select-node': [selection: DbTreeSelection]
  'expanded-keys-changed': [connectionId: string, expandedKeys: string[]]
}>()

const props = defineProps<Props>();
const { t } = useI18nScope('dbm.tree');

const getNodeKeyFromSelection = (selection?: DbTreeSelection | null) => {
  if (!selection) {
    return undefined;
  }

  switch (selection.type) {
    case 'database':
      return selection.databaseName ? `db_${selection.databaseName}` : undefined;
    case 'table':
      return selection.databaseName && selection.tableName
        ? createObjectNodeId('table', selection.databaseName, selection.tableName, selection.schemaName)
        : undefined;
    case 'view':
      return selection.databaseName && selection.tableName
        ? createObjectNodeId('view', selection.databaseName, selection.tableName, selection.schemaName)
        : undefined;
    case 'procedure':
      return selection.databaseName && selection.tableName
        ? createObjectNodeId('proc', selection.databaseName, selection.tableName, selection.schemaName)
        : undefined;
    case 'schema':
      return selection.databaseName && selection.schemaName
        ? createSchemaNodeId(selection.databaseName, selection.schemaName)
        : undefined;
    default:
      return undefined;
  }
};

const persistExpandedKeys = () => {
  const normalized = normalizeExpandedKeys(expandedKeys.value);
  emit('expanded-keys-changed', props.connection.id, normalized);
};

const normalizeExpandedKeys = (keys?: string[]) =>
  Array.from(new Set((keys || []).filter((item): item is string => typeof item === 'string' && item.length > 0)));

type RestoreExpandedKeysOptions = {
  deep?: boolean;
  restoreSelection?: boolean;
};
type ObjectListType = 'tables' | 'views' | 'procedures';
const REDIS_TREE_PAGE_SIZE = 100;

const encodeTreeKeyPart = (value: string) => encodeURIComponent(value);
const decodeTreeKeyPart = (value: string) => decodeURIComponent(value);
const quotePgIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteSqlServerIdentifier = (value: string) => `[${value.replace(/\]/g, ']]')}]`;

const buildCreateSchemaSql = (schemaName: string) => {
  const dbType = props.connection.db_type?.toLowerCase() || '';
  if (dbType === 'sqlserver') {
    return `CREATE SCHEMA ${quoteSqlServerIdentifier(schemaName)}`;
  }
  return `CREATE SCHEMA ${quotePgIdentifier(schemaName)}`;
};

const createSchemaNodeId = (dbName: string, schemaName: string) =>
  `schema::${encodeTreeKeyPart(dbName)}::${encodeTreeKeyPart(schemaName)}`;

const createFolderNodeId = (
  type: ObjectListType,
  dbName: string,
  schemaName?: string
) =>
  schemaName
    ? `${type}::${encodeTreeKeyPart(dbName)}::${encodeTreeKeyPart(schemaName)}`
    : `${type}_${dbName}`;

const createObjectNodeId = (
  type: 'table' | 'view' | 'proc',
  dbName: string,
  objectName: string,
  schemaName?: string
) =>
  schemaName
    ? `${type}::${encodeTreeKeyPart(dbName)}::${encodeTreeKeyPart(schemaName)}::${encodeTreeKeyPart(objectName)}`
    : `${type}_${dbName}_${objectName}`;

const parseSchemaNodeId = (id: string) => {
  const parts = id.split('::');
  if (parts.length !== 3 || parts[0] !== 'schema') {
    return null;
  }
  return {
    dbName: decodeTreeKeyPart(parts[1]),
    schemaName: decodeTreeKeyPart(parts[2])
  };
};

const parseFolderNodeId = (id: string) => {
  const scopedParts = id.split('::');
  if (
    scopedParts.length === 3
    && ['tables', 'views', 'procedures'].includes(scopedParts[0])
  ) {
    return {
      type: scopedParts[0] as ObjectListType,
      dbName: decodeTreeKeyPart(scopedParts[1]),
      schemaName: decodeTreeKeyPart(scopedParts[2])
    };
  }

  if (id.startsWith('tables_')) return { type: 'tables' as const, dbName: id.slice('tables_'.length) };
  if (id.startsWith('views_')) return { type: 'views' as const, dbName: id.slice('views_'.length) };
  if (id.startsWith('procedures_')) return { type: 'procedures' as const, dbName: id.slice('procedures_'.length) };

  return null;
};

const parseObjectNodeId = (id: string) => {
  const scopedParts = id.split('::');
  if (
    scopedParts.length === 4
    && ['table', 'view', 'proc'].includes(scopedParts[0])
  ) {
    return {
      type: scopedParts[0] as 'table' | 'view' | 'proc',
      dbName: decodeTreeKeyPart(scopedParts[1]),
      schemaName: decodeTreeKeyPart(scopedParts[2]),
      objectName: decodeTreeKeyPart(scopedParts[3])
    };
  }

  return null;
};

const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const getRedisPrefixChain = (dbName: string, prefix: string) => {
  const chain = [`db_${dbName}`, `tables_${dbName}`];
  const segments = prefix.split(':').filter(Boolean);
  let currentPrefix = '';

  for (const segment of segments) {
    currentPrefix = `${currentPrefix}${segment}:`;
    chain.push(`redis_prefix_${dbName}_${currentPrefix}`);
  }

  return chain;
};

const getExpansionChain = (key: string): string[] => {
  if (key.startsWith('db_')) {
    return [key];
  }

  const schemaNode = parseSchemaNodeId(key);
  if (schemaNode) {
    return [`db_${schemaNode.dbName}`, key];
  }

  const folderNode = parseFolderNodeId(key);
  if (folderNode) {
    return folderNode.schemaName
      ? [`db_${folderNode.dbName}`, createSchemaNodeId(folderNode.dbName, folderNode.schemaName), key]
      : [`db_${folderNode.dbName}`, key];
  }

  if (key.startsWith('redis_prefix_')) {
    const match = key.match(/^redis_prefix_([^_]+)_(.+)$/);
    if (match) {
      const [, dbName, prefix] = match;
      return getRedisPrefixChain(dbName, prefix);
    }
  }

  const scopedObjectNode = parseObjectNodeId(key);
  if (scopedObjectNode) {
    const folderId = createFolderNodeId(
      scopedObjectNode.type === 'table'
        ? 'tables'
        : scopedObjectNode.type === 'view'
          ? 'views'
          : 'procedures',
      scopedObjectNode.dbName,
      scopedObjectNode.schemaName
    );
    return [
      `db_${scopedObjectNode.dbName}`,
      createSchemaNodeId(scopedObjectNode.dbName, scopedObjectNode.schemaName),
      folderId,
      key
    ];
  }

  if (key.startsWith('table_')) {
    const match = key.match(/^table_([^_]+)_(.+)$/);
    const dbName = match?.[1] || key.split('_')[1];
    const tableName = match?.[2];
    if (tableName && tableName.includes(':') && !tableName.endsWith(':')) {
      const lastSeparatorIndex = tableName.lastIndexOf(':');
      const prefix = tableName.slice(0, lastSeparatorIndex + 1);
      return [...getRedisPrefixChain(dbName, prefix), key];
    }
    return [`db_${dbName}`, `tables_${dbName}`, key];
  }

  if (key.startsWith('view_')) {
    const parts = key.split('_');
    const dbName = parts[1];
    return [`db_${dbName}`, `views_${dbName}`, key];
  }

  if (key.startsWith('proc_')) {
    const parts = key.split('_');
    const dbName = parts[1];
    return [`db_${dbName}`, `procedures_${dbName}`, key];
  }

  return [key];
};

const expandNodeByKey = async (key: string) => {
  const chain = getExpansionChain(key);
  for (const chainKey of chain) {
    const node = treeRef.value?.getNode?.(chainKey);
    if (!node) {
      continue;
    }
    if (!node.expanded) {
      node.expand?.();
      await sleep();
    }
  }
};

const getExpandedKeysToRestore = (keys: string[], deep: boolean) =>
  deep ? keys : keys.filter((key) => key.startsWith('db_'));

const restoreExpandedKeys = async (keys?: string[], options: RestoreExpandedKeysOptions = {}) => {
  const deep = options.deep ?? true;
  const restoreSelection = options.restoreSelection ?? true;
  expandedKeys.value = normalizeExpandedKeys(keys);
  const expandedKeysToRestore = getExpandedKeysToRestore(expandedKeys.value, deep);

  if (!props.isConnected || !treeData.value.length || !expandedKeysToRestore.length) {
    return;
  }

  const orderedKeys = [...expandedKeysToRestore].sort((left, right) => getExpansionChain(left).length - getExpansionChain(right).length);
  for (const key of orderedKeys) {
    await expandNodeByKey(key);
  }

  if (!restoreSelection) {
    return;
  }

  const selectedNodeKey = getNodeKeyFromSelection(props.initialSelectedNode);
  if (selectedNodeKey && (deep || selectedNodeKey.startsWith('db_'))) {
    await nextTick();
    treeRef.value?.setCurrentKey?.(selectedNodeKey);
  }
};

const emitSelection = (data: TreeData) => {
  emit('select-node', {
    type: data.type,
    connectionId: data.dbId || props.connection.id,
    databaseName: data.dbName,
    schemaName: data.schemaName,
    tableName: data.tableName || (data.type === 'table' ? data.label : undefined),
    label: data.label
  });
};

const handleNodeExpand = (data: TreeData) => {
  // 使用 Set 去重并确保 expandedKeys 中没有重复项
  const newExpandedKeys = new Set(expandedKeys.value);
  newExpandedKeys.add(data.id);
  expandedKeys.value = Array.from(newExpandedKeys);
  persistExpandedKeys();
};

const removeExpandedKeyBranch = (collapsedId: string) => {
  const newExpandedKeys = new Set(expandedKeys.value);
  
  if (collapsedId.startsWith('db_')) {
    const dbName = collapsedId.slice(3);
    for (const key of newExpandedKeys) {
      if (key === collapsedId
        || key.startsWith(`schema::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`tables::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`views::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`procedures::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`table::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`view::${encodeTreeKeyPart(dbName)}::`)
        || key.startsWith(`proc::${encodeTreeKeyPart(dbName)}::`)
        || key === `tables_${dbName}`
        || key === `views_${dbName}`
        || key === `procedures_${dbName}`
        || key.startsWith(`redis_prefix_${dbName}_`)
        || key.startsWith(`table_${dbName}_`)
        || key.startsWith(`view_${dbName}_`)
        || key.startsWith(`proc_${dbName}_`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  const schemaNode = parseSchemaNodeId(collapsedId);
  if (schemaNode) {
    const scopedPrefix = `${encodeTreeKeyPart(schemaNode.dbName)}::${encodeTreeKeyPart(schemaNode.schemaName)}`;
    for (const key of newExpandedKeys) {
      if (key === collapsedId
        || key.startsWith(`tables::${scopedPrefix}`)
        || key.startsWith(`views::${scopedPrefix}`)
        || key.startsWith(`procedures::${scopedPrefix}`)
        || key.startsWith(`table::${scopedPrefix}`)
        || key.startsWith(`view::${scopedPrefix}`)
        || key.startsWith(`proc::${scopedPrefix}`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  const scopedFolderNode = parseFolderNodeId(collapsedId);
  if (scopedFolderNode?.schemaName) {
    const prefix = `${encodeTreeKeyPart(scopedFolderNode.dbName)}::${encodeTreeKeyPart(scopedFolderNode.schemaName)}::`;
    const objectPrefix =
      scopedFolderNode.type === 'tables'
        ? 'table'
        : scopedFolderNode.type === 'views'
          ? 'view'
          : 'proc';
    for (const key of newExpandedKeys) {
      if (key === collapsedId || key.startsWith(`${objectPrefix}::${prefix}`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  if (collapsedId.startsWith('tables_')) {
    const dbName = collapsedId.slice('tables_'.length);
    for (const key of newExpandedKeys) {
      if (key === collapsedId
        || key.startsWith(`table_${dbName}_`)
        || key.startsWith(`redis_prefix_${dbName}_`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  if (collapsedId.startsWith('views_')) {
    const dbName = collapsedId.slice('views_'.length);
    for (const key of newExpandedKeys) {
      if (key === collapsedId || key.startsWith(`view_${dbName}_`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  if (collapsedId.startsWith('procedures_')) {
    const dbName = collapsedId.slice('procedures_'.length);
    for (const key of newExpandedKeys) {
      if (key === collapsedId || key.startsWith(`proc_${dbName}_`)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  if (collapsedId.startsWith('redis_prefix_')) {
    for (const key of newExpandedKeys) {
      if (key === collapsedId || key.startsWith(collapsedId)) {
        newExpandedKeys.delete(key);
      }
    }
    expandedKeys.value = Array.from(newExpandedKeys);
    return;
  }

  newExpandedKeys.delete(collapsedId);
  expandedKeys.value = Array.from(newExpandedKeys);
};

const handleNodeCollapse = (data: TreeData) => {
  // 使用防抖策略，避免频繁更新
  removeExpandedKeyBranch(data.id);
  persistExpandedKeys();
};

const canCreateSchema = (data: TreeData) =>
  data.type === 'database'
  && !!data.dbId
  && !!data.dbName
  && ['postgresql', 'sqlserver', 'kingbasees'].includes(props.connection.db_type?.toLowerCase() || '');

const canCreateTable = (data: TreeData) =>
  data.type === 'folder'
  && getObjectListType(data) === 'tables'
  && !!data.dbId
  && !!data.dbName
  && ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'kingbasees', 'sqlite', 'oracle', 'dameng'].includes(props.connection.db_type?.toLowerCase() || '');

const canCreateRedisKey = (data: TreeData) =>
  data.type === 'folder'
  && data.id.startsWith('tables_')
  && !!data.dbId
  && !!data.dbName
  && props.connection.db_type?.toLowerCase() === 'redis';

const supportsSchemaBrowsing = () =>
  ['postgresql', 'sqlserver', 'kingbasees', 'dameng', 'oracle'].includes(
    props.connection.db_type?.toLowerCase() || ''
  );

const canRefreshObjectList = (data: TreeData) =>
  !!data.dbName
  && (
    (data.type === 'database' && supportsSchemaBrowsing())
    || (data.type === 'folder' && !!getObjectListType(data))
  );

const getObjectListType = (data: TreeData): ObjectListType | null => {
  const parsed = parseFolderNodeId(data.id);
  return parsed?.type || null;
};

const getObjectListTypeLabel = (type: string) => {
  switch (type) {
    case 'tables':
      return t('folders.tables');
    case 'views':
      return t('folders.views');
    case 'procedures':
      return t('folders.procedures');
    default:
      return type;
  }
};

const handleCreateTable = (data: TreeData) => {
  if (!data.dbId || !data.dbName) {
    return;
  }
  emit('create-table', data.dbId, data.dbName, data.schemaName);
};

const promptSchemaName = async (title: string, initialValue = '') => {
  const { value } = await ElMessageBox.prompt(t('schema.promptMessage'), title, {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    inputValue: initialValue,
    inputPattern: /^[A-Za-z_][A-Za-z0-9_$]*$/,
    inputErrorMessage: t('schema.promptError')
  });
  return value.trim();
};

const handleCreateSchemaFromMenu = async (connectionId: string, databaseName: string) => {
  await handleCreateSchema({
    id: `db_${databaseName}`,
    label: databaseName,
    type: 'database',
    dbId: connectionId,
    dbName: databaseName
  });
};

const handleCreateSchema = async (data: TreeData) => {
  if (!data.dbId || !data.dbName) {
    return;
  }

  try {
    const schemaName = await promptSchemaName(t('schema.createTitle'));
    await DbmApi.executeQuery(
      data.dbId,
      buildCreateSchemaSql(schemaName),
      data.dbName
    );
    ElMessage.success(t('schema.created', { schemaName }));
    await loadDatabaseList({
      preserveExpandedKeys: normalizeExpandedKeys([
        ...expandedKeys.value,
        `db_${data.dbName}`
      ]),
      restoreSelection: true
    });
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(extractDbmErrorMessage(error, t('schema.createFailed')));
    }
  }
};

const handleRenameSchema = async (connectionId: string, databaseName: string, schemaName: string) => {
  try {
    const nextSchemaName = await promptSchemaName(t('schema.renameTitle'), schemaName);
    if (nextSchemaName === schemaName) {
      return;
    }
    await DbmApi.executeQuery(
      connectionId,
      `ALTER SCHEMA ${quotePgIdentifier(schemaName)} RENAME TO ${quotePgIdentifier(nextSchemaName)}`,
      databaseName
    );
    ElMessage.success(t('schema.renamed', { schemaName: nextSchemaName }));
    await loadDatabaseList({
      preserveExpandedKeys: normalizeExpandedKeys([`db_${databaseName}`]),
      restoreSelection: true
    });
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(extractDbmErrorMessage(error, t('schema.renameFailed')));
    }
  }
};

const handleDropSchema = async (connectionId: string, databaseName: string, schemaName: string) => {
  try {
    await ElMessageBox.confirm(
      t('schema.dropConfirmMessage', { schemaName }),
      t('schema.dropConfirmTitle'),
      {
        confirmButtonText: t('delete'),
        cancelButtonText: t('cancel'),
        type: 'warning'
      }
    );
    await DbmApi.executeQuery(
      connectionId,
      `DROP SCHEMA ${quotePgIdentifier(schemaName)} CASCADE`,
      databaseName
    );
    ElMessage.success(t('schema.deleted', { schemaName }));
    await loadDatabaseList({
      preserveExpandedKeys: normalizeExpandedKeys([`db_${databaseName}`]),
      restoreSelection: true
    });
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(extractDbmErrorMessage(error, t('schema.dropFailed')));
    }
  }
};

const handleCreateRedisKey = (data: TreeData) => {
  if (!data.dbId || !data.dbName) {
    return;
  }

  pendingRedisTarget.value = {
    connectionId: data.dbId,
    databaseName: data.dbName
  };
  redisEditorDraft.value = {
    key_name: '',
    value_type: 'string',
    ttl_seconds: null,
    entries: [{ value: '' }]
  };
  redisEditorVisible.value = true;
};

const handleRedisKeyConfirm = async (payload: RedisKeyMutation) => {
  try {
    await DbmApi.setRedisKey(
      pendingRedisTarget.value.connectionId,
      pendingRedisTarget.value.databaseName,
      payload
    );
    redisEditorVisible.value = false;
    ElMessage.success(t('redis.created'));
    await refreshObjectList('tables', pendingRedisTarget.value.databaseName);
    emit('open-table', pendingRedisTarget.value.connectionId, payload.key_name, pendingRedisTarget.value.databaseName);
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('redis.createFailed')));
  }
};

const openDropTableDialog = (
  connectionId: string,
  tableName: string,
  databaseName: string,
  schemaName?: string
) => {
  pendingDropTable.value = {
    connectionId,
    databaseName,
    schemaName: schemaName || '',
    tableName
  };
  dropTableDialogVisible.value = true;
};

const handleDropTableConfirmed = (payload: { connectionId: string; databaseName: string; schemaName?: string; tableName: string }) => {
  emit(
    'drop-table',
    payload.connectionId,
    payload.tableName,
    payload.databaseName,
    payload.schemaName
  );
};

const handleRefreshObjectList = async (data: TreeData) => {
  if (
    data.type === 'database'
    && supportsSchemaBrowsing()
  ) {
    await loadDatabaseList({
      preserveExpandedKeys: normalizeExpandedKeys([...expandedKeys.value, `db_${data.dbName}`]),
      restoreSelection: true
    });
    return;
  }

  const objectType = getObjectListType(data);
  if (!objectType || !data.dbName) {
    return;
  }
  await refreshObjectList(objectType, data.dbName, data.schemaName);
};

// 处理节点点击
const handleNodeClick = (data: TreeData) => {
  if (data.type === 'redis-load-more') {
    void handleLoadMoreRedisChildren(data);
    return;
  }

  emitSelection(data);
  if (data.type === 'table') {
    emit('open-table', data.dbId!, data.tableName || data.label, data.dbName, data.schemaName);
  } else if (data.type === 'view') {
    emit('open-view', data.dbId!, data.label, data.dbName, data.schemaName);
  } else if (data.type === 'procedure') {
    emit('open-procedure', data.dbId!, data.label, data.dbName, data.schemaName);
  }
};

// 处理节点右键点击
const handleNodeRightClick = (event: MouseEvent, data: TreeData, node: any) => {
  event.preventDefault();
  event.stopPropagation();

  // 列节点不显示右键菜单
  if (data.type === 'column') return;
  if (props.connection.db_type?.toLowerCase() === 'redis') return;

  // 文件夹节点映射为特定类型
  let menuType = data.type;
  if (data.type === 'folder') {
    const folderType = getObjectListType(data);
    if (folderType === 'views') {
      menuType = 'views-folder';
    } else if (folderType === 'procedures') {
      menuType = 'procedures-folder';
    } else if (folderType === 'tables') {
      return; // 表文件夹暂不需要右键菜单
    }
  }

  // 存储上下文数据
  contextMenuData.value = {
    id: data.id,
    label: data.label,
    type: menuType,
    dbId: data.dbId || '',
    dbName: data.dbName || '',
    schemaName: data.schemaName || '',
    tableName: data.tableName || ''
  };

  // 显示右键菜单
  dbContextMenuRef.value.showMenu(event.clientX, event.clientY);
};

// 隐藏右键菜单
const hideContextMenu = () => {
  // 什么都不做，只是关闭菜单
};

// 处理表导出事件
const handleExportTable = (dbId: string, tableName: string, dbName: string, schemaName?: string) => {
  // 发送事件到父组件，让TableContent处理导出
  emit('export-table', dbId, tableName, dbName, schemaName);
};

const loadNodeData = async (node: TreeNode, data: TreeData) => {
  try {
    if (data.type === 'database') {
      // 对于数据库节点，先加载schemas（如果是支持schema的数据库类型）
      if (supportsSchemaBrowsing()) {
        try {
          const schemas = await DbmApi.getSchemas(props.connection.id, data.dbName);
          
          if (schemas.length > 0) {
            // 如果有schemas，则显示schema列表
            const schemaNodes = schemas.map(schema => ({
              id: createSchemaNodeId(data.dbName, schema),
              label: schema,
              type: 'schema',
              dbId: data.dbId,
              dbName: data.dbName,
              schemaName: schema,
              isLeaf: false
            }));
            
            // 添加表、视图和存储过程文件夹节点
	            schemaNodes.push(
	              {
	                id: createFolderNodeId('tables', data.dbName, undefined),
	                label: t('folders.tables'),
                type: 'folder',
                dbId: data.dbId,
                dbName: data.dbName,
                folderType: 'tables',
                isLeaf: false
              },
	              {
	                id: createFolderNodeId('views', data.dbName, undefined),
	                label: t('folders.views'),
                type: 'folder',
                dbId: data.dbId,
                dbName: data.dbName,
                folderType: 'views',
                isLeaf: false
              },
	              {
	                id: createFolderNodeId('procedures', data.dbName, undefined),
	                label: t('folders.procedures'),
                type: 'folder',
                dbId: data.dbId,
                dbName: data.dbName,
                folderType: 'procedures',
                isLeaf: false
              }
            );
            
            return schemaNodes;
          }
        } catch (error) {
          // 如果获取schemas失败，则继续加载表（适用于没有schema概念的数据库）
          console.warn(`无法获取数据库 ${data.dbName} 的schemas，尝试直接加载表:`, error);
        }
      }

      // 加载表、视图和存储过程
      const [tables, views, procedures] = await Promise.allSettled([
        DbmApi.getTables(props.connection.id, data.dbName, null),
        DbmApi.getViews(props.connection.id, data.dbName, null),
        DbmApi.getProcedures(props.connection.id, data.dbName, null)
      ]);

      const children: TreeData[] = [];

      // 添加表节点
      if (tables.status === 'fulfilled') {
        children.push(...tables.value.map(tableName => ({
          id: `table_${data.dbName}_${tableName}`,
          label: tableName,
          type: 'table',
          dbId: data.dbId,
          dbName: data.dbName,
          tableName: tableName,
          isLeaf: true
        })));
      }

      // 添加视图节点
      if (views.status === 'fulfilled') {
        children.push(...views.value.map(viewName => ({
          id: `view_${data.dbName}_${viewName}`,
          label: viewName,
          type: 'view',
          dbId: data.dbId,
          dbName: data.dbName,
          viewName: viewName,
          isLeaf: true
        })));
      }

      // 添加存储过程节点
      if (procedures.status === 'fulfilled') {
        children.push(...procedures.value.map(procName => ({
          id: `proc_${data.dbName}_${procName}`,
          label: procName,
          type: 'procedure',
          dbId: data.dbId,
          dbName: data.dbName,
          procedureName: procName,
          isLeaf: true
        })));
      }

      return children;
    } else if (data.type === 'schema') {
      // 为schema加载表、视图和存储过程文件夹
	      return [
	        {
	          id: createFolderNodeId('tables', data.dbName, data.schemaName),
	          label: t('folders.tables'),
          type: 'folder',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          folderType: 'tables',
          isLeaf: false
        },
	        {
	          id: createFolderNodeId('views', data.dbName, data.schemaName),
	          label: t('folders.views'),
          type: 'folder',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          folderType: 'views',
          isLeaf: false
        },
	        {
	          id: createFolderNodeId('procedures', data.dbName, data.schemaName),
	          label: t('folders.procedures'),
          type: 'folder',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          folderType: 'procedures',
          isLeaf: false
        }
      ];
    } else if (data.type === 'folder') {
      // 加载文件夹内容：表、视图或存储过程
      if (data.folderType === 'tables') {
        const tables = await DbmApi.getTables(props.connection.id, data.dbName, data.schemaName || null);
        return tables.map(tableName => ({
          id: `table_${data.dbName}_${data.schemaName ? data.schemaName + '_' + tableName : tableName}`,
          label: tableName,
          type: 'table',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          tableName: tableName,
          isLeaf: true
        }));
      } else if (data.folderType === 'views') {
        const views = await DbmApi.getViews(props.connection.id, data.dbName, data.schemaName || null);
        return views.map(viewName => ({
          id: `view_${data.dbName}_${data.schemaName ? data.schemaName + '_' + viewName : viewName}`,
          label: viewName,
          type: 'view',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          viewName: viewName,
          isLeaf: true
        }));
      } else if (data.folderType === 'procedures') {
        const procedures = await DbmApi.getProcedures(props.connection.id, data.dbName, data.schemaName || null);
        return procedures.map(procName => ({
          id: `proc_${data.dbName}_${data.schemaName ? data.schemaName + '_' + procName : procName}`,
          label: procName,
          type: 'procedure',
          dbId: data.dbId,
          dbName: data.dbName,
          schemaName: data.schemaName,
          procedureName: procName,
          isLeaf: true
        }));
      }
    }
    
    return [];
  } catch (error) {
    console.error('Failed to load node data:', error);
    let errorMessage = t('messages.loadFailed');
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    
    // 对于SQL Server，如果没有指定schema的情况，显示提示信息
    if (props.connection.db_type === 'sqlserver' && errorMessage.includes('must specify a schema')) {
      ElMessage.error(t('messages.sqlServerSchemaRequired'));
      return [];
    }
    
    ElMessage.error(errorMessage);
    return [];
  }
};

// 初始化加载数据库列表
const loadDatabaseList = async (options: { preserveExpandedKeys?: string[]; restoreSelection?: boolean } = {}) => {
  try {
    // 获取数据库列表
    const databases = await DbmApi.getDatabases(props.connection.id);
    if (databases.length === 0) {
      ElMessage.info(t('messages.noDatabasesFound'));
      return;
    }

    // 设置树的第一层为数据库列表
    treeData.value = databases.map(db => ({
      id: `db_${db}`,
      label: db,
      type: 'database',
      dbId: props.connection.id,
      dbName: db,
      isLeaf: false
    }));
    await nextTick();
    applyCurrentFilter();
    await restoreExpandedKeys(options.preserveExpandedKeys ?? expandedKeys.value ?? props.initialExpandedKeys, {
      deep: true,
      restoreSelection: options.restoreSelection ?? true
    });
  } catch (error) {
    console.error('Failed to load database list:', error);
    // 解析错误信息
    let errorMessage = t('messages.unknownError');
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = (error as any).message || (error as any).msg || JSON.stringify(error);
    }
    ElMessage.error(t('messages.loadDatabaseListFailed', { error: errorMessage }));
  }
};

const refreshObjectList = async (type?: ObjectListType, dbName?: string, schemaName?: string) => {
  const preserveExpandedKeys = normalizeExpandedKeys([
    ...expandedKeys.value,
    ...(dbName ? [`db_${dbName}`] : []),
    ...(dbName && schemaName ? [createSchemaNodeId(dbName, schemaName)] : []),
    ...(type && dbName ? [createFolderNodeId(type, dbName, schemaName)] : [])
  ]);

  await loadDatabaseList({
    preserveExpandedKeys,
    restoreSelection: true
  });
};

// 监听连接状态变化
watch(() => props.isConnected, (newIsConnected) => {
  if (newIsConnected) {
    nextTick(() => {
      loadDatabaseList();
    });
  } else {
    // 断开连接时清空树数据
    treeData.value = [];
    expandedKeys.value = [];
  }
}, { immediate: true });

watch(
  () => props.initialExpandedKeys,
  (keys) => {
    void restoreExpandedKeys(keys);
  }
);

watch(
  () => props.initialSelectedNode,
  async (selection) => {
    const selectedNodeKey = getNodeKeyFromSelection(selection);
    if (!selectedNodeKey || !props.isConnected) {
      return;
    }
    await nextTick();
    treeRef.value?.setCurrentKey?.(selectedNodeKey);
  }
);

// 模拟加载节点
const loadNode = (node: any, resolve: (data: TreeNode[]) => void) => {
  const resolveWithFilter = (data: TreeNode[]) => {
    resolve(data);
    nextTick(() => {
      applyCurrentFilter();
    });
  };

  if (node.level === 0) {
    // 第一层是数据库列表，已经在onMounted中加载，这里不再处理
    resolveWithFilter([]);
  } else if (node.data.type === 'database') {
    const dbType = props.connection.db_type?.toLowerCase();

    if (dbType === 'redis') {
      return resolveWithFilter([
        {
          id: `tables_${node.data.dbName}`,
          label: t('folders.redisKeys'),
          type: 'folder',
          dbId: node.data.dbId,
          dbName: node.data.dbName,
          isLeaf: false
        }
      ]);
    }

    if (dbType === 'mongodb') {
      return resolveWithFilter([
        {
          id: `tables_${node.data.dbName}`,
          label: t('folders.collections'),
          type: 'folder',
          dbId: node.data.dbId,
          dbName: node.data.dbName,
          isLeaf: false
        }
      ]);
    }

    if (dbType === 'elasticsearch') {
      return resolveWithFilter([
        {
          id: `tables_${node.data.dbName}`,
          label: t('folders.indices'),
          type: 'folder',
          dbId: node.data.dbId,
          dbName: node.data.dbName,
          isLeaf: false
        }
      ]);
    }

    if (dbType === 'kafka') {
      return resolveWithFilter([
        {
          id: `tables_${node.data.dbName}`,
          label: t('folders.topics'),
          type: 'folder',
          dbId: node.data.dbId,
          dbName: node.data.dbName,
          isLeaf: false
        }
      ]);
    }

    if (dbType === 'clickhouse' || dbType === 'snowflake') {
      return resolveWithFilter([
        {
          id: `tables_${node.data.dbName}`,
          label: t('folders.tables'),
          type: 'folder',
          dbId: node.data.dbId,
          dbName: node.data.dbName,
          isLeaf: false
        }
      ]);
    }

    if (['postgresql', 'sqlserver', 'kingbasees', 'dameng', 'oracle'].includes(dbType || '')) {
      void DbmApi.getSchemas(node.data.dbId, node.data.dbName)
        .then((schemas) =>
          resolveWithFilter(
            schemas.map((schemaName) => ({
              id: createSchemaNodeId(node.data.dbName, schemaName),
              label: schemaName,
              type: 'schema',
              dbId: node.data.dbId,
              dbName: node.data.dbName,
              schemaName,
              isLeaf: false
            }))
          )
        )
        .catch((error) => {
          ElMessage.error(extractDbmErrorMessage(error, t('messages.loadSchemaFailed')));
          resolveWithFilter([]);
        });
      return;
    }

    // 加载指定数据库下的表、视图、存储过程目录
    const folders: TreeNode[] = [
      {
        id: `tables_${node.data.dbName}`,
        label: t('folders.tables'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        isLeaf: false
      },
      {
        id: `views_${node.data.dbName}`,
        label: t('folders.views'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        isLeaf: false
      }
    ];
    // SQLite 和 MongoDB 不支持存储过程
    if (dbType !== 'sqlite' && dbType !== 'mongodb' && dbType !== 'redis') {
      folders.push({
        id: `procedures_${node.data.dbName}`,
        label: t('folders.procedures'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        isLeaf: false
      });
    }
    resolveWithFilter(folders);
  } else if (node.data.type === 'schema') {
    const folders: TreeNode[] = [
      {
        id: createFolderNodeId('tables', node.data.dbName, node.data.schemaName),
        label: t('folders.tables'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        schemaName: node.data.schemaName,
        isLeaf: false
      },
      {
        id: createFolderNodeId('views', node.data.dbName, node.data.schemaName),
        label: t('folders.views'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        schemaName: node.data.schemaName,
        isLeaf: false
      },
      {
        id: createFolderNodeId('procedures', node.data.dbName, node.data.schemaName),
        label: t('folders.procedures'),
        type: 'folder',
        dbId: node.data.dbId,
        dbName: node.data.dbName,
        schemaName: node.data.schemaName,
        isLeaf: false
      }
    ];
    resolveWithFilter(folders);
  } else if (getObjectListType(node.data)) {
    loadChildren(
      getObjectListType(node.data)!,
      node.data.dbId,
      node.data.dbName,
      node.data.schemaName
    ).then(resolveWithFilter);
  } else if (node.data.type === 'redis-prefix') {
    loadRedisChildren(
      node.data.dbId,
      node.data.dbName,
      node.data.redisPrefix,
      node.data.id
    ).then(resolveWithFilter);
  } else if (node.data.type === 'table') {
    // 加载表的列
    loadTableColumns(node.data.tableName!, node.data.dbId, node.data.dbName, node.data.schemaName).then(resolveWithFilter);
  } else {
    resolveWithFilter([]);
  }
};

const createRedisLoadMoreNode = (
  dbId: string,
  dbName: string,
  parentId: string,
  prefix: string | undefined,
  cursor: string
): TreeNode => ({
  id: `redis_load_more_${parentId}_${cursor}`,
  label: t('folders.loadMore'),
  type: 'redis-load-more',
  dbId,
  dbName,
  redisPrefix: prefix,
  redisCursor: cursor,
  redisParentId: parentId,
  isLeaf: true
});

const dedupeRedisTreeNodes = (nodes: TreeNode[]) => {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
};

const mapRedisTreeNodes = (
  children: RedisTreeChild[],
  dbId: string,
  dbName: string
): TreeNode[] =>
  children.map((item) =>
    item.node_type === 'prefix'
      ? {
          id: `redis_prefix_${dbName}_${item.full_path}`,
          label: item.label,
          type: 'redis-prefix',
          dbId,
          dbName,
          redisPrefix: item.full_path,
          isLeaf: false
        }
      : {
          id: `table_${dbName}_${item.full_path}`,
          label: item.label,
          type: 'table',
          dbId,
          dbName,
          tableName: item.full_path,
          isLeaf: true
        }
  );

const buildRedisTreeNodes = (
  page: RedisTreeChildrenPage,
  dbId: string,
  dbName: string,
  parentId: string,
  prefix?: string
) => {
  const nodes = dedupeRedisTreeNodes(mapRedisTreeNodes(page.nodes, dbId, dbName));
  if (page.next_cursor) {
    nodes.push(createRedisLoadMoreNode(dbId, dbName, parentId, prefix, page.next_cursor));
  }
  return nodes;
};

const loadRedisChildren = async (
  dbId: string,
  dbName: string,
  prefix?: string,
  parentId = `tables_${dbName}`
) => {
  const redisSearchKeywords = getRedisSearchKeywords();
  const page = await DbmApi.getRedisTreeChildren(
    dbId,
    dbName,
    prefix,
    undefined,
    REDIS_TREE_PAGE_SIZE,
    redisSearchKeywords.length ? redisSearchKeywords : undefined
  );
  return buildRedisTreeNodes(page, dbId, dbName, parentId, prefix);
};

const handleLoadMoreRedisChildren = async (data: TreeData) => {
  if (!data.dbId || !data.dbName || !data.redisParentId || !data.redisCursor) {
    return;
  }

  try {
    const redisSearchKeywords = getRedisSearchKeywords();
    const page = await DbmApi.getRedisTreeChildren(
      data.dbId,
      data.dbName,
      data.redisPrefix,
      data.redisCursor,
      REDIS_TREE_PAGE_SIZE,
      redisSearchKeywords.length ? redisSearchKeywords : undefined
    );
    const parentNode = treeRef.value?.getNode?.(data.redisParentId);
    const currentChildren = ((parentNode?.childNodes || []) as Array<{ data: TreeNode }>).map(
      (child) => child.data
    );
    const stableChildren = currentChildren.filter((child) => child.type !== 'redis-load-more');
    const mergedChildren = dedupeRedisTreeNodes([
      ...stableChildren,
      ...mapRedisTreeNodes(page.nodes, data.dbId, data.dbName)
    ]);
    const nextChildren = page.next_cursor
      ? [
          ...mergedChildren,
          createRedisLoadMoreNode(
            data.dbId,
            data.dbName,
            data.redisParentId,
            data.redisPrefix,
            page.next_cursor
          )
        ]
      : mergedChildren;

    treeRef.value?.updateKeyChildren?.(data.redisParentId, nextChildren);
    await nextTick();
    applyCurrentFilter();
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('messages.loadMoreRedisKeysFailed')));
  }
};

// 加载子节点（表或视图）
const loadChildren = async (
  type: string,
  dbId: string,
  dbName: string,
  schemaName?: string
) => {
  try {
    if (type === 'tables') {
      if (props.connection.db_type?.toLowerCase() === 'redis') {
        return await loadRedisChildren(dbId, dbName, undefined, `tables_${dbName}`);
      }

      // 传递数据库名参数来获取特定数据库下的表
      const tables = await DbmApi.getTables(dbId, dbName, schemaName);
      if (tables.length === 0) {
        console.log(`No tables found in database ${dbName}`);
        return [];
      }

      return sortTableNodes(
        tables.map(table => ({
        id: createObjectNodeId('table', dbName, table, schemaName),
        label: table,
        type: 'table',
        dbId: dbId,
        dbName: dbName, // 重要：确保数据库名正确传递
        schemaName,
        tableName: table,
        isLeaf: false // 表可以展开显示列
      })),
        dbName,
        schemaName
      );
    } else if (type === 'views') {
      const views = await DbmApi.getViews(dbId, dbName, schemaName);
      if (views.length === 0) return [];
      return views.map(view => ({
        id: createObjectNodeId('view', dbName, view, schemaName),
        label: view,
        type: 'view',
        dbId: dbId,
        dbName: dbName,
        schemaName,
        tableName: view,
        isLeaf: true
      }));
    } else if (type === 'procedures') {
      const procedures = await DbmApi.getStoredProcedures(dbId, dbName, schemaName);
      if (procedures.length === 0) return [];
      return procedures.map(proc => ({
        id: createObjectNodeId('proc', dbName, proc, schemaName),
        label: proc,
        type: 'procedure',
        dbId: dbId,
        dbName: dbName,
        schemaName,
        tableName: proc,
        isLeaf: true
      }));
    }
  } catch (error) {
    console.error(`Failed to load ${type}:`, error);
    // 解析错误信息
    let errorMessage = t('messages.unknownError');
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = (error as any).message || (error as any).msg || JSON.stringify(error);
    }
    ElMessage.error(t('messages.loadTypeFailed', { type: getObjectListTypeLabel(type), error: errorMessage }));
    return [];
  }
  
  return [];
};

// 加载表的列
const loadTableColumns = async (
  tableName: string,
  dbId: string,
  dbName?: string,
  schemaName?: string
) => {
  try {
    if (props.connection.db_type?.toLowerCase() === 'redis') {
      return [];
    }

    const tableStruct = await DbmApi.getTableStruct(dbId, dbName, tableName, schemaName);
    return tableStruct.columns.map(col => ({
      id: `col_${tableName}_${col.name}`,
      label: `${col.name} (${col.data_type})`,
      type: 'column',
      dbId: dbId,
      isLeaf: true
    }));
  } catch (error) {
    console.error(`Failed to load columns for table ${tableName}:`, error);
    // 解析错误信息
    let errorMessage = t('messages.unknownError');
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      errorMessage = (error as any).message || (error as any).msg || JSON.stringify(error);
    }
    ElMessage.error(t('messages.loadTableColumnsFailed', { tableName, error: errorMessage }));
    return [];
  }
};

onMounted(() => {
  if (props.initialPinnedTables?.length) {
    pinnedTables.value = props.initialPinnedTables;
  }
  if (props.initialFilterText) {
    const initialFilterState = normalizeFilterState(props.initialFilterText);
    lastEmittedFilterStateJson = serializeFilterState(initialFilterState);
    filterKeywords.value = initialFilterState.keywords;
    filterEnabled.value = !!initialFilterState.enabled;
  }
  if (props.initialExpandedKeys?.length) {
    expandedKeys.value = normalizeExpandedKeys(props.initialExpandedKeys);
  }
});

onBeforeUnmount(() => {
  if (redisSearchReloadTimer) {
    clearTimeout(redisSearchReloadTimer);
    redisSearchReloadTimer = undefined;
  }
});

// 为父组件提供方法
defineExpose({
  handleExportTable,
  restorePinnedTables,
  getPinnedTables: () => pinnedTables.value,
  getExpandedKeys: () => [...expandedKeys.value],
  restoreExpandedKeys,
  refreshTree: () => loadDatabaseList({
    preserveExpandedKeys: expandedKeys.value,
    restoreSelection: true
  }),
  refreshObjectList
});
</script>

<style scoped lang="scss">
.dbm-tree {
}

.tree-filter {
  padding: 4px 8px;
}

.tree-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tree-filter-row :deep(.el-input-tag) {
  flex: 1;
}

.filter-toggle-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--el-input-border-color, var(--el-border-color));
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
}

.filter-toggle-button:hover {
  color: var(--el-color-primary);
  border-color: var(--el-input-hover-border-color, var(--el-border-color-hover));
}

.filter-toggle-button.active {
  color: var(--el-color-primary);
  border-color: var(--el-input-border-color, var(--el-border-color));
  background: var(--theme-primary-soft-hover);
}

.filter-toggle-icon {
  width: 15px;
  height: 15px;
}

:deep(.el-tree) {
  --el-tree-node-hover-bg-color: var(--sidebar-item-bg-color-hover);
}

:deep(.el-tree-node__content) {
  border-radius: 8px;
  transition: background-color 0.2s ease, box-shadow 0.2s ease, color 0.2s ease;
}

:deep(.el-tree-node__content:hover) {
  background: var(--sidebar-item-bg-color-hover);
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: var(--sidebar-item-bg-color-active);
  // box-shadow: inset 3px 0 0 var(--el-color-primary);
}

:deep(.el-tree-node.is-current > .el-tree-node__content .node-label),
:deep(.el-tree-node.is-current > .el-tree-node__content .el-icon) {
  color: var(--el-color-primary);
}

.tree-node {
  display: flex;
  align-items: center;
  width: 100%;
}

.tree-node .el-icon {
  margin-right: 5px;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.pinned-table-svg {
  width: 16px;
  height: 16px;
}

.node-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.node-action-icon,
.pin-icon {
  margin-left: auto;
  opacity: 0;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  &:hover { color: var(--el-color-primary); }
}

.node-action-icon {
  margin-left: 0;
}

.tree-node:hover .node-action-icon,
.tree-node:hover .pin-icon,
:deep(.el-tree-node.is-current > .el-tree-node__content) .node-action-icon,
:deep(.el-tree-node.is-current > .el-tree-node__content) .pin-icon {
  opacity: 1;
}

.node-label {
  font-size: 14px;
}

.load-more-label {
  color: var(--el-color-primary);
  font-weight: 500;
}
</style>
