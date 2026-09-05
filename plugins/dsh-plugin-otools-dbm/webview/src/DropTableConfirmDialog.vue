<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('title')"
    width="520px"
    :close-on-click-modal="false"
    :close-on-press-escape="!countingDown"
    :show-close="!countingDown"
    @close="handleCancel"
  >
    <div class="drop-table-dialog">
      <p class="drop-table-copy">
        {{ t('description.before') }} <strong>{{ expectedText }}</strong> {{ t('description.after') }}
      </p>

      <el-input
        v-model="confirmationText"
        size="large"
        :disabled="countingDown"
        :class="{ danger: shouldWarn }"
        :placeholder="expectedText"
      />

      <div class="drop-table-hint" :class="{ danger: shouldWarn }">
        <span v-if="countingDown">{{ t('countdown', { seconds: remainingSeconds }) }}</span>
        <span v-else-if="isMatched">{{ t('matched') }}</span>
        <span v-else>{{ t('unmatched') }}</span>
      </div>
    </div>

    <template #footer>
      <div class="drop-table-actions">
        <el-button size="small" @click="handleCancel">{{ t('cancel') }}</el-button>
        <el-button
          type="danger"
          size="small"
          :disabled="countingDown || !isMatched"
          @click="startCountdown"
        >
          {{ t('confirmDelete') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18nScope } from '@/platform/i18n';

const props = defineProps<{
  modelValue: boolean;
  databaseName: string;
  schemaName?: string;
  tableName: string;
  connectionId: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [payload: { connectionId: string; databaseName: string; schemaName?: string; tableName: string }];
}>();
const { t } = useI18nScope('dbm.dropTableConfirm');

const confirmationText = ref('');
const remainingSeconds = ref(10);
const countingDown = ref(false);
const hasAttemptedSubmit = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

const expectedText = computed(() =>
  props.schemaName
    ? `${props.databaseName}.${props.schemaName}.${props.tableName}`
    : `${props.databaseName}.${props.tableName}`
);
const isMatched = computed(() => confirmationText.value.trim() === expectedText.value);
const shouldWarn = computed(() => isMatched.value || countingDown.value);

const clearCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
};

const resetState = () => {
  clearCountdown();
  confirmationText.value = '';
  remainingSeconds.value = 10;
  countingDown.value = false;
  hasAttemptedSubmit.value = false;
};

const closeDialog = () => {
  emit('update:modelValue', false);
};

const handleCancel = () => {
  resetState();
  closeDialog();
};

const finalizeDelete = () => {
  clearCountdown();
  emit('confirm', {
    connectionId: props.connectionId,
    databaseName: props.databaseName,
    schemaName: props.schemaName,
    tableName: props.tableName
  });
  resetState();
  closeDialog();
};

const startCountdown = () => {
  hasAttemptedSubmit.value = true;
  if (!isMatched.value || countingDown.value) {
    return;
  }

  countingDown.value = true;
  remainingSeconds.value = 10;
  clearCountdown();

  countdownTimer = setInterval(() => {
    remainingSeconds.value -= 1;
    if (remainingSeconds.value <= 0) {
      finalizeDelete();
    }
  }, 1000);
};

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) {
      resetState();
    }
  }
);

onBeforeUnmount(() => {
  clearCountdown();
});
</script>

<style scoped lang="scss">
.drop-table-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.drop-table-copy {
  margin: 0;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.drop-table-hint {
  min-height: 20px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.drop-table-hint.danger {
  color: var(--el-color-danger);
}

.drop-table-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:deep(.el-input.danger .el-input__wrapper) {
  border-color: var(--el-color-danger) !important;
  box-shadow: 0 0 0 1px rgba(245, 108, 108, 0.38) inset;
  background: linear-gradient(120deg, rgba(245, 108, 108, 0.08), rgba(255, 120, 120, 0.22), rgba(245, 108, 108, 0.08));
  background-size: 220% 220%;
  animation: drop-table-danger-pulse 1s ease-in-out infinite;
}

@keyframes drop-table-danger-pulse {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}
</style>
