import type { QueryResult } from './service';

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  preview: string;
  createdAt: string;
  createdAtLabel: string;
}

export interface QueryResultSummarySnapshot {
  rowCount: number;
  executionTime: number;
  columnCount: number;
  columnPreview: string[];
}

export interface QueryWorkbenchState {
  sqlContent: string;
  queryHistory: QueryHistoryEntry[];
  resultSummary: QueryResultSummarySnapshot | null;
  errorMessage: string;
  aiSidebarWidth?: number;
}

export const QUERY_HISTORY_LIMIT = 30;
const QUERY_RESULT_SUMMARY_COLUMN_LIMIT = 8;
// PORT FIX: the reference referenced this constant without declaring it, so
// restoring a legacy payload that still carried a `result` key threw a
// ReferenceError instead of trimming the snapshot.
const QUERY_RESULT_SNAPSHOT_ROW_LIMIT = 200;

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const formatQueryTimestampLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export const buildHistoryPreview = (sql: string) =>
  sql.trim().replace(/\s+/g, ' ').slice(0, 120);

export const normalizeQueryHistoryEntries = (value: unknown): QueryHistoryEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: QueryHistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const sql = typeof (item as any).sql === 'string' ? (item as any).sql.trim() : '';
    const createdAt = typeof (item as any).createdAt === 'string' ? (item as any).createdAt : '';
    if (!sql || !createdAt) {
      continue;
    }

    result.push({
      id: typeof (item as any).id === 'string' ? (item as any).id : `${createdAt}-${result.length}`,
      sql,
      preview:
        typeof (item as any).preview === 'string' && (item as any).preview
          ? (item as any).preview
          : buildHistoryPreview(sql),
      createdAt,
      createdAtLabel: formatQueryTimestampLabel(createdAt),
    });

    if (result.length >= QUERY_HISTORY_LIMIT) {
      break;
    }
  }

  return result;
};

export const mergeQueryHistoryEntries = (...groups: QueryHistoryEntry[][]): QueryHistoryEntry[] => {
  const seen = new Set<string>();
  const merged: QueryHistoryEntry[] = [];

  for (const group of groups) {
    for (const item of group) {
      const sql = item.sql.trim();
      if (!sql || seen.has(sql)) {
        continue;
      }
      seen.add(sql);
      merged.push({
        ...item,
        sql,
        preview: item.preview || buildHistoryPreview(sql),
        createdAtLabel: item.createdAtLabel || formatQueryTimestampLabel(item.createdAt),
      });
      if (merged.length >= QUERY_HISTORY_LIMIT) {
        return merged;
      }
    }
  }

  return merged;
};

const normalizeQueryResultSnapshot = (value: unknown): QueryResult | null => {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
    return null;
  }

  const columns = value.columns.filter((item): item is string => typeof item === 'string');
  const rows = value.rows
    .filter((item): item is unknown[] => Array.isArray(item))
    .slice(0, QUERY_RESULT_SNAPSHOT_ROW_LIMIT);

  const rowCount =
    typeof value.row_count === 'number' && Number.isFinite(value.row_count)
      ? value.row_count
      : rows.length;
  const executionTime =
    typeof value.execution_time === 'number' && Number.isFinite(value.execution_time)
      ? value.execution_time
      : 0;

  return {
    columns,
    rows,
    row_count: rowCount,
    execution_time: executionTime,
  };
};

const normalizeQueryResultSummarySnapshot = (value: unknown): QueryResultSummarySnapshot | null => {
  if (!isRecord(value)) {
    return null;
  }

  const columnPreview = Array.isArray(value.columnPreview)
    ? value.columnPreview.filter((item): item is string => typeof item === 'string').slice(0, QUERY_RESULT_SUMMARY_COLUMN_LIMIT)
    : [];
  const rowCount =
    typeof value.rowCount === 'number' && Number.isFinite(value.rowCount)
      ? value.rowCount
      : 0;
  const executionTime =
    typeof value.executionTime === 'number' && Number.isFinite(value.executionTime)
      ? value.executionTime
      : 0;
  const columnCount =
    typeof value.columnCount === 'number' && Number.isFinite(value.columnCount)
      ? value.columnCount
      : columnPreview.length;

  return {
    rowCount,
    executionTime,
    columnCount,
    columnPreview,
  };
};

export const buildQueryResultSummarySnapshot = (value: QueryResult | null): QueryResultSummarySnapshot | null => {
  if (!value) {
    return null;
  }

  return {
    rowCount: typeof value.row_count === 'number' ? value.row_count : value.rows.length,
    executionTime: typeof value.execution_time === 'number' ? value.execution_time : 0,
    columnCount: value.columns.length,
    columnPreview: value.columns.slice(0, QUERY_RESULT_SUMMARY_COLUMN_LIMIT),
  };
};

export const normalizeQueryWorkbenchState = (value: unknown): QueryWorkbenchState | null => {
  if (!isRecord(value)) {
    return null;
  }

  const persistedResultSummary =
    normalizeQueryResultSummarySnapshot(value.resultSummary)
    || buildQueryResultSummarySnapshot(normalizeQueryResultSnapshot(value.result));

  return {
    sqlContent: typeof value.sqlContent === 'string' ? value.sqlContent : '',
    queryHistory: normalizeQueryHistoryEntries(value.queryHistory),
    resultSummary: persistedResultSummary,
    errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : '',
    aiSidebarWidth:
      typeof value.aiSidebarWidth === 'number' && Number.isFinite(value.aiSidebarWidth)
        ? value.aiSidebarWidth
        : undefined,
  };
};
