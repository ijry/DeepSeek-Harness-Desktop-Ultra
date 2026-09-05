import { computed, ref, unref, type Ref } from 'vue';
import { DbmApi, extractDbmErrorMessage, type TableStruct } from './service';
import { t } from '@/platform/i18n';

type SourceValue<T> = T | Ref<T> | (() => T);

interface SharedDbSchemaEntry {
  tableStructs: Ref<TableStruct[]>;
  schemaLoading: Ref<boolean>;
  schemaError: Ref<string>;
  schemaLoadedAt: Ref<string>;
  loadedOnce: Ref<boolean>;
  loadPromise: Promise<TableStruct[]> | null;
  requestToken: number;
}

interface UseDbSchemaContextOptions {
  connectionId: SourceValue<string | undefined>;
  databaseName: SourceValue<string | undefined>;
  schemaName?: SourceValue<string | undefined>;
  errorFallback?: string;
}

const sharedDbSchemaEntries = new Map<string, SharedDbSchemaEntry>();

const EMPTY_TABLE_STRUCTS: TableStruct[] = [];

const createSharedDbSchemaEntry = (): SharedDbSchemaEntry => ({
  tableStructs: ref([]),
  schemaLoading: ref(false),
  schemaError: ref(''),
  schemaLoadedAt: ref(''),
  loadedOnce: ref(false),
  loadPromise: null,
  requestToken: 0,
});

const sortTableStructs = (tables: TableStruct[]) =>
  [...tables].sort((left, right) => left.table_name.localeCompare(right.table_name));

const resolveSourceValue = <T>(source: SourceValue<T>) =>
  typeof source === 'function' ? (source as () => T)() : unref(source);

const buildSchemaKey = (connectionId: string, databaseName: string, schemaName = '') =>
  `${connectionId}:${databaseName}:${schemaName || '__default__'}`;

const getOrCreateSharedDbSchemaEntry = (key: string) => {
  let entry = sharedDbSchemaEntries.get(key);
  if (!entry) {
    entry = createSharedDbSchemaEntry();
    sharedDbSchemaEntries.set(key, entry);
  }
  return entry;
};

const loadSharedDbSchemaEntry = async (
  entry: SharedDbSchemaEntry,
  connectionId: string,
  databaseName: string,
  schemaName: string,
  force: boolean,
  errorFallback: string
) => {
  if (!force) {
    if (entry.loadedOnce.value) {
      if (entry.schemaError.value) {
        entry.schemaError.value = '';
      }
      return entry.tableStructs.value;
    }
    if (entry.loadPromise) {
      return entry.loadPromise;
    }
  }

  const requestToken = entry.requestToken + 1;
  entry.requestToken = requestToken;
  entry.schemaLoading.value = true;
  entry.schemaError.value = '';

  const loadPromise = (async () => {
    try {
      const structs = await DbmApi.getAllTableStructs(
        connectionId,
        databaseName,
        schemaName || undefined,
        force
      );

      if (requestToken !== entry.requestToken) {
        return entry.tableStructs.value;
      }

      entry.tableStructs.value = sortTableStructs(structs);
      entry.schemaLoadedAt.value = new Date().toISOString();
      entry.loadedOnce.value = true;
      return entry.tableStructs.value;
    } catch (error) {
      if (requestToken !== entry.requestToken) {
        return entry.tableStructs.value;
      }

      if (!entry.loadedOnce.value) {
        entry.tableStructs.value = [];
        entry.schemaLoadedAt.value = '';
      }

      entry.schemaError.value = extractDbmErrorMessage(error, errorFallback);
      return entry.tableStructs.value;
    } finally {
      if (requestToken === entry.requestToken) {
        entry.schemaLoading.value = false;
        entry.loadPromise = null;
      }
    }
  })();

  entry.loadPromise = loadPromise;
  return loadPromise;
};

export const useDbSchemaContext = (options: UseDbSchemaContextOptions) => {
  const schemaKey = computed(() => {
    const connectionId = String(resolveSourceValue(options.connectionId) || '').trim();
    const databaseName = String(resolveSourceValue(options.databaseName) || '').trim();
    const schemaName = String(resolveSourceValue(options.schemaName || '') || '').trim();
    if (!connectionId || !databaseName) {
      return '';
    }
    return buildSchemaKey(connectionId, databaseName, schemaName);
  });

  const activeEntry = computed<SharedDbSchemaEntry | null>(() => {
    if (!schemaKey.value) {
      return null;
    }
    return getOrCreateSharedDbSchemaEntry(schemaKey.value);
  });

  const tableStructs = computed(() => activeEntry.value?.tableStructs.value || EMPTY_TABLE_STRUCTS);
  const schemaLoading = computed(() => activeEntry.value?.schemaLoading.value || false);
  const schemaError = computed(() => activeEntry.value?.schemaError.value || '');
  const schemaLoadedAt = computed(() => activeEntry.value?.schemaLoadedAt.value || '');
  const schemaReady = computed(() => activeEntry.value?.loadedOnce.value || false);

  const ensureSchemaLoaded = async (force = false) => {
    const connectionId = String(resolveSourceValue(options.connectionId) || '').trim();
    const databaseName = String(resolveSourceValue(options.databaseName) || '').trim();
    const schemaName = String(resolveSourceValue(options.schemaName || '') || '').trim();
    if (!connectionId || !databaseName) {
      return EMPTY_TABLE_STRUCTS;
    }

    const entry = getOrCreateSharedDbSchemaEntry(buildSchemaKey(connectionId, databaseName, schemaName));
    return loadSharedDbSchemaEntry(
      entry,
      connectionId,
      databaseName,
      schemaName,
      force,
      options.errorFallback || t('dbm.schemaContext.loadFailed')
    );
  };

  return {
    schemaKey,
    tableStructs,
    schemaLoading,
    schemaError,
    schemaLoadedAt,
    schemaReady,
    ensureSchemaLoaded,
    refreshSchema: () => ensureSchemaLoaded(true),
  };
};
