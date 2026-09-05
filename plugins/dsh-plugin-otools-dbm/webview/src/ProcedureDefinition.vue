<template>
  <div class="procedure-definition h-100% flex flex-col">
    <div class="toolbar">
      <span class="title">{{ isCreateMode ? t('titleCreate') : t('titleView', { tableName }) }}</span>
      <div class="actions">
        <el-button size="small" type="primary" @click="executeSql" :loading="executing">{{ t('execute') }}</el-button>
        <el-button v-if="!isCreateMode" size="small" @click="loadDefinition" :loading="loading">{{ t('refresh') }}</el-button>
      </div>
    </div>
    <div class="editor-area flex-1 min-h-0">
      <CodeMirrorTextEditor v-model="sqlContent" file-path="query.sql" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { DbmApi } from './service';
import CodeMirrorTextEditor from '@/platform/ui/common/CodeMirrorTextEditor.vue';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  connectionId: string;
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  dbType?: string;
}>();
const emit = defineEmits<{
  'refresh-object-list': [payload: { connectionId: string; databaseName?: string; schemaName?: string; objectType: 'procedures' }]
}>();
const { t } = useI18nScope('dbm.procedureDefinition');

const isCreateMode = computed(() => !props.tableName);
const sqlContent = ref('');
const loading = ref(false);
const executing = ref(false);

const normalizedDbType = computed(() => props.dbType?.toLowerCase() || '');
const quoteDoubleIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteBacktickIdentifier = (value: string) => `\`${value.replace(/`/g, '``')}\``;
const quoteSqlServerIdentifier = (value: string) => `[${value.replace(/\]/g, ']]')}]`;

const buildQualifiedProcedureName = () => {
  if (normalizedDbType.value === 'mysql' || normalizedDbType.value === 'mariadb') {
    const databasePrefix = props.databaseName ? `${quoteBacktickIdentifier(props.databaseName)}.` : '';
    return `${databasePrefix}${quoteBacktickIdentifier('procedure_name')}`;
  }
  if (normalizedDbType.value === 'sqlserver') {
    const schemaPrefix = props.schemaName ? `${quoteSqlServerIdentifier(props.schemaName)}.` : '';
    return `${schemaPrefix}${quoteSqlServerIdentifier('procedure_name')}`;
  }

  const schemaPrefix = props.schemaName ? `${quoteDoubleIdentifier(props.schemaName)}.` : '';
  return `${schemaPrefix}${quoteDoubleIdentifier('procedure_name')}`;
};

const defaultCreateSql = computed(() => {
  if (normalizedDbType.value === 'mysql' || normalizedDbType.value === 'mariadb') {
    return `DELIMITER $$
CREATE PROCEDURE ${buildQualifiedProcedureName()}()
BEGIN
  -- ${t('defaultComment')}
  SELECT 1;
END$$
DELIMITER ;`;
  }

  if (normalizedDbType.value === 'sqlserver') {
    return `CREATE PROCEDURE ${buildQualifiedProcedureName()}
AS
BEGIN
  SET NOCOUNT ON;
  SELECT 1;
END;`;
  }

  if (normalizedDbType.value === 'oracle' || normalizedDbType.value === 'dameng') {
    return `CREATE OR REPLACE PROCEDURE ${buildQualifiedProcedureName()}
AS
BEGIN
  NULL;
END;`;
  }

  return `CREATE OR REPLACE PROCEDURE ${buildQualifiedProcedureName()}()
LANGUAGE plpgsql
AS $$
BEGIN
  -- ${t('defaultComment')}
  RAISE NOTICE 'procedure_name executed';
END;
$$;`;
});

const loadDefinition = async () => {
  if (isCreateMode.value) return;
  loading.value = true;
  try {
    const def = await DbmApi.getProcedureDefinition(
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

const executeSql = async () => {
  if (!sqlContent.value.trim()) {
    ElMessage.warning(t('sqlRequired'));
    return;
  }
  executing.value = true;
  try {
    await DbmApi.executeQuery(props.connectionId, sqlContent.value, props.databaseName);
    ElMessage.success(t('executeSuccess'));
    emit('refresh-object-list', {
      connectionId: props.connectionId,
      databaseName: props.databaseName,
      schemaName: props.schemaName,
      objectType: 'procedures'
    });
  } catch (e) {
    ElMessage.error(t('executeFailed', { error: (e as Error).message }));
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

.actions {
  display: flex;
  gap: 6px;
}

.editor-area {
  overflow: hidden;
}
</style>
