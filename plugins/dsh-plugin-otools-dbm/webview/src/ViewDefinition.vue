<template>
  <div class="view-definition h-100% flex flex-col">
    <!-- 创建模式：仅SQL编辑器 -->
    <template v-if="isCreateMode">
      <div class="toolbar">
        <span class="title">{{ t('createTitle') }}</span>
        <div class="actions">
          <el-button size="small" type="primary" @click="saveViewSql" :loading="executing">{{ t('save') }}</el-button>
        </div>
      </div>
      <div class="editor-area flex-1 min-h-0">
        <CodeMirrorTextEditor v-model="sqlContent" file-path="query.sql" />
      </div>
    </template>

    <!-- 已有视图：数据 + 结构 -->
    <template v-else>
      <div class="flex flex-col h-100%" v-show="activeTab === 0">
        <TableContent
          :connection-id="connectionId"
          :table-name="tableName"
          :database-name="databaseName"
          :schema-name="schemaName"
          :show-structure-tab="false"
        />
      </div>

      <div class="flex flex-col h-100% p-10px" v-show="activeTab === 1">
        <div class="toolbar mb-5px">
          <div class="toolbar-buttons">
            <el-button size="small" type="primary" @click="saveViewSql" :loading="executing">{{ t('save') }}</el-button>
            <el-button size="small" @click="loadDefinition" :loading="loading">{{ t('refresh') }}</el-button>
          </div>
        </div>
        <div class="editor-area flex-1 min-h-0">
          <CodeMirrorTextEditor v-model="sqlContent" file-path="query.sql" />
        </div>
      </div>

      <div class="segmented-section pt-8px px-10px">
        <el-segmented
          v-model="activeTab"
          :options="[{ label: t('tabs.data'), value: 0 }, { label: t('tabs.sql'), value: 1 }]"
          size="small"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { DbmApi } from './service';
import CodeMirrorTextEditor from '@/platform/ui/common/CodeMirrorTextEditor.vue';
import TableContent from './TableContent.vue';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  connectionId: string;
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  dbType?: string;
}>();
const emit = defineEmits<{
  'refresh-object-list': [payload: { connectionId: string; databaseName?: string; schemaName?: string; objectType: 'views' }]
}>();

const isCreateMode = computed(() => !props.tableName);
const activeTab = ref(0);
const sqlContent = ref('');
const loading = ref(false);
const executing = ref(false);
const { t } = useI18nScope('dbm.viewDefinition');

const normalizedDbType = computed(() => props.dbType?.toLowerCase() || '');
const quoteDoubleIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteBacktickIdentifier = (value: string) => `\`${value.replace(/`/g, '``')}\``;
const quoteSqlServerIdentifier = (value: string) => `[${value.replace(/\]/g, ']]')}]`;

const buildQualifiedViewName = () => {
  if (normalizedDbType.value === 'mysql' || normalizedDbType.value === 'mariadb') {
    const databasePrefix = props.databaseName ? `${quoteBacktickIdentifier(props.databaseName)}.` : '';
    return `${databasePrefix}${quoteBacktickIdentifier('view_name')}`;
  }

  if (normalizedDbType.value === 'sqlserver') {
    const schemaPrefix = props.schemaName ? `${quoteSqlServerIdentifier(props.schemaName)}.` : '';
    return `${schemaPrefix}${quoteSqlServerIdentifier('view_name')}`;
  }

  const schemaPrefix = props.schemaName ? `${quoteDoubleIdentifier(props.schemaName)}.` : '';
  return `${schemaPrefix}${quoteDoubleIdentifier('view_name')}`;
};

const buildQualifiedTableName = () => {
  if (normalizedDbType.value === 'mysql' || normalizedDbType.value === 'mariadb') {
    return quoteBacktickIdentifier('table_name');
  }
  if (normalizedDbType.value === 'sqlserver') {
    return quoteSqlServerIdentifier('table_name');
  }
  return quoteDoubleIdentifier('table_name');
};

const defaultCreateSql = computed(() => {
  const createKeyword = ['oracle', 'dameng'].includes(normalizedDbType.value)
    ? 'CREATE OR REPLACE VIEW'
    : 'CREATE VIEW';
  return `${createKeyword} ${buildQualifiedViewName()} AS\nSELECT * FROM ${buildQualifiedTableName()};`;
});

const loadDefinition = async () => {
  if (isCreateMode.value) return;
  loading.value = true;
  try {
    const def = await DbmApi.getViewDefinition(
      props.connectionId,
      props.databaseName,
      props.tableName,
      props.schemaName
    );
    sqlContent.value = def || '';
  } catch (e) {
    ElMessage.error(t('loadFailed', { error: (e as Error).message }));
  } finally {
    loading.value = false;
  }
};

const saveViewSql = async () => {
  if (!sqlContent.value.trim()) {
    ElMessage.warning(t('sqlRequired'));
    return;
  }
  executing.value = true;
  try {
    await DbmApi.executeQuery(props.connectionId, sqlContent.value, props.databaseName);
    if (isCreateMode.value) {
      ElMessage.success(t('createSuccess'));
    } else {
      await loadDefinition();
      ElMessage.success(t('saveSuccess'));
    }
    emit('refresh-object-list', {
      connectionId: props.connectionId,
      databaseName: props.databaseName,
      schemaName: props.schemaName,
      objectType: 'views'
    });
  } catch (e) {
    ElMessage.error(t('saveFailed', { error: (e as Error).message }));
  } finally {
    executing.value = false;
  }
};

onMounted(() => {
  if (isCreateMode.value) {
    sqlContent.value = defaultCreateSql.value;
  } else {
    loadDefinition();
  }
});
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--layout-border-color);
}

.title {
  font-weight: 500;
  font-size: 14px;
}

.actions, .toolbar-buttons {
  display: flex;
  gap: 6px;
}

.editor-area {
  overflow: hidden;
}

.segmented-section {
  border-top: 1px solid var(--layout-border-color);
}
</style>
