<template>
  <div class="odbc-settings">
    <el-form-item :label="t('mode')">
      <el-radio-group v-model="localValue.mode">
        <el-radio-button label="driver">{{ t('modeOptions.driver') }}</el-radio-button>
        <el-radio-button label="dsn">{{ t('modeOptions.dsn') }}</el-radio-button>
        <el-radio-button label="connection_string">{{ t('modeOptions.connectionString') }}</el-radio-button>
      </el-radio-group>
    </el-form-item>

    <el-form-item v-if="localValue.mode === 'driver'" :label="t('driver')">
      <el-input
        v-model="localValue.driver"
        :placeholder="t('placeholders.driver')"
      />
    </el-form-item>

    <el-form-item v-if="localValue.mode === 'dsn'" :label="t('dsn')">
      <el-input
        v-model="localValue.dsn"
        :placeholder="t('placeholders.dsn')"
      />
    </el-form-item>

    <el-form-item v-if="localValue.mode === 'connection_string'" :label="t('connectionString')">
      <el-input
        v-model="localValue.connection_string"
        type="textarea"
        :rows="3"
        :placeholder="t('placeholders.connectionString')"
      />
    </el-form-item>

    <el-form-item :label="t('extra')">
      <el-input
        v-model="localValue.extra"
        type="textarea"
        :rows="2"
        :placeholder="t('placeholders.extra')"
      />
    </el-form-item>

    <div class="odbc-hint">
      {{ t('hint') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { DbOdbcConfig } from './service';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  modelValue?: DbOdbcConfig | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: DbOdbcConfig): void;
}>();
const { t } = useI18nScope('dbm.odbcSettings');

const createDefaultValue = (): DbOdbcConfig => ({
  mode: 'driver',
  dsn: '',
  driver: '',
  connection_string: '',
  extra: ''
});

const localValue = reactive<DbOdbcConfig>(createDefaultValue());

watch(
  () => props.modelValue,
  (value) => {
    const next = {
      ...createDefaultValue(),
      ...(value || {})
    };
    localValue.mode = next.mode || 'driver';
    localValue.dsn = next.dsn || '';
    localValue.driver = next.driver || '';
    localValue.connection_string = next.connection_string || '';
    localValue.extra = next.extra || '';
  },
  { immediate: true }
);

watch(
  localValue,
  () => {
    emit('update:modelValue', { ...localValue });
  },
  { deep: true }
);
</script>

<style scoped>
.odbc-settings {
  width: 100%;
}

.odbc-hint {
  margin-top: -6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
</style>
