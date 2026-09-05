<template>
  <el-dialog
    v-if="modelValue"
    :model-value="modelValue"
    :title="t('title')"
    width="600px"
    @close="handleCancel"
  >
    <div class="export-checkbox-container">
      <div class="select-actions">
        <el-button size="small" @click="selectAllTables">{{ t('selectAll') }}</el-button>
        <el-button size="small" @click="invertSelectedTables">{{ t('invertSelection') }}</el-button>
      </div>
      <el-checkbox-group v-model="selectedTables" class="table-checkbox-group">
        <el-checkbox
          v-for="table in tables"
          :key="table"
          :label="table"
          class="table-checkbox-item"
        >
          {{ table }}
        </el-checkbox>
      </el-checkbox-group>

      <p>{{ t('formatLabel') }}</p>
      <el-radio-group v-model="selectedFormat">
        <el-radio-button label="sql">{{ t('formats.sql') }}</el-radio-button>
        <el-radio-button label="excel">{{ t('formats.excel') }}</el-radio-button>
      </el-radio-group>
    </div>
    <template #footer>
      <el-button size="small" @click="handleCancel">{{ t('cancel') }}</el-button>
      <el-button size="small" type="primary" @click="handleConfirm">{{ t('export') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  modelValue: boolean;
  tables: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [payload: { selectedTables: string[]; selectedFormat: 'excel' | 'sql' }];
}>();
const { t } = useI18nScope('dbm.exportDialog');

const selectedTables = ref<string[]>([]);
const selectedFormat = ref<'excel' | 'sql'>('sql');

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      selectedTables.value = [];
      selectedFormat.value = 'sql';
    }
  }
);

const selectAllTables = () => {
  selectedTables.value = [...props.tables];
};

const invertSelectedTables = () => {
  const selectedSet = new Set(selectedTables.value);
  selectedTables.value = props.tables.filter((table) => !selectedSet.has(table));
};

const handleCancel = () => {
  emit('update:modelValue', false);
};

const handleConfirm = () => {
  emit('confirm', {
    selectedTables: selectedTables.value,
    selectedFormat: selectedFormat.value
  });
};
</script>

<style scoped>
.select-actions {
  margin-bottom: 10px;
  display: flex;
  gap: 8px;
}

.table-checkbox-group {
  max-height: 360px;
  overflow-y: auto;
  margin-bottom: 20px;
}

.table-checkbox-item {
  display: block;
}
</style>
