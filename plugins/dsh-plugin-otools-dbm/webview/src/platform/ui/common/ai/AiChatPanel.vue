<template>
  <div class="ai-chat-panel" :class="`ai-chat-panel--${theme}`">
    <div ref="messageListRef" class="ai-chat-panel__messages">
      <div v-if="normalizedMessages.length" class="ai-chat-panel__message-list">
        <div
          v-for="item in normalizedMessages"
          :key="item.id"
          class="ai-chat-panel__message"
          :class="`is-${item.role}`"
        >
          <div class="ai-chat-panel__role">
            {{ item.role === 'user' ? t('platform.aiChatPanel.roleUser') : t('platform.aiChatPanel.roleAssistant') }}
          </div>
          <div class="ai-chat-panel__content">
            {{ item.content }}
          </div>
        </div>
      </div>
      <el-empty
        v-else
        :description="historyReady ? resolvedEmptyDescription : t('platform.aiChatPanel.loadingHistory')"
        :image-size="56"
      />
    </div>

    <div class="ai-chat-panel__composer">
      <el-input
        v-model="inputProxy"
        type="textarea"
        :rows="inputRows"
        resize="none"
        :placeholder="resolvedPlaceholder"
        @keydown="handleComposerKeydown"
      />
      <div v-if="hintText" class="ai-chat-panel__hint">
        {{ hintText }}
      </div>
      <div class="ai-chat-panel__actions">
        <div class="ai-chat-panel__actions-slot">
          <slot
            name="actions"
            :messages="normalizedMessages"
            :history-ready="historyReady"
          />
        </div>
        <el-button
          size="small"
          type="primary"
          :loading="loading"
          :disabled="resolvedSubmitDisabled"
          @click="handleSubmit"
        >
          {{ resolvedSubmitButtonText }}
        </el-button>
      </div>
      <div v-if="errorText" class="ai-chat-panel__error">
        {{ errorText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '@/platform/i18n';
import {
  normalizeAiChatMessages,
  OtoolsAiApi,
  type AiChatMessage,
} from '@/utils/ai';

const props = withDefaults(defineProps<{
  messages?: AiChatMessage[];
  inputValue?: string;
  chatPrefix?: string;
  initialMessages?: AiChatMessage[];
  loading?: boolean;
  errorText?: string;
  placeholder?: string;
  hintText?: string;
  submitButtonText?: string;
  submitDisabled?: boolean;
  inputRows?: number;
  emptyDescription?: string;
  theme?: 'neutral' | 'dashboard';
}>(), {
  messages: () => [],
  inputValue: '',
  chatPrefix: '',
  initialMessages: () => [],
  loading: false,
  errorText: '',
  placeholder: '',
  hintText: '',
  submitButtonText: '',
  submitDisabled: false,
  inputRows: 5,
  emptyDescription: '',
  theme: 'neutral',
});

const emit = defineEmits<{
  (e: 'update:messages', value: AiChatMessage[]): void;
  (e: 'update:inputValue', value: string): void;
  (e: 'submit', value: string): void;
  (e: 'history-loaded', value: AiChatMessage[]): void;
  (e: 'history-error', error: unknown): void;
}>();

const messageListRef = ref<HTMLDivElement | null>(null);
const historyReady = ref(false);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isHydratingHistory = false;

const normalizedMessages = computed(() => normalizeAiChatMessages(props.messages));

const inputProxy = computed({
  get: () => props.inputValue,
  set: (value: string) => emit('update:inputValue', value),
});
const resolvedPlaceholder = computed(() => props.placeholder || t('platform.aiChatPanel.placeholder'));
const resolvedSubmitButtonText = computed(() => props.submitButtonText || t('platform.aiChatPanel.submit'));
const resolvedEmptyDescription = computed(() => props.emptyDescription || t('platform.aiChatPanel.empty'));

const resolvedSubmitDisabled = computed(() =>
  props.loading || props.submitDisabled || !props.inputValue.trim()
);

const clearSaveTimer = () => {
  if (!saveTimer) {
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = null;
};

const emitMessages = (messages: AiChatMessage[]) => {
  emit('update:messages', normalizeAiChatMessages(messages));
};

const scrollToBottom = async () => {
  await nextTick();
  const container = messageListRef.value;
  if (!container) {
    return;
  }
  container.scrollTop = container.scrollHeight;
};

const buildFallbackMessages = () => normalizeAiChatMessages(props.initialMessages);

const loadHistory = async () => {
  clearSaveTimer();
  isHydratingHistory = true;
  historyReady.value = false;

  const prefix = props.chatPrefix.trim();
  try {
    const loadedMessages = prefix
      ? await OtoolsAiApi.loadChatHistory(prefix)
      : [];
    const resolvedMessages = loadedMessages.length
      ? loadedMessages
      : buildFallbackMessages();
    emitMessages(resolvedMessages);
    emit('history-loaded', resolvedMessages);
  } catch (error) {
    emit('history-error', error);
    const fallbackMessages = buildFallbackMessages();
    emitMessages(fallbackMessages);
    emit('history-loaded', fallbackMessages);
  } finally {
    isHydratingHistory = false;
    historyReady.value = true;
    await scrollToBottom();
  }
};

const persistHistory = async () => {
  const prefix = props.chatPrefix.trim();
  if (!prefix) {
    return;
  }
  await OtoolsAiApi.saveChatHistory(prefix, normalizedMessages.value);
};

const handleSubmit = () => {
  if (resolvedSubmitDisabled.value) {
    return;
  }
  emit('submit', props.inputValue.trim());
};

const handleComposerKeydown = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    handleSubmit();
  }
};

watch(
  () => props.chatPrefix,
  () => {
    void loadHistory();
  },
  { immediate: true }
);

watch(
  normalizedMessages,
  () => {
    void scrollToBottom();
    if (!historyReady.value || isHydratingHistory) {
      return;
    }

    clearSaveTimer();
    saveTimer = setTimeout(async () => {
      try {
        await persistHistory();
      } catch (error) {
        console.error('保存 AI 对话记录失败:', error);
        emit('history-error', error);
      }
    }, 240);
  },
  { deep: true }
);

onBeforeUnmount(() => {
  clearSaveTimer();
});
</script>

<style scoped>
.ai-chat-panel {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-chat-panel__messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.ai-chat-panel__message-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-chat-panel__message {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--layout-border-color) 82%, white 18%);
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-fill-color-blank) 80%, var(--el-fill-color-light) 20%);
}

.ai-chat-panel__message.is-user {
  border-color: color-mix(in srgb, var(--el-color-primary) 18%, var(--layout-border-color) 82%);
  background: color-mix(in srgb, var(--el-color-primary-light-9) 22%, white 78%);
}

.ai-chat-panel__role {
  font-size: 11px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  letter-spacing: 0.04em;
}

.ai-chat-panel__content {
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-chat-panel__composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 2px;
}

.ai-chat-panel__hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.ai-chat-panel__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-chat-panel__actions-slot {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-chat-panel__error {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-color-danger);
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-chat-panel--dashboard .ai-chat-panel__message {
  border: none;
  border-radius: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
}

.ai-chat-panel--dashboard .ai-chat-panel__message.is-user {
  background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
}

.ai-chat-panel--dashboard .ai-chat-panel__message-list {
  gap: 8px;
}

.ai-chat-panel--dashboard .ai-chat-panel__role {
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}

.ai-chat-panel--dashboard .ai-chat-panel__content {
  line-height: 1.6;
}

.ai-chat-panel--dashboard .ai-chat-panel__composer {
  gap: 8px;
}
</style>
