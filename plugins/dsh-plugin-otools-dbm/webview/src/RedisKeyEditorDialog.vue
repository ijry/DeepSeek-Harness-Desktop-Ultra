<template>
  <el-dialog
    :model-value="modelValue"
    :title="resolvedTitle"
    width="720px"
    @close="emit('update:modelValue', false)"
  >
    <div class="redis-editor">
      <div class="form-row">
        <div class="field-block field-key">
          <div class="field-label">{{ t('fields.keyName') }}</div>
          <el-input v-model="form.key_name" :disabled="!allowKeyNameEdit" :placeholder="t('placeholders.keyName')" />
        </div>
        <div class="field-block field-type">
          <div class="field-label">{{ t('fields.type') }}</div>
          <el-select v-model="form.value_type" :disabled="!allowTypeChange">
            <el-option :label="t('typeOptions.string')" value="string" />
            <el-option :label="t('typeOptions.hash')" value="hash" />
            <el-option :label="t('typeOptions.list')" value="list" />
            <el-option :label="t('typeOptions.set')" value="set" />
            <el-option :label="t('typeOptions.zset')" value="zset" />
          </el-select>
        </div>
        <div class="field-block field-ttl">
          <div class="field-label">{{ t('fields.ttl') }}</div>
          <el-input-number v-model="ttlInput" :min="1" :disabled="!ttlEnabled" />
          <el-checkbox v-model="ttlEnabled">{{ t('enableTtl') }}</el-checkbox>
        </div>
      </div>

      <div v-if="form.value_type === 'string'" class="string-editor">
        <div class="field-label">{{ t('fields.value') }}</div>
        <el-input v-model="stringValue" type="textarea" :rows="8" :placeholder="t('placeholders.stringValue')" />
      </div>

      <div v-else class="entries-editor">
        <div class="entries-header">
          <div class="field-label">{{ t('fields.entries') }}</div>
          <el-button size="small" @click="addEntry">{{ t('addEntry') }}</el-button>
        </div>

        <div
          v-for="(entry, index) in form.entries"
          :key="index"
          class="entry-row"
        >
          <el-input
            v-if="form.value_type === 'hash'"
            v-model="entry.field"
            :placeholder="t('placeholders.field')"
            class="entry-cell"
          />
          <el-input
            v-if="form.value_type === 'zset'"
            v-model="entry.score"
            :placeholder="t('placeholders.score')"
            class="entry-cell entry-score"
          />
          <el-input
            v-model="entry.value"
            :placeholder="form.value_type === 'zset' ? t('placeholders.member') : t('placeholders.value')"
            class="entry-cell"
          />
          <el-button size="small" type="danger" plain @click="removeEntry(index)">{{ t('delete') }}</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="emit('update:modelValue', false)">{{ t('cancel') }}</el-button>
      <el-button size="small" type="primary" @click="handleConfirm">{{ t('save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { RedisKeyMutation } from './service';
import { useI18nScope } from '@/platform/i18n';

const createEmptyMutation = (): RedisKeyMutation => ({
  key_name: '',
  value_type: 'string',
  ttl_seconds: null,
  entries: [{ value: '' }]
});

const props = withDefaults(defineProps<{
  modelValue: boolean;
  title?: string;
  initialValue?: RedisKeyMutation | null;
  allowKeyNameEdit?: boolean;
  allowTypeChange?: boolean;
}>(), {
  title: '',
  initialValue: null,
  allowKeyNameEdit: true,
  allowTypeChange: true
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'confirm', payload: RedisKeyMutation): void;
}>();
const { t } = useI18nScope('dbm.redisKeyEditor');

const form = reactive<RedisKeyMutation>(createEmptyMutation());
const ttlEnabled = ref(false);
const resolvedTitle = computed(() => props.title || t('title'));

const stringValue = computed({
  get: () => form.entries[0]?.value || '',
  set: (value: string) => {
    form.entries = [{ value }];
  }
});

const ttlInput = computed({
  get: () => form.ttl_seconds ?? 60,
  set: (value: number) => {
    form.ttl_seconds = value;
  }
});

const cloneInitialValue = (value?: RedisKeyMutation | null) => {
  const nextValue = value ? JSON.parse(JSON.stringify(value)) as RedisKeyMutation : createEmptyMutation();
  form.key_name = nextValue.key_name;
  form.value_type = nextValue.value_type;
  form.ttl_seconds = nextValue.ttl_seconds ?? null;
  form.entries = nextValue.entries?.length ? nextValue.entries : [{ value: '' }];
  ttlEnabled.value = typeof nextValue.ttl_seconds === 'number' && nextValue.ttl_seconds > 0;
};

watch(
  () => [props.modelValue, props.initialValue],
  () => {
    if (props.modelValue) {
      cloneInitialValue(props.initialValue);
    }
  },
  { immediate: true, deep: true }
);

watch(
  () => form.value_type,
  (nextType) => {
    if (nextType === 'string') {
      form.entries = [{ value: form.entries[0]?.value || '' }];
      return;
    }

    if (!form.entries.length) {
      addEntry();
    }
  }
);

const addEntry = () => {
  if (form.value_type === 'hash') {
    form.entries.push({ field: '', value: '' });
    return;
  }

  if (form.value_type === 'zset') {
    form.entries.push({ score: '0', value: '' });
    return;
  }

  form.entries.push({ value: '' });
};

const removeEntry = (index: number) => {
  form.entries.splice(index, 1);
  if (!form.entries.length) {
    addEntry();
  }
};

const handleConfirm = () => {
  const payload: RedisKeyMutation = {
    key_name: form.key_name.trim(),
    value_type: form.value_type,
    ttl_seconds: ttlEnabled.value ? (form.ttl_seconds ?? 60) : null,
    entries: form.entries.map((entry) => ({
      field: entry.field?.trim() || undefined,
      value: entry.value ?? '',
      score: entry.score?.trim() || undefined
    }))
  };

  if (!payload.key_name) {
    ElMessage.warning(t('keyNameRequired'));
    return;
  }

  if (payload.value_type !== 'string' && !payload.entries.length) {
    ElMessage.warning(t('atLeastOneEntry'));
    return;
  }

  emit('confirm', payload);
};
</script>

<style scoped>
.redis-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.string-editor,
.entries-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entries-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.entry-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  gap: 10px;
}

.entry-cell {
  min-width: 0;
}

.entry-score {
  grid-column: span 1;
}
</style>
