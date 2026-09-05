<template>
  <div class="db-query-workbench">
    <div
      ref="queryLayoutRef"
      class="query-layout"
      :style="{ '--query-ai-side-width': `${aiSidebarWidth}px` }"
    >
      <section class="query-main">
        <div class="query-toolbar">
          <div class="query-toolbar-left">
            <span class="query-target">
              {{ targetLabel }}
            </span>
          </div>
          <div class="query-toolbar-right">
            <el-button size="small" @click="formatSql">{{ t('toolbar.formatSql') }}</el-button>
            <el-tooltip :content="t('toolbar.clearResult')" placement="bottom">
              <el-button
                size="small"
                circle
                :icon="Delete"
                :disabled="!result && !errorMessage"
                @click="clearResult"
              />
            </el-tooltip>
            <el-popover
              placement="bottom-end"
              :width="360"
              trigger="click"
              v-model:visible="historyPopoverVisible"
              popper-class="query-history-popover"
            >
              <template #reference>
                <el-tooltip :content="t('toolbar.history')" placement="bottom">
                  <el-button size="small" circle :icon="Clock" />
                </el-tooltip>
              </template>
              <div class="query-history-panel">
                <div class="query-history-header">
                  <span>{{ t('history.recent') }}</span>
                  <el-button link size="small" :disabled="!queryHistory.length" @click="clearHistory">{{ t('history.clear') }}</el-button>
                </div>
                <div v-if="queryHistory.length" class="query-history-list">
                  <div
                    v-for="item in queryHistory"
                    :key="item.id"
                    class="query-history-item"
                    @click="applyHistory(item)"
                  >
                    <div class="query-history-time">{{ item.createdAtLabel }}</div>
                    <div class="query-history-sql">{{ item.preview }}</div>
                  </div>
                </div>
                <el-empty v-else :description="t('history.empty')" :image-size="60" />
              </div>
            </el-popover>
            <el-button size="small" :disabled="executing" @click="runSelectedSql">{{ t('toolbar.runSelected') }}</el-button>
            <el-button size="small" type="primary" :loading="executing" @click="runSql">{{ t('toolbar.runAll') }}</el-button>
          </div>
        </div>

        <div class="query-editor">
          <CodeMirrorTextEditor
            ref="editorRef"
            v-model="sqlContent"
            file-path="query.sql"
            :placeholder="t('editorPlaceholder')"
          />
        </div>

        <div class="query-result">
          <div class="query-result-header">
            <span class="query-result-title">{{ t('result.title') }}</span>
            <span class="query-result-meta">
              {{ resultSummary }}
            </span>
          </div>

          <div v-if="errorMessage" class="query-error">
            {{ errorMessage }}
          </div>

          <div v-else-if="result" class="query-table">
            <div v-if="batchErrorMessage" class="query-error query-error--inline">
              {{ batchErrorMessage }}
            </div>

            <el-tabs v-if="hasMultipleStatementResults" v-model="activeStatementTab" class="query-result-tabs">
              <el-tab-pane
                v-for="statement in statementResults"
                :key="statement.statement_index"
                :name="getStatementTabName(statement)"
              >
                <template #label>
                  <span :class="getStatementTabLabelClass(statement)">{{ getStatementTabLabel(statement) }}</span>
                </template>

                <div class="query-result-pane">
                  <div :class="['query-statement-banner', { 'query-statement-banner--error': isFailedResult(statement) }]">
                    <span class="query-statement-order">#{{ statement.statement_index }}</span>
                    <span class="query-statement-sql" :title="statement.sql">
                      {{ getStatementPreview(statement) }}
                    </span>
                    <span class="query-statement-meta">{{ getStatementResultMeta(statement) }}</span>
                  </div>

                  <div class="query-result-content">
                    <div v-if="isFailedResult(statement)" class="query-execution-placeholder query-execution-placeholder--error">
                      <el-empty :description="t('result.statementFailed')" :image-size="66" />
                      <div class="query-statement-error-text">
                        {{ getResultErrorMessage(statement) }}
                      </div>
                    </div>

                    <el-table
                      v-else-if="shouldShowTableResult(statement)"
                      :data="toTableRows(statement)"
                      border
                      size="small"
                      height="100%"
                      :empty-text="t('result.noReturnedData')"
                    >
                      <el-table-column
                        v-for="column in statement.columns"
                        :key="column"
                        :prop="column"
                        :label="column"
                        min-width="140"
                        show-overflow-tooltip
                      />
                    </el-table>

                    <div v-else class="query-execution-placeholder">
                      <el-empty :description="getResultEmptyDescription(statement)" :image-size="66" />
                      <div class="query-summary-meta">
                        <span>{{ getResultEmptyMeta(statement) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </el-tab-pane>
            </el-tabs>

            <template v-else>
              <div v-if="isFailedResult(activeResultView)" class="query-execution-placeholder query-execution-placeholder--error">
                <el-empty :description="t('result.statementFailed')" :image-size="66" />
                <div class="query-statement-error-text">
                  {{ getResultErrorMessage(activeResultView) }}
                </div>
              </div>
              <el-table
                v-else-if="shouldShowTableResult(activeResultView)"
                :data="toTableRows(activeResultView)"
                border
                size="small"
                height="100%"
                :empty-text="t('result.noReturnedData')"
              >
                <el-table-column
                  v-for="column in activeResultView?.columns || []"
                  :key="column"
                  :prop="column"
                  :label="column"
                  min-width="140"
                  show-overflow-tooltip
                />
              </el-table>
              <div v-else class="query-execution-placeholder">
                <el-empty :description="getResultEmptyDescription(activeResultView)" :image-size="66" />
                <div class="query-summary-meta">
                  <span>{{ getResultEmptyMeta(activeResultView) }}</span>
                </div>
              </div>
            </template>
          </div>

          <el-empty v-else :description="t('result.empty')" />
        </div>
      </section>

      <SplitResizeHandle
        class="query-ai-resize-handle"
        :dragging="aiSidebarResizing"
        @pointerdown="startAiSidebarResize"
      />

      <aside class="query-ai-side">
        <div class="query-ai-header">
          <div class="query-ai-title">
            <span>{{ t('ai.title') }}</span>
            <el-tag size="small" type="info">
              {{ currentConnection?.db_type || 'db' }}
            </el-tag>
          </div>
          <el-tag size="small" :type="aiSchemaStatusTag">
            {{ aiSchemaStatusText }}
          </el-tag>
        </div>

        <div class="query-ai-summary" :class="{ 'is-error': !!schemaError }">
          {{ aiSchemaSummary }}
        </div>

        <AiChatPanel
          v-model:messages="aiMessages"
          v-model:input-value="aiInput"
          :chat-prefix="aiChatPrefix"
          :initial-messages="initialAiMessages"
          theme="dashboard"
          :loading="aiLoading"
          :error-text="aiError"
          :submit-disabled="!canUseAiAssistant"
          :placeholder="t('ai.placeholder')"
          :hint-text="aiHintText"
          :submit-button-text="t('ai.submit')"
          :empty-description="t('ai.empty')"
          @submit="submitAiPrompt"
          @history-loaded="handleAiHistoryLoaded"
        >
          <template #actions>
            <el-button size="small" :loading="schemaLoading" @click="refreshAiSchema">{{ t('ai.refreshSchema') }}</el-button>
            <el-button size="small" :disabled="!lastGeneratedSql.trim()" @click="appendGeneratedSql">
              {{ t('ai.appendSql') }}
            </el-button>
          </template>
        </AiChatPanel>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Clock, Delete } from '@element-plus/icons-vue';
import type { DbConnection, QueryResult, QueryStatementResult, TableStruct } from './service';
import { DbmApi, extractDbmErrorMessage } from './service';
import AiChatPanel from '@/platform/ui/common/ai/AiChatPanel.vue';
import CodeMirrorTextEditor from '@/platform/ui/common/CodeMirrorTextEditor.vue';
import SplitResizeHandle from '@/platform/ui/common/SplitResizeHandle.vue';
import { useDragResize } from '@/platform/ui/common/useDragResize';
import { createAiChatMessage, OtoolsAiApi, type AiChatMessage } from '@/utils/ai';
import { useDbSchemaContext } from './useDbSchemaContext';
import { useI18nScope } from '@/platform/i18n';
import {
  buildHistoryPreview,
  buildQueryResultSummarySnapshot,
  formatQueryTimestampLabel,
  mergeQueryHistoryEntries,
  normalizeQueryHistoryEntries,
  normalizeQueryWorkbenchState,
  QUERY_HISTORY_LIMIT,
  type QueryHistoryEntry,
  type QueryResultSummarySnapshot,
  type QueryWorkbenchState,
} from './queryWorkbenchState';

const props = defineProps<{
  connectionId: string;
  databaseName?: string;
  tableName?: string;
  initialState?: QueryWorkbenchState | null;
  resetToken?: number;
}>();

const QUERY_HISTORY_STORAGE_PREFIX = 'datasqual-query-history';
const SQL_STATE_EMIT_DELAY = 220;
const QUERY_AI_SIDEBAR_DEFAULT_WIDTH = 300;
const QUERY_AI_SIDEBAR_MIN_WIDTH = 220;
const QUERY_MAIN_MIN_WIDTH = 360;

const emit = defineEmits<{
  (e: 'state-changed', state: QueryWorkbenchState): void;
}>();
const { t } = useI18nScope('dbm.queryWorkbench');

const editorRef = ref<InstanceType<typeof CodeMirrorTextEditor> | null>(null);
const queryLayoutRef = ref<HTMLElement | null>(null);
const sqlContent = ref('');
const executing = ref(false);
const result = ref<QueryResult | null>(null);
const persistedResultSummary = ref<QueryResultSummarySnapshot | null>(null);
const errorMessage = ref('');
const historyPopoverVisible = ref(false);
const queryHistory = ref<QueryHistoryEntry[]>([]);
const activeStatementTab = ref('');
let isApplyingPersistedState = false;
let sqlStateEmitTimer: ReturnType<typeof setTimeout> | null = null;
let hasInitializedState = false;
const aiSidebarWidth = ref(QUERY_AI_SIDEBAR_DEFAULT_WIDTH);
type QueryDisplayResult = QueryResult | QueryStatementResult;

const targetLabel = computed(() =>
  props.databaseName ? t('target.currentDatabase', { databaseName: props.databaseName }) : t('target.connection', { connectionId: props.connectionId })
);

const currentConnection = ref<DbConnection | null>(null);
const aiMessages = ref<AiChatMessage[]>([]);
const aiInput = ref('');
const aiLoading = ref(false);
const aiError = ref('');
const lastGeneratedSql = ref('');
const initialAiMessages = [
  createAiChatMessage(
    'assistant',
    t('ai.initialAssistantMessage')
  ),
];

const resolvedAiDatabaseName = computed(() =>
  (props.databaseName || currentConnection.value?.database || '').trim()
);

const {
  tableStructs,
  schemaLoading,
  schemaError,
  ensureSchemaLoaded,
} = useDbSchemaContext({
  connectionId: computed(() => props.connectionId),
  databaseName: resolvedAiDatabaseName,
  errorFallback: t('messages.loadSchemaCacheFailed'),
});

const aiChatPrefix = computed(
  () => `dbm-query-${props.connectionId}-${resolvedAiDatabaseName.value || 'default'}`
);

const canUseAiAssistant = computed(() =>
  !!props.connectionId && !!resolvedAiDatabaseName.value && !schemaLoading.value
);

const aiSchemaStatusTag = computed(() => {
  if (schemaLoading.value) {
    return 'warning';
  }
  if (schemaError.value) {
    return 'danger';
  }
  if (tableStructs.value.length) {
    return 'success';
  }
  return 'info';
});

const aiSchemaStatusText = computed(() => {
  if (schemaLoading.value) {
    return t('ai.schemaStatus.analyzing');
  }
  if (schemaError.value) {
    return t('ai.schemaStatus.failed');
  }
  if (tableStructs.value.length) {
    return t('ai.schemaStatus.ready');
  }
  return t('ai.schemaStatus.unloaded');
});

const aiHintText = computed(() => {
  if (schemaLoading.value) {
    return t('ai.hint.loading');
  }
  if (schemaError.value) {
    return schemaError.value;
  }
  if (!tableStructs.value.length) {
    return t('ai.hint.noSchema');
  }
  return t('ai.hint.loaded', { tableCount: tableStructs.value.length });
});

const aiSchemaSummary = computed(() => {
  if (!props.connectionId) {
    return t('ai.summary.noConnection');
  }
  if (!resolvedAiDatabaseName.value) {
    return t('ai.summary.noDatabaseName');
  }
  if (schemaLoading.value) {
    return t('ai.summary.loading', { databaseName: resolvedAiDatabaseName.value });
  }
  if (schemaError.value) {
    return schemaError.value;
  }
  if (!tableStructs.value.length) {
    return t('ai.summary.noTables', { databaseName: resolvedAiDatabaseName.value });
  }
  return t('ai.summary.loaded', { databaseName: resolvedAiDatabaseName.value, tableCount: tableStructs.value.length });
});

const queryHistoryStorageKey = computed(() =>
  `${QUERY_HISTORY_STORAGE_PREFIX}:${props.connectionId}:${props.databaseName || 'default'}`
);

const normalizeSqlForInspection = (value: string) => {
  let normalized = value.trim();

  while (normalized.startsWith('--') || normalized.startsWith('/*')) {
    if (normalized.startsWith('--')) {
      const newlineIndex = normalized.indexOf('\n');
      if (newlineIndex < 0) {
        return '';
      }
      normalized = normalized.slice(newlineIndex + 1).trimStart();
      continue;
    }

    const commentEnd = normalized.indexOf('*/');
    if (commentEnd < 0) {
      return '';
    }
    normalized = normalized.slice(commentEnd + 2).trimStart();
  }

  return normalized;
};

const sqlLikelyReturnsRows = (value: string) => {
  const normalized = normalizeSqlForInspection(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  const firstToken = normalized.split(/\s+/)[0] || '';
  if (['select', 'show', 'describe', 'desc', 'explain', 'with', 'pragma', 'values', 'call'].includes(firstToken)) {
    return true;
  }

  if (['insert', 'update', 'delete'].includes(firstToken)) {
    return normalized.includes(' returning ');
  }

  return false;
};

const SQL_RESERVED_TOKENS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'as', 'and',
  'or', 'not', 'null', 'is', 'in', 'exists', 'like', 'between', 'distinct', 'union',
  'all', 'case', 'when', 'then', 'else', 'end', 'with', 'recursive', 'into', 'update',
  'delete', 'insert', 'values', 'set', 'create', 'alter', 'drop', 'table', 'view',
  'index', 'primary', 'key', 'foreign', 'constraint', 'references', 'default',
  'true', 'false', 'asc', 'desc', 'show', 'explain', 'pragma', 'count', 'sum', 'avg',
  'min', 'max', 'date', 'datetime', 'strftime', 'date_format', 'to_char', 'date_trunc',
  'cast', 'coalesce', 'ifnull', 'nullif', 'current_date', 'current_time',
  'current_timestamp', 'now', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'interval', 'over', 'partition', 'rows', 'range', 'unbounded', 'preceding',
  'following', 'current', 'row', 'filter', 'extract', 'using', 'returning', 'top',
  'fetch', 'next', 'only', 'regexp', 'rlike', 'ilike', 'replace', 'substring',
  'substr', 'trim', 'round', 'concat',
]);

const stripIdentifierQuotes = (value: string) => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const canonicalizeSqlIdentifier = (value: string) =>
  stripIdentifierQuotes(value).trim().toLowerCase();

const splitQualifiedIdentifier = (value: string) =>
  value
    .split(/\s*\.\s*/)
    .map((segment) => stripIdentifierQuotes(segment))
    .filter(Boolean);

const sanitizeSqlForValidation = (value: string) =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:''|\\'|[^'])*'/g, "''");

const extractCteNames = (sql: string) => {
  const names = new Set<string>();
  const regex = /\b(?:with(?:\s+recursive)?|,)\s*((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))\s+as\s*\(/gi;

  for (const match of sql.matchAll(regex)) {
    const key = canonicalizeSqlIdentifier(match[1] || '');
    if (key) {
      names.add(key);
    }
  }

  return names;
};

const extractDerivedTableAliases = (sql: string) => {
  const aliases = new Set<string>();
  const regex = /\)\s*(?:as\s+)?((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))/gi;

  for (const match of sql.matchAll(regex)) {
    const key = canonicalizeSqlIdentifier(match[1] || '');
    if (key && !SQL_RESERVED_TOKENS.has(key)) {
      aliases.add(key);
    }
  }

  return aliases;
};

const extractTableReferences = (sql: string) => {
  const refs: Array<{ tableKey: string; aliasKey: string | null; displayName: string }> = [];
  const regex = /\b(from|join|update|into)\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))?)(?:\s+(?:as\s+)?((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+)))?/gi;

  for (const match of sql.matchAll(regex)) {
    const rawTable = match[2] || '';
    if (!rawTable || rawTable.trim().startsWith('(')) {
      continue;
    }

    const segments = splitQualifiedIdentifier(rawTable);
    const tableName = segments[segments.length - 1] || '';
    const tableKey = canonicalizeSqlIdentifier(tableName);
    if (!tableKey) {
      continue;
    }

    const rawAlias = match[3] || '';
    const aliasKey = rawAlias
      ? canonicalizeSqlIdentifier(rawAlias)
      : null;
    refs.push({
      tableKey,
      aliasKey: aliasKey && !SQL_RESERVED_TOKENS.has(aliasKey) ? aliasKey : null,
      displayName: tableName,
    });
  }

  return refs;
};

const extractSelectAliases = (sql: string) => {
  const aliases = new Set<string>();
  const regex = /\bas\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))/gi;

  for (const match of sql.matchAll(regex)) {
    const alias = canonicalizeSqlIdentifier(match[1] || '');
    if (alias && !SQL_RESERVED_TOKENS.has(alias)) {
      aliases.add(alias);
    }
  }

  return aliases;
};

const extractUnqualifiedIdentifiers = (sql: string) => {
  const tokens = new Set<string>();
  const regex = /\b([A-Za-z_][A-Za-z0-9_$]*)\b/g;

  for (const match of sql.matchAll(regex)) {
    const token = match[1] || '';
    const normalized = token.toLowerCase();
    const start = match.index ?? 0;
    const end = start + token.length;
    const before = sql[start - 1] || '';
    const after = sql[end] || '';
    const nextNonSpace = sql.slice(end).match(/^\s*(.)/)?.[1] || '';

    if (
      before === '.'
      || after === '.'
      || before === '`'
      || after === '`'
      || before === '"'
      || after === '"'
      || before === '['
      || after === ']'
      || SQL_RESERVED_TOKENS.has(normalized)
      || nextNonSpace === '('
    ) {
      continue;
    }

    tokens.add(normalized);
  }

  return tokens;
};

const formatSqlValidationMessage = (issues: string[]) => {
  const uniqueIssues = Array.from(new Set(issues)).slice(0, 8);
  if (!uniqueIssues.length) {
    return '';
  }

  return [
    t('messages.sqlValidationBlocked'),
    ...uniqueIssues.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
};

const validateGeneratedSqlAgainstSchema = (sql: string, tables: TableStruct[]) => {
  const sanitizedSql = sanitizeSqlForValidation(sql);
  const tableColumns = new Map<string, Set<string>>();
  const tableNames = new Map<string, string>();

  tables.forEach((table) => {
    const tableKey = canonicalizeSqlIdentifier(table.table_name);
    tableNames.set(tableKey, table.table_name);
    tableColumns.set(
      tableKey,
      new Set(table.columns.map((column) => canonicalizeSqlIdentifier(column.name)))
    );
  });

  const issues: string[] = [];
  const cteNames = extractCteNames(sanitizedSql);
  const derivedAliases = extractDerivedTableAliases(sanitizedSql);
  const aliasToTable = new Map<string, string>();
  const referencedTables = new Set<string>();

  extractTableReferences(sanitizedSql).forEach((ref) => {
    if (cteNames.has(ref.tableKey)) {
      if (ref.aliasKey) {
        aliasToTable.set(ref.aliasKey, '__cte__');
      }
      return;
    }

    if (!tableColumns.has(ref.tableKey)) {
      issues.push(t('messages.sqlUnknownTable', { tableName: ref.displayName }));
      return;
    }

    referencedTables.add(ref.tableKey);
    aliasToTable.set(ref.tableKey, ref.tableKey);
    if (ref.aliasKey) {
      aliasToTable.set(ref.aliasKey, ref.tableKey);
    }
  });

  const qualifiedRefRegex = /((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))\s*\.\s*((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|\w+))/g;
  for (const match of sanitizedSql.matchAll(qualifiedRefRegex)) {
    const leftKey = canonicalizeSqlIdentifier(match[1] || '');
    const rightRaw = stripIdentifierQuotes(match[2] || '');
    const rightKey = canonicalizeSqlIdentifier(rightRaw);

    if (!leftKey || !rightKey || rightRaw === '*') {
      continue;
    }

    if (cteNames.has(leftKey) || derivedAliases.has(leftKey)) {
      continue;
    }

    const resolvedTableKey = aliasToTable.get(leftKey) || (tableColumns.has(leftKey) ? leftKey : null);
    if (!resolvedTableKey) {
      issues.push(t('messages.sqlUnknownReference', {
        reference: `${stripIdentifierQuotes(match[1] || '')}.${rightRaw}`,
      }));
      continue;
    }
    if (resolvedTableKey === '__cte__') {
      continue;
    }

    const validColumns = tableColumns.get(resolvedTableKey);
    if (!validColumns?.has(rightKey)) {
      issues.push(t('messages.sqlUnknownColumn', {
        tableName: tableNames.get(resolvedTableKey) || stripIdentifierQuotes(match[1] || ''),
        columnName: rightRaw,
      }));
    }
  }

  if (referencedTables.size === 1) {
    const [singleTableKey] = Array.from(referencedTables);
    const validColumns = tableColumns.get(singleTableKey) || new Set<string>();
    const allowedNames = new Set([
      ...aliasToTable.keys(),
      ...cteNames,
      ...derivedAliases,
      ...extractSelectAliases(sanitizedSql),
      singleTableKey,
    ]);

    extractUnqualifiedIdentifiers(sanitizedSql).forEach((token) => {
      if (allowedNames.has(token) || validColumns.has(token)) {
        return;
      }
      issues.push(t('messages.sqlUnknownColumn', {
        tableName: tableNames.get(singleTableKey) || singleTableKey,
        columnName: token,
      }));
    });
  }

  return Array.from(new Set(issues));
};

const pushAssistantNotice = (content: string) => {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return;
  }

  const lastMessage = aiMessages.value[aiMessages.value.length - 1];
  if (lastMessage?.role === 'assistant' && lastMessage.content.trim() === normalizedContent) {
    return;
  }

  aiMessages.value = [...aiMessages.value, createAiChatMessage('assistant', normalizedContent)];
};

const validateGeneratedSqlBeforeAppend = async (
  sql: string,
  options: { appendNotice?: boolean } = {}
) => {
  const normalizedSql = sql.trim();
  if (!normalizedSql) {
    return {
      valid: false,
      message: t('messages.noSqlToValidate'),
    };
  }

  await loadAiSchemaContext();

  if (!tableStructs.value.length) {
    const message = schemaError.value || t('messages.noSchemaForValidation');
    aiError.value = message;
    lastGeneratedSql.value = '';
    if (options.appendNotice) {
      pushAssistantNotice(`${t('messages.sqlValidationNotice')}\n${message}`);
    }
    return {
      valid: false,
      message,
    };
  }

  const issues = validateGeneratedSqlAgainstSchema(normalizedSql, tableStructs.value);
  if (issues.length) {
    const message = formatSqlValidationMessage(issues);
    aiError.value = message;
    lastGeneratedSql.value = '';
    if (options.appendNotice) {
      pushAssistantNotice(message);
    }
    return {
      valid: false,
      message,
    };
  }

  aiError.value = '';
  return {
    valid: true,
    message: '',
  };
};

const normalizeText = (value: string) => value.toLowerCase().replace(/[`"'_\-\s]+/g, '');

const buildKeywordHints = (prompt: string) => {
  const normalized = prompt.toLowerCase();
  const hints: string[] = [];
  const keywordGroups: Array<[string[], string[]]> = [
    [['用户', '会员', '账号', '账户', '注册', '活跃', '登录', '客户'], ['user', 'users', 'member', 'members', 'account', 'accounts', 'customer', 'customers', 'login']],
    [['订单', '交易', '成交', '支付', '销售', '营收', '收入'], ['order', 'orders', 'trade', 'trades', 'payment', 'payments', 'sale', 'sales', 'invoice', 'billing']],
    [['商品', '产品', '库存', 'sku'], ['product', 'products', 'goods', 'item', 'items', 'sku', 'inventory']],
    [['地区', '区域', '省份', '城市'], ['region', 'regions', 'area', 'areas', 'province', 'city', 'country']],
    [['日志', '记录', '事件', '审计'], ['log', 'logs', 'record', 'records', 'event', 'events', 'audit']],
  ];

  for (const [cnWords, enWords] of keywordGroups) {
    if (cnWords.some((word) => prompt.includes(word)) || enWords.some((word) => normalized.includes(word))) {
      hints.push(...enWords);
    }
  }

  return Array.from(new Set(hints));
};

const scoreTableAgainstPrompt = (table: TableStruct, prompt: string) => {
  const promptText = normalizeText(prompt);
  const keywordHints = buildKeywordHints(prompt);
  const tableName = normalizeText(table.table_name);
  let score = 0;

  if (promptText && tableName && promptText.includes(tableName)) {
    score += 40;
  }

  if (table.comment && prompt.includes(table.comment)) {
    score += 20;
  }

  for (const hint of keywordHints) {
    if (tableName.includes(hint)) {
      score += 12;
    }
    for (const column of table.columns) {
      const columnName = normalizeText(column.name);
      if (columnName.includes(hint)) {
        score += 4;
      }
    }
  }

  for (const column of table.columns) {
    const columnName = normalizeText(column.name);
    if (promptText && columnName && promptText.includes(columnName)) {
      score += 5;
    }
  }

  if (!score) {
    score += table.primary_keys.length ? 1 : 0;
    score += table.foreign_keys.length ? 1 : 0;
  }

  return score;
};

const pickRelevantTables = (tables: TableStruct[], prompt: string) => {
  const ranked = [...tables].map((table) => ({
    table,
    score: scoreTableAgainstPrompt(table, prompt),
  }));
  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.table.table_name.localeCompare(right.table.table_name);
  });

  const selected = ranked.filter((item) => item.score > 0).slice(0, 8).map((item) => item.table);
  return selected.length ? selected : [...tables].slice(0, 8);
};

const formatTableForPrompt = (table: TableStruct) => {
  const columns = table.columns.map((column) => {
    const flags = [];
    if (column.is_primary_key) {
      flags.push('PK');
    }
    if (!column.is_nullable) {
      flags.push('NOT NULL');
    }
    if (column.column_comment) {
      flags.push(t('prompt.labels.commentWithValue', { comment: column.column_comment }));
    }
    return `${column.name} ${column.data_type}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
  });

  const foreignKeys = table.foreign_keys.length
    ? table.foreign_keys
      .slice(0, 6)
      .map((item) => `${item.column_name}->${item.referenced_table}.${item.referenced_column}`)
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
    t('prompt.labels.foreignKeysLine', { foreignKeys }),
  ].join('\n');
};

const buildSchemaPromptContext = (prompt: string) => {
  if (!tableStructs.value.length) {
    return t('prompt.noSchema');
  }

  const relevantTables = pickRelevantTables(tableStructs.value, prompt);
  const details = relevantTables.map((table, index) => `${index + 1}. ${formatTableForPrompt(table)}`);

  return [
    t('prompt.labels.connectionName', { value: currentConnection.value?.name || props.connectionId }),
    t('prompt.labels.databaseType', { value: currentConnection.value?.db_type || '-' }),
    t('prompt.labels.databaseName', { value: resolvedAiDatabaseName.value || '-' }),
    t('prompt.labels.tableCount', { count: tableStructs.value.length }),
    t('prompt.labels.allTableNames', {
      value: tableStructs.value.map((table) => table.table_name).join(', ') || t('prompt.values.none'),
    }),
    t('prompt.labels.focusTable', { value: props.tableName || t('prompt.values.none') }),
    t('prompt.labels.focusedStructures'),
    ...details,
  ].join('\n');
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

const buildConversationContext = (messages: AiChatMessage[]) => {
  const recentMessages = messages.slice(-6);
  if (!recentMessages.length) {
    return t('prompt.values.none');
  }

  return recentMessages
    .map((item) => `${item.role === 'user' ? t('prompt.roles.user') : t('prompt.roles.assistant')}: ${item.content}`)
    .join('\n');
};

const extractSqlFromAiResponse = (content: string) => {
  const codeBlocks = Array.from(content.matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi))
    .map((match) => (match[1] || '').trim())
    .filter(Boolean);

  if (codeBlocks.length) {
    return codeBlocks[codeBlocks.length - 1];
  }

  const fallback = content.trim();
  if (/^(select|with|show|explain|pragma|insert|update|delete|create|alter|drop)\b/i.test(fallback)) {
    return fallback;
  }

  return '';
};

const ensureAiConnectionLoaded = async () => {
  if (!props.connectionId) {
    currentConnection.value = null;
    return null;
  }

  if (currentConnection.value?.id === props.connectionId) {
    return currentConnection.value;
  }

  try {
    const connection = await DbmApi.getConnection(props.connectionId);
    currentConnection.value = connection;
    return connection;
  } catch (error) {
    if (!props.databaseName) {
      currentConnection.value = null;
    }
    throw error;
  }
};

const loadAiSchemaContext = async (force = false) => {
  if (!props.connectionId) {
    currentConnection.value = null;
    return;
  }

  try {
    await ensureAiConnectionLoaded();
  } catch {
    if (!props.databaseName) {
      return;
    }
  }

  if (!resolvedAiDatabaseName.value) {
    return;
  }

  await ensureSchemaLoaded(force);
};

const refreshAiSchema = async () => {
  await loadAiSchemaContext(true);
  if (schemaError.value) {
    ElMessage.error(schemaError.value);
    return;
  }
  ElMessage.success(t('messages.schemaRefreshed'));
};

const handleAiHistoryLoaded = (messages: AiChatMessage[]) => {
  aiMessages.value = messages;
  const latestAssistantMessage = [...messages].reverse().find((item) => item.role === 'assistant');
  lastGeneratedSql.value = latestAssistantMessage
    ? extractSqlFromAiResponse(latestAssistantMessage.content)
    : '';
};

const appendGeneratedSql = async () => {
  const nextSql = lastGeneratedSql.value.trim();
  if (!nextSql) {
    ElMessage.warning(t('messages.noSqlToAppend'));
    return;
  }

  const validation = await validateGeneratedSqlBeforeAppend(nextSql, { appendNotice: true });
  if (!validation.valid) {
    ElMessage.error(t('messages.sqlValidationFailed'));
    return;
  }

  const currentSql = sqlContent.value.trimEnd();
  sqlContent.value = currentSql ? `${currentSql}\n\n${nextSql}` : nextSql;
  editorRef.value?.focus?.();
  ElMessage.success(t('messages.sqlAppended'));
};

const submitAiPrompt = async (prompt: string) => {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return;
  }

  if (!props.connectionId) {
    ElMessage.warning(t('messages.noConnectionSelected'));
    return;
  }

  aiError.value = '';
  aiLoading.value = true;
  const historyContext = buildConversationContext(aiMessages.value);
  aiMessages.value = [...aiMessages.value, createAiChatMessage('user', normalizedPrompt)];

  try {
    await loadAiSchemaContext();
    if (!resolvedAiDatabaseName.value) {
      throw new Error(t('messages.noResolvedDatabaseName'));
    }
    if (!tableStructs.value.length) {
      throw new Error(schemaError.value || t('messages.noSchemaForGeneration'));
    }

    const response = await OtoolsAiApi.generateText({
      systemPrompt: t('prompt.aiSystem'),
      userPrompt: t('prompt.aiUser', {
        userPrompt: normalizedPrompt,
        connectionName: currentConnection.value?.name || props.connectionId,
        databaseName: resolvedAiDatabaseName.value,
        databaseType: currentConnection.value?.db_type || '-',
        sqlDialectHint: buildSqlDialectHint(),
        currentSql: sqlContent.value.trim() || t('prompt.values.none'),
        schemaContext: buildSchemaPromptContext(normalizedPrompt),
        conversationContext: historyContext,
      }),
      temperature: 0.1,
      maxTokens: 2200,
    });

    aiMessages.value = [...aiMessages.value, createAiChatMessage('assistant', response)];
    aiInput.value = '';
    const extractedSql = extractSqlFromAiResponse(response);
    if (!extractedSql.trim()) {
      lastGeneratedSql.value = '';
      ElMessage.warning(t('messages.noExtractedSql'));
      return;
    }

    const validation = await validateGeneratedSqlBeforeAppend(extractedSql, { appendNotice: true });
    if (!validation.valid) {
      ElMessage.error(t('messages.aiSqlValidationFailed'));
      return;
    }

    lastGeneratedSql.value = extractedSql;
    if (lastGeneratedSql.value.trim()) {
      ElMessage.success(t('messages.sqlGeneratedReady'));
    } else {
      ElMessage.warning(t('messages.noExtractedSql'));
    }
  } catch (error) {
    const message = extractDbmErrorMessage(error, t('messages.aiGenerateSqlFailed'));
    aiError.value = message;
    aiMessages.value = [...aiMessages.value, createAiChatMessage('assistant', t('messages.generateFailed', { error: message }))];
  } finally {
    aiLoading.value = false;
  }
};

const lastExecutedSql = ref('');

const statementResults = computed<QueryStatementResult[]>(() => {
  if (!Array.isArray(result.value?.statements)) {
    return [];
  }
  return result.value.statements.filter((item): item is QueryStatementResult => !!item);
});

const hasMultipleStatementResults = computed(() => statementResults.value.length > 1);
const hasStatementErrors = computed(() =>
  !!result.value?.has_errors || statementResults.value.some((item) => item.success === false)
);
const batchErrorMessage = computed(() =>
  result.value?.batch_error_message
    ? extractDbmErrorMessage(result.value.batch_error_message, t('messages.sqlExecuteFailed'))
    : ''
);

const getStatementTabName = (statement: QueryStatementResult) =>
  `statement-${statement.statement_index}`;

const getStatementPreview = (statement: QueryStatementResult) =>
  statement.sql_preview || buildHistoryPreview(statement.sql);

const getStatementTypeLabel = (sql: string) => {
  const normalized = normalizeSqlForInspection(sql);
  const token = normalized.split(/\s+/)[0] || 'sql';
  return token.toUpperCase();
};

const getStatementRowCount = (statement: QueryStatementResult) =>
  typeof statement.row_count === 'number' ? statement.row_count : statement.rows.length;

const getStatementTabStatusLabel = (statement: QueryStatementResult) => {
  if (statement.success === false) {
    return t('result.status.failed');
  }

  const rowCount = getStatementRowCount(statement);
  if (resultLooksLikeQuery(statement)) {
    return t('result.status.rows', { count: rowCount });
  }

  const statementType = getStatementTypeLabel(statement.sql);
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(statementType)) {
    return t('result.status.affected', { count: rowCount });
  }

  return rowCount > 0 ? t('result.status.affected', { count: rowCount }) : t('result.status.executed');
};

const getStatementTabLabel = (statement: QueryStatementResult) =>
  `#${statement.statement_index} ${getStatementTypeLabel(statement.sql)} · ${getStatementTabStatusLabel(statement)}`;

const getStatementTabLabelClass = (statement: QueryStatementResult) => ({
  'result-tab-label': true,
  'is-error': statement.success === false
});

const isFailedResult = (value?: QueryDisplayResult | null): value is QueryStatementResult =>
  !!value && 'success' in value && value.success === false;

const resultLooksLikeQuery = (value?: QueryDisplayResult | null) => {
  if (value?.sql) {
    return sqlLikelyReturnsRows(value.sql);
  }
  return sqlLikelyReturnsRows(lastExecutedSql.value || sqlContent.value);
};

const shouldShowTableResult = (value?: QueryDisplayResult | null) =>
  !!value && (value.columns.length > 0 || value.rows.length > 0);

const toTableRows = (value?: QueryDisplayResult | null) => {
  if (!value) {
    return [];
  }

  return value.rows.map((row) =>
    Object.fromEntries(value.columns.map((column, index) => [column, row[index]]))
  );
};

const getResultErrorMessage = (value?: QueryDisplayResult | null) => {
  if (!isFailedResult(value)) {
    return '';
  }

  return extractDbmErrorMessage(value.error_message || '', t('messages.sqlExecuteFailed'));
};

const getResultEmptyDescription = (value?: QueryDisplayResult | null) => {
  if (!value) {
    return t('result.empty');
  }

  if (resultLooksLikeQuery(value)) {
    return t('result.queryZeroRows');
  }

  return t('result.noResultSet');
};

const getResultEmptyMeta = (value?: QueryDisplayResult | null) => {
  if (!value) {
    return '';
  }

  if (isFailedResult(value)) {
    return typeof value.execution_time === 'number' ? t('result.executionTime', { time: value.execution_time.toFixed(2) }) : '';
  }

  const rowCount = typeof value.row_count === 'number' ? value.row_count : value.rows.length;
  if (resultLooksLikeQuery(value)) {
    return t('result.returnedRows', { count: rowCount });
  }

  return t('result.affectedRows', { count: rowCount });
};

const getStatementResultMeta = (statement: QueryStatementResult) => {
  const executionTime = typeof statement.execution_time === 'number'
    ? `${statement.execution_time.toFixed(2)} ms`
    : t('result.unknownTime');
  if (statement.success === false) {
    return t('result.statementMeta.failed', { executionTime });
  }

  const rowCount = typeof statement.row_count === 'number' ? statement.row_count : statement.rows.length;
  return resultLooksLikeQuery(statement)
    ? t('result.statementMeta.rows', { count: rowCount, executionTime })
    : t('result.statementMeta.affected', { count: rowCount, executionTime });
};

const pickDefaultStatementTab = (items: QueryStatementResult[]) => {
  if (!items.length) {
    activeStatementTab.value = '';
    return;
  }

  const preferred = items.find((item) => item.success === false)
    || [...items].reverse().find((item) => resultLooksLikeQuery(item))
    || items[items.length - 1];
  activeStatementTab.value = getStatementTabName(preferred);
};

const activeResultView = computed<QueryDisplayResult | null>(() => {
  if (statementResults.value.length > 0) {
    return statementResults.value.find((item) => getStatementTabName(item) === activeStatementTab.value)
      || statementResults.value[0]
      || null;
  }

  return result.value;
});

const resultSummary = computed(() => {
  if (executing.value) {
    return t('result.summary.executing');
  }
  if (errorMessage.value) {
    return t('result.summary.failed');
  }
  if (!result.value) {
    return t('result.summary.notExecuted');
  }

  const executionTime = result.value.execution_time;
  const timeLabel = typeof executionTime === 'number' ? `${executionTime.toFixed(2)} ms` : t('result.unknownTime');

  if (hasMultipleStatementResults.value) {
    if (hasStatementErrors.value) {
      const failedIndex = result.value.failed_statement_index;
      return failedIndex
        ? t('result.summary.multiFailedAt', { count: statementResults.value.length, failedIndex, timeLabel })
        : t('result.summary.multiPartialFailed', { count: statementResults.value.length, timeLabel });
    }
    return t('result.summary.multiSuccess', { count: statementResults.value.length, timeLabel });
  }

  const activeResult = activeResultView.value;
  if (hasStatementErrors.value) {
    const failedIndex = result.value.failed_statement_index;
    return failedIndex ? t('result.summary.failedAt', { failedIndex, timeLabel }) : t('result.summary.failedWithTime', { timeLabel });
  }

  if (!shouldShowTableResult(activeResult)) {
    const rowCount = typeof activeResult?.row_count === 'number' ? activeResult.row_count : activeResult?.rows.length || 0;
    return resultLooksLikeQuery(activeResult)
      ? t('result.summary.rowsOnly', { count: rowCount })
      : t('result.summary.affectedOnly', { count: rowCount });
  }

  const rowCount = activeResult?.row_count ?? activeResult?.rows.length ?? 0;
  return t('result.summary.rowsWithTime', { count: rowCount, timeLabel });
});

const getAiSidebarMaxWidth = () => {
  const layoutWidth = queryLayoutRef.value?.clientWidth ?? window.innerWidth ?? 0;
  return Math.max(
    QUERY_AI_SIDEBAR_MIN_WIDTH,
    Math.round(layoutWidth - QUERY_MAIN_MIN_WIDTH)
  );
};

const clampAiSidebarWidth = (value: number) =>
  Math.min(
    Math.max(Math.round(value), QUERY_AI_SIDEBAR_MIN_WIDTH),
    getAiSidebarMaxWidth()
  );

const syncAiSidebarWidth = (value: number) => {
  aiSidebarWidth.value = clampAiSidebarWidth(value);
};

const handleWindowResize = () => {
  syncAiSidebarWidth(aiSidebarWidth.value);
};

const { dragging: aiSidebarResizing, startDragging: startAiSidebarResize } = useDragResize({
  axis: 'x',
  min: QUERY_AI_SIDEBAR_MIN_WIDTH,
  max: () => getAiSidebarMaxWidth(),
  getInitialValue: () => aiSidebarWidth.value,
  onChange: (value) => {
    syncAiSidebarWidth(value);
  },
  getValueFromPointer: (event, state) => state.startValue - (event.clientX - state.startX),
});

const buildWorkbenchState = (): QueryWorkbenchState => {
  return {
    sqlContent: sqlContent.value,
    queryHistory: queryHistory.value.slice(0, QUERY_HISTORY_LIMIT),
    resultSummary: buildQueryResultSummarySnapshot(result.value),
    errorMessage: errorMessage.value,
    aiSidebarWidth: aiSidebarWidth.value,
  };
};

const serializeWorkbenchState = (value: QueryWorkbenchState) => JSON.stringify(value);

const emitWorkbenchState = () => {
  emit('state-changed', buildWorkbenchState());
};

const scheduleWorkbenchStateEmit = () => {
  if (isApplyingPersistedState) {
    return;
  }

  if (sqlStateEmitTimer) {
    clearTimeout(sqlStateEmitTimer);
  }

  sqlStateEmitTimer = setTimeout(() => {
    sqlStateEmitTimer = null;
    emitWorkbenchState();
  }, SQL_STATE_EMIT_DELAY);
};

const loadQueryHistoryFromStorage = (): QueryHistoryEntry[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(queryHistoryStorageKey.value);
    return raw ? normalizeQueryHistoryEntries(JSON.parse(raw)) : [];
  } catch (error) {
    console.error('读取 SQL 历史失败:', error);
    return [];
  }
};

const persistQueryHistory = () => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(queryHistoryStorageKey.value, JSON.stringify(queryHistory.value.slice(0, QUERY_HISTORY_LIMIT)));
  } catch (error) {
    console.error('保存 SQL 历史失败:', error);
  }
};

const saveSqlToHistory = (sql: string) => {
  const normalized = sql.trim();
  if (!normalized) {
    return;
  }

  const createdAt = new Date().toISOString();
  const preview = buildHistoryPreview(normalized);
  queryHistory.value = mergeQueryHistoryEntries([
    {
      id: `${createdAt}-${preview}`,
      sql: normalized,
      preview,
      createdAt,
      createdAtLabel: formatQueryTimestampLabel(createdAt)
    }
  ], queryHistory.value);
  persistQueryHistory();
};

const clearHistory = () => {
  queryHistory.value = [];
  persistQueryHistory();
};

const applyHistory = (item: QueryHistoryEntry) => {
  sqlContent.value = item.sql;
  historyPopoverVisible.value = false;
  editorRef.value?.focus?.();
};

const clearResult = () => {
  result.value = null;
  persistedResultSummary.value = null;
  errorMessage.value = '';
  activeStatementTab.value = '';
};

const resetViewState = () => {
  result.value = null;
  persistedResultSummary.value = null;
  errorMessage.value = '';
  activeStatementTab.value = '';
};

const formatSqlText = (value: string) => {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return '';
  }

  const keywords = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'JOIN', 'ON',
    'UNION ALL', 'UNION', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'
  ];

  let formatted = normalized;
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\s*${keyword.replace(/\s+/g, '\\s+')}\\s+`, 'gi');
    formatted = formatted.replace(pattern, `\n${keyword} `);
  }

  formatted = formatted
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
    .replace(/,\s*/g, ',\n  ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/;\s*/g, ';\n\n');

  return formatted.trim();
};

const formatSql = () => {
  const formatted = formatSqlText(sqlContent.value);
  if (!formatted) {
    ElMessage.warning(t('messages.noSqlToFormat'));
    return;
  }
  sqlContent.value = formatted;
  ElMessage.success(t('messages.sqlFormatted'));
};

const getExecutableSql = (preferSelection: boolean) => {
  const selectedText = editorRef.value?.getSelectedText?.()?.trim() || '';
  if (preferSelection && selectedText) {
    return selectedText;
  }
  return sqlContent.value.trim();
};

const executeSql = async (preferSelection: boolean) => {
  const sql = getExecutableSql(preferSelection);
  if (!sql) {
    ElMessage.warning(preferSelection ? t('messages.selectSqlFirst') : t('messages.enterSql'));
    return;
  }

  executing.value = true;
  errorMessage.value = '';
  lastExecutedSql.value = sql;
  try {
    result.value = await DbmApi.executeWorkbenchQuery(props.connectionId, sql, props.databaseName);
    persistedResultSummary.value = buildQueryResultSummarySnapshot(result.value);
    pickDefaultStatementTab(result.value?.statements || []);
    saveSqlToHistory(sql);
    if (result.value?.has_errors) {
      const message = extractDbmErrorMessage(result.value.batch_error_message || '', t('messages.sqlPartialFailed'));
      ElMessage.warning(message);
    } else {
      ElMessage.success(t('messages.sqlExecuteSuccess'));
    }
  } catch (error) {
    result.value = null;
    persistedResultSummary.value = null;
    activeStatementTab.value = '';
    const message = extractDbmErrorMessage(error, t('messages.sqlExecuteFailed'));
    errorMessage.value = message;
    ElMessage.error(t('messages.sqlExecuteFailedWithReason', { error: message }));
  } finally {
    executing.value = false;
  }
};

const runSql = async () => {
  await executeSql(false);
};

const runSelectedSql = async () => {
  await executeSql(true);
};

const applyPersistedState = (value: QueryWorkbenchState | null | undefined) => {
  const normalizedState = normalizeQueryWorkbenchState(value);
  const storageHistory = loadQueryHistoryFromStorage();
  const nextState: QueryWorkbenchState = normalizedState || {
    sqlContent: '',
    queryHistory: [],
    resultSummary: null,
    errorMessage: '',
    aiSidebarWidth: QUERY_AI_SIDEBAR_DEFAULT_WIDTH,
  };
  const mergedState: QueryWorkbenchState = {
    sqlContent: nextState.sqlContent,
    resultSummary: null,
    errorMessage: nextState.errorMessage,
    queryHistory: mergeQueryHistoryEntries(nextState.queryHistory, storageHistory),
    aiSidebarWidth: nextState.aiSidebarWidth ?? QUERY_AI_SIDEBAR_DEFAULT_WIDTH,
  };
  const currentState = buildWorkbenchState();

  if (hasInitializedState && serializeWorkbenchState(mergedState) === serializeWorkbenchState(currentState)) {
    return;
  }

  isApplyingPersistedState = true;
  sqlContent.value = mergedState.sqlContent;
  result.value = null;
  persistedResultSummary.value = null;
  errorMessage.value = mergedState.errorMessage;
  queryHistory.value = mergedState.queryHistory;
  activeStatementTab.value = '';
  syncAiSidebarWidth(mergedState.aiSidebarWidth ?? QUERY_AI_SIDEBAR_DEFAULT_WIDTH);
  persistQueryHistory();

  queueMicrotask(() => {
    isApplyingPersistedState = false;
    const incomingState = normalizedState
      ? {
          ...normalizedState,
          queryHistory: mergeQueryHistoryEntries(normalizedState.queryHistory, storageHistory),
        }
      : null;
    hasInitializedState = true;
    if (!incomingState || serializeWorkbenchState(mergedState) !== serializeWorkbenchState(incomingState)) {
      emitWorkbenchState();
    }
  });
};

onMounted(() => {
  applyPersistedState(props.initialState);
  syncAiSidebarWidth(aiSidebarWidth.value);
  window.addEventListener('resize', handleWindowResize);
  void loadAiSchemaContext();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleWindowResize);
  if (sqlStateEmitTimer) {
    clearTimeout(sqlStateEmitTimer);
    sqlStateEmitTimer = null;
  }
});

watch(
  [() => props.connectionId, () => props.databaseName],
  () => {
    currentConnection.value = null;
    aiError.value = '';
    lastGeneratedSql.value = '';
    void loadAiSchemaContext(false);
  },
  { immediate: false }
);

watch(
  () => props.resetToken,
  (value, previousValue) => {
    if (typeof value !== 'number' || value === previousValue) {
      return;
    }
    resetViewState();
  }
);

watch(
  () => queryHistoryStorageKey.value,
  () => {
    applyPersistedState(props.initialState);
  }
);

watch(
  () => sqlContent.value,
  () => {
    scheduleWorkbenchStateEmit();
  }
);

watch(
  () => aiSidebarWidth.value,
  () => {
    scheduleWorkbenchStateEmit();
  }
);

watch(
  statementResults,
  (items) => {
    if (!items.length) {
      activeStatementTab.value = '';
      return;
    }

    if (!items.some((item) => getStatementTabName(item) === activeStatementTab.value)) {
      pickDefaultStatementTab(items);
    }
  },
  { immediate: true }
);

watch(
  [queryHistory, result, persistedResultSummary, errorMessage],
  () => {
    if (isApplyingPersistedState) {
      return;
    }
    emitWorkbenchState();
  }
);
</script>

<style scoped>
.db-query-workbench {
  height: 100%;
  padding: 10px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.query-layout {
  --query-ai-side-width: 300px;
  height: 100%;
  min-height: 0;
  display: flex;
  gap: 0;
}

.query-main {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

.query-ai-resize-handle {
  align-self: stretch;
}

.query-ai-side {
  flex: 0 0 var(--query-ai-side-width);
  width: var(--query-ai-side-width);
  min-width: 220px;
  max-width: 420px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.query-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-shrink: 0;
}

.query-toolbar-left,
.query-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.query-target {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.query-ai-header {
  height: 42px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
}

.query-ai-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.query-ai-summary {
  flex-shrink: 0;
  margin: 0;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  border-bottom: 1px solid var(--el-border-color-light);
  background: color-mix(in srgb, var(--el-color-primary) 4%, var(--el-bg-color));
}

.query-ai-summary.is-error {
  color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger-light-9) 54%, var(--el-bg-color));
}

:deep(.query-ai-side .ai-chat-panel) {
  padding: 10px;
}

.query-editor {
  height: 240px;
  min-height: 200px;
}

.query-result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--layout-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.query-result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--layout-border-color);
  background: color-mix(in srgb, var(--toolbar-bg-color) 76%, white 24%);
}

.query-result-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.query-result-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.query-error {
  padding: 12px;
  color: var(--el-color-danger);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.query-error--inline {
  border-bottom: 1px solid color-mix(in srgb, var(--el-color-danger) 18%, var(--layout-border-color) 82%);
  background: color-mix(in srgb, var(--el-color-danger-light-9) 72%, white 28%);
}

.query-summary-placeholder {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 20px 16px 24px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
}

.query-summary-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.query-summary-columns {
  max-width: min(720px, 100%);
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  word-break: break-word;
}

.query-history-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.query-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.query-history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}

.query-history-item {
  padding: 10px 12px;
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.18s ease, background-color 0.18s ease;
}

.query-history-item:hover {
  border-color: color-mix(in srgb, var(--el-color-primary) 26%, var(--layout-border-color) 74%);
  background: color-mix(in srgb, var(--el-color-primary-light-9) 46%, white 54%);
}

.query-history-time {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.query-history-sql {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.query-table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.query-result-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.query-result-tabs :deep(.el-tabs__header) {
  margin: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--layout-border-color);
  background: color-mix(in srgb, var(--toolbar-bg-color) 82%, white 18%);
}

.query-result-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: transparent;
}

.query-result-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.query-result-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.result-tab-label {
  display: inline-block;
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-tab-label.is-error {
  color: var(--el-color-danger);
  font-weight: 600;
}

.query-result-pane {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.query-result-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.query-statement-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--layout-border-color);
  background: color-mix(in srgb, var(--el-fill-color-light) 74%, white 26%);
}

.query-statement-banner--error {
  background: color-mix(in srgb, var(--el-color-danger-light-9) 76%, white 24%);
}

.query-statement-order {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--el-color-primary);
}

.query-statement-banner--error .query-statement-order,
.query-statement-banner--error .query-statement-meta {
  color: var(--el-color-danger);
}

.query-statement-sql {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.query-statement-meta {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.query-execution-placeholder {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 20px 16px 24px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
}

.query-execution-placeholder--error {
  color: var(--el-color-danger);
}

.query-statement-error-text {
  max-width: min(760px, 100%);
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-color-danger);
  text-align: center;
  white-space: pre-wrap;
  word-break: break-word;
}

:deep(.query-table .el-table) {
  height: 100%;
}

@media (max-width: 980px) {
  .query-layout {
    flex-direction: column;
    gap: 12px;
  }

  .query-main {
    flex: 1 1 0;
  }

  .query-ai-resize-handle {
    display: none;
  }

  .query-ai-side {
    flex: 0 0 auto;
    width: 100%;
    min-width: 0;
    max-width: none;
    min-height: 280px;
  }
}
</style>
