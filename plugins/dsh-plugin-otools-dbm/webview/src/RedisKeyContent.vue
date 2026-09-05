<template>
  <div class="redis-key-content">
    <div class="redis-header">
      <div>
        <div class="redis-title">{{ tableName }}</div>
        <div class="redis-subtitle">{{ databaseName || 'db0' }}</div>
      </div>
      <div class="redis-toolbar">
        <el-input
          v-model="searchKeyword"
          size="small"
          clearable
          :placeholder="t('searchPlaceholder')"
          class="search-input"
        />
        <el-button size="small" @click="loadKeyInfo">{{ t('refresh') }}</el-button>
        <el-button size="small" type="primary" :disabled="!canEdit" @click="openEditDialog">{{ t('edit') }}</el-button>
        <el-button size="small" type="danger" plain @click="handleDelete">{{ t('delete') }}</el-button>
      </div>
    </div>

    <div class="redis-meta-grid">
      <div class="meta-card">
        <div class="meta-label">{{ t('meta.type') }}</div>
        <div class="meta-value">{{ keyInfo?.value_type || '-' }}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">{{ t('meta.ttl') }}</div>
        <div class="meta-value">{{ keyInfo?.ttl_label || '-' }}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">{{ t('meta.recordCount') }}</div>
        <div class="meta-value">{{ filteredRows.length }}</div>
      </div>
    </div>

    <el-alert
      v-if="!loading && keyInfo"
      :title="typeDescription"
      type="info"
      :closable="false"
      class="redis-alert"
    />

    <el-table
      v-loading="loading"
      :data="filteredRows"
      border
      stripe
      height="100%"
      class="redis-table"
      :empty-text="loading ? t('loading') : t('empty')"
    >
      <el-table-column
        v-for="column in keyInfo?.columns || []"
        :key="column"
        :prop="column"
        :label="column"
        min-width="160"
        show-overflow-tooltip
      />
    </el-table>

    <RedisKeyEditorDialog
      v-model="editorVisible"
      :title="t('editorTitle')"
      :initial-value="editorDraft"
      :allow-key-name-edit="false"
      :allow-type-change="false"
      @confirm="handleSave"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DbmApi,
  extractDbmErrorMessage,
  type RedisKeyInfo,
  type RedisKeyMutation
} from './service';
import RedisKeyEditorDialog from './RedisKeyEditorDialog.vue';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  connectionId: string;
  tableName: string;
  databaseName?: string;
}>();

const emit = defineEmits<{
  (e: 'refresh-object-list', payload: { connectionId: string; databaseName?: string; objectType: 'tables' }): void;
  (e: 'close'): void;
}>();
const { t } = useI18nScope('dbm.redisKeyContent');

const loading = ref(false);
const keyInfo = ref<RedisKeyInfo | null>(null);
const searchKeyword = ref('');
const editorVisible = ref(false);
const editorDraft = ref<RedisKeyMutation | null>(null);

const rowObjects = computed(() => {
  if (!keyInfo.value) {
    return [];
  }

  return keyInfo.value.rows.map((row) =>
    Object.fromEntries(keyInfo.value!.columns.map((column, index) => [column, row[index]]))
  );
});

const filteredRows = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return rowObjects.value;
  }

  return rowObjects.value.filter((row) =>
    Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(keyword))
  );
});

const canEdit = computed(() =>
  ['string', 'hash', 'list', 'set', 'zset'].includes(keyInfo.value?.value_type || '')
);

const typeDescription = computed(() => {
  switch (keyInfo.value?.value_type) {
    case 'string':
      return t('typeDescription.string');
    case 'hash':
      return t('typeDescription.hash');
    case 'list':
      return t('typeDescription.list');
    case 'set':
      return t('typeDescription.set');
    case 'zset':
      return t('typeDescription.zset');
    case 'stream':
      return t('typeDescription.stream');
    default:
      return t('typeDescription.default');
  }
});

const createMutationFromKeyInfo = (info: RedisKeyInfo): RedisKeyMutation => {
  const ttlValue = info.ttl_seconds > 0 ? info.ttl_seconds : null;

  switch (info.value_type) {
    case 'string':
      return {
        key_name: info.key,
        value_type: 'string',
        ttl_seconds: ttlValue,
        entries: [{ value: String(info.rows[0]?.[0] ?? '') }]
      };
    case 'hash':
      return {
        key_name: info.key,
        value_type: 'hash',
        ttl_seconds: ttlValue,
        entries: info.rows.map((row) => ({
          field: String(row[0] ?? ''),
          value: String(row[1] ?? '')
        }))
      };
    case 'list':
      return {
        key_name: info.key,
        value_type: 'list',
        ttl_seconds: ttlValue,
        entries: info.rows.map((row) => ({
          value: String(row[1] ?? row[0] ?? '')
        }))
      };
    case 'set':
      return {
        key_name: info.key,
        value_type: 'set',
        ttl_seconds: ttlValue,
        entries: info.rows.map((row) => ({
          value: String(row[0] ?? '')
        }))
      };
    case 'zset':
      return {
        key_name: info.key,
        value_type: 'zset',
        ttl_seconds: ttlValue,
        entries: info.rows.map((row) => ({
          value: String(row[0] ?? ''),
          score: String(row[1] ?? '0')
        }))
      };
    default:
      return {
        key_name: info.key,
        value_type: 'string',
        ttl_seconds: ttlValue,
        entries: [{ value: '' }]
      };
  }
};

const notifyTreeRefresh = () => {
  emit('refresh-object-list', {
    connectionId: props.connectionId,
    databaseName: props.databaseName,
    objectType: 'tables'
  });
};

const loadKeyInfo = async () => {
  loading.value = true;
  try {
    keyInfo.value = await DbmApi.getRedisKeyInfo(
      props.connectionId,
      props.databaseName,
      props.tableName
    );
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('loadFailed')));
  } finally {
    loading.value = false;
  }
};

const openEditDialog = () => {
  if (!keyInfo.value || !canEdit.value) {
    return;
  }
  editorDraft.value = createMutationFromKeyInfo(keyInfo.value);
  editorVisible.value = true;
};

const handleSave = async (payload: RedisKeyMutation) => {
  try {
    await DbmApi.setRedisKey(props.connectionId, props.databaseName, payload);
    editorVisible.value = false;
    ElMessage.success(t('updateSuccess'));
    notifyTreeRefresh();
    await loadKeyInfo();
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('updateFailed')));
  }
};

const handleDelete = async () => {
  try {
    await ElMessageBox.confirm(
      t('confirmDeleteMessage', { keyName: props.tableName }),
      t('confirmDeleteTitle'),
      {
        type: 'warning',
        confirmButtonText: t('delete'),
        cancelButtonText: t('cancel')
      }
    );
  } catch {
    return;
  }

  try {
    await DbmApi.deleteRedisKey(props.connectionId, props.databaseName, props.tableName);
    ElMessage.success(t('deleteSuccess'));
    notifyTreeRefresh();
    emit('close');
  } catch (error) {
    ElMessage.error(extractDbmErrorMessage(error, t('deleteFailed')));
  }
};

watch(
  () => [props.connectionId, props.databaseName, props.tableName],
  () => {
    searchKeyword.value = '';
    void loadKeyInfo();
  },
  { immediate: true }
);
</script>

<style scoped>
.redis-key-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px;
  gap: 12px;
}

.redis-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.redis-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.redis-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.redis-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.search-input {
  width: 220px;
}

.redis-meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.meta-card {
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--el-bg-color);
}

.meta-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.meta-value {
  margin-top: 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.redis-alert {
  flex-shrink: 0;
}

.redis-table {
  flex: 1;
  min-height: 0;
}
</style>
