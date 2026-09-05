<template>
  <el-dialog
    v-if="modelValue"
    :model-value="modelValue"
    :title="t('title')"
    width="500px"
    @close="handleCancel"
  >
    <el-form :model="exportOptions" label-width="120px">
      <el-form-item :label="t('fields.format')">
        <el-radio-group v-model="exportOptions.format">
          <el-radio label="csv">{{ t('formats.csv') }}</el-radio>
          <el-radio label="excel">{{ t('formats.excel') }}</el-radio>
          <el-radio label="json">{{ t('formats.json') }}</el-radio>
          <el-radio label="sql">{{ t('formats.sql') }}</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item :label="t('fields.exportDirectory')">
        <div class="flex">
          <el-input
            v-model="exportOptions.exportPath"
            :placeholder="t('placeholders.exportDirectory')"
            readonly
          />
          <el-button size="small" style="margin-left: 10px;" @click="selectExportDirectory">{{ t('actions.browse') }}</el-button>
        </div>
      </el-form-item>

      <el-form-item :label="t('fields.filters')">
        <el-radio-group v-model="exportOptions.useFilters">
          <el-radio :value="true">{{ t('filters.includeCurrent') }}</el-radio>
          <el-radio :value="false">{{ t('filters.excludeCurrent') }}</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item :label="t('fields.remarks')">
        <el-input
          v-model="exportOptions.remarks"
          type="textarea"
          :placeholder="t('placeholders.remarks')"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <span class="dialog-footer">
        <el-button size="small" @click="handleCancel">{{ t('actions.cancel') }}</el-button>
        <el-button size="small" type="primary" :loading="exportLoading" @click="startExport">
          {{ t('actions.startExport') }}
        </el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@/utils/remotePath';
import { ElMessage } from 'element-plus';
import { useI18nScope } from '@/platform/i18n';

interface Props {
  modelValue: boolean;
  connectionId: string;
  tableName: string;
  databaseName?: string;
  schemaName?: string;
  advancedFilters?: Record<string, any>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
const { t } = useI18nScope('dbm.singleTableExport');

const exportOptions = ref({
  format: 'csv',
  useFilters: true,
  remarks: '',
  exportPath: '',
});
const exportLoading = ref(false);
const usingDefaultExportPath = ref(true);

const getExportFormatDir = (format: string) => (format === 'excel' ? 'excel' : format);

const buildDefaultExportPath = async (format: string) => {
  const home = await homeDir();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return await join(home, '.otools', 'local', 'dbm', 'export', date, getExportFormatDir(format));
};

const syncDefaultExportPath = async (format: string) => {
  exportOptions.value.exportPath = await buildDefaultExportPath(format);
  usingDefaultExportPath.value = true;
};

watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) {
      return;
    }
    exportOptions.value = {
      format: 'csv',
      useFilters: true,
      remarks: '',
      exportPath: '',
    };
    await syncDefaultExportPath('csv');
  }
);

watch(
  () => exportOptions.value.format,
  async (format) => {
    if (!props.modelValue || !usingDefaultExportPath.value) {
      return;
    }
    await syncDefaultExportPath(format);
  }
);

async function selectExportDirectory() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selectedPath = await open({
      directory: true,
      multiple: false,
      defaultPath: exportOptions.value.exportPath || undefined,
    });

    if (selectedPath) {
      exportOptions.value.exportPath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
      usingDefaultExportPath.value = false;
    }
  } catch (error) {
    console.error('选择导出目录失败:', error);
    ElMessage.error(t('messages.selectDirectoryFailed'));
  }
}

function handleCancel() {
  emit('update:modelValue', false);
}

async function startExport() {
  exportLoading.value = true;
  try {
    const params = {
      connectionId: props.connectionId,
      databaseName: props.databaseName,
      schemaName: props.schemaName,
      tableName: props.tableName,
      format: exportOptions.value.format,
      useFilters: exportOptions.value.useFilters,
      filters: exportOptions.value.useFilters ? props.advancedFilters || {} : {},
      remarks: exportOptions.value.remarks,
      exportPath: exportOptions.value.exportPath || null,
    };

    const taskId = await invoke('export_table_data', { params });
    ElMessage.success(t('messages.exportStarted', { taskId }));
    emit('update:modelValue', false);
  } catch (error) {
    console.error('启动导出任务失败:', error);
    ElMessage.error(t('messages.exportFailed', { error: String(error) }));
  } finally {
    exportLoading.value = false;
  }
}
</script>
