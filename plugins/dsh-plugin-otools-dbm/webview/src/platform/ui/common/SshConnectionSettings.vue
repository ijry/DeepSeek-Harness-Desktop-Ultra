<template>
  <div class="ssh-settings">
    <div class="ssh-settings-header">
      <div class="ssh-settings-copy">
        <div class="ssh-settings-title">{{ t('platform.sshConnectionSettings.title') }}</div>
        <div class="ssh-settings-description">
          {{ t('platform.sshConnectionSettings.description') }}
        </div>
      </div>
      <el-switch
        :model-value="ssh.enabled"
        :disabled="disabled"
        inline-prompt
        :active-text="t('platform.sshConnectionSettings.switchOn')"
        :inactive-text="t('platform.sshConnectionSettings.switchOff')"
        @update:model-value="handleEnabledChange"
      />
    </div>

    <div v-if="ssh.enabled" class="ssh-settings-fields">
      <div class="ssh-settings-row">
        <el-form-item class="ssh-form-item ssh-form-item-grow" :label="t('platform.sshConnectionSettings.host')" :prop="`${propPrefix}.host`">
          <el-input
            :model-value="ssh.host"
            :disabled="disabled"
            :placeholder="t('platform.sshConnectionSettings.hostPlaceholder')"
            @update:model-value="(value) => updateSsh({ host: value })"
          />
        </el-form-item>
        <el-form-item class="ssh-form-item ssh-form-item-port" :label="t('platform.sshConnectionSettings.port')" :prop="`${propPrefix}.port`">
          <el-input-number
            :model-value="ssh.port"
            :disabled="disabled"
            :min="1"
            :max="65535"
            controls-position="right"
            style="width: 100%"
            @update:model-value="handlePortChange"
          />
        </el-form-item>
      </div>

      <el-form-item :label="t('platform.sshConnectionSettings.username')" :prop="`${propPrefix}.username`">
        <el-input
          :model-value="ssh.username"
          :disabled="disabled"
          :placeholder="t('platform.sshConnectionSettings.usernamePlaceholder')"
          @update:model-value="(value) => updateSsh({ username: value })"
        />
      </el-form-item>

      <el-form-item :label="t('platform.sshConnectionSettings.authType')" :prop="`${propPrefix}.auth_type`">
        <el-radio-group
          :model-value="ssh.auth_type"
          :disabled="disabled"
          @update:model-value="handleAuthTypeChange"
        >
          <el-radio label="password">{{ t('platform.sshConnectionSettings.authPassword') }}</el-radio>
          <el-radio label="private_key">{{ t('platform.sshConnectionSettings.authPrivateKey') }}</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item v-if="ssh.auth_type === 'password'" :label="t('platform.sshConnectionSettings.password')" :prop="`${propPrefix}.password`">
        <el-input
          :model-value="ssh.password"
          :disabled="disabled"
          type="password"
          show-password
          :placeholder="t('platform.sshConnectionSettings.passwordPlaceholder')"
          @update:model-value="(value) => updateSsh({ password: value })"
        />
      </el-form-item>

      <template v-else>
        <el-form-item :label="t('platform.sshConnectionSettings.privateKeyPath')" :prop="`${propPrefix}.private_key_path`">
          <div class="ssh-key-picker">
            <el-input
              :model-value="ssh.private_key_path"
              :disabled="disabled"
              :placeholder="t('platform.sshConnectionSettings.privateKeyPathPlaceholder')"
              @update:model-value="(value) => updateSsh({ private_key_path: value })"
            />
            <el-button :disabled="disabled" @click="pickPrivateKey">{{ t('platform.sshConnectionSettings.selectPrivateKey') }}</el-button>
          </div>
        </el-form-item>

        <el-form-item :label="t('platform.sshConnectionSettings.passphrase')" :prop="`${propPrefix}.passphrase`">
          <el-input
            :model-value="ssh.passphrase"
            :disabled="disabled"
            type="password"
            show-password
            :placeholder="t('platform.sshConnectionSettings.passphrasePlaceholder')"
            @update:model-value="(value) => updateSsh({ passphrase: value })"
          />
        </el-form-item>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog';
import { ElMessage } from 'element-plus';
import { computed } from 'vue';
import { t } from '@/platform/i18n';
import { normalizeDbSshConfig, type DbSshAuthType, type DbSshConfig } from '@/utils/dbm';

const props = withDefaults(defineProps<{
  modelValue?: DbSshConfig | null;
  propPrefix?: string;
  disabled?: boolean;
}>(), {
  propPrefix: 'ssh',
  disabled: false
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: DbSshConfig): void;
}>();

const ssh = computed(() => normalizeDbSshConfig(props.modelValue));

const updateSsh = (patch: Partial<DbSshConfig>) => {
  emit('update:modelValue', normalizeDbSshConfig({
    ...ssh.value,
    ...patch
  }));
};

const handleEnabledChange = (value: string | number | boolean) => {
  updateSsh({ enabled: !!value });
};

const handlePortChange = (value: string | number | null | undefined) => {
  const port = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 22;
  updateSsh({ port });
};

const handleAuthTypeChange = (value: string | number | boolean) => {
  const authType: DbSshAuthType = value === 'private_key' ? 'private_key' : 'password';
  updateSsh({ auth_type: authType });
};

const pickPrivateKey = async () => {
  if (props.disabled) {
    return;
  }

  try {
    const selected = await open({
      directory: false,
      multiple: false
    });
    if (typeof selected === 'string' && selected.trim()) {
      updateSsh({ private_key_path: selected });
    }
  } catch (error) {
    console.error('选择 SSH 私钥失败:', error);
    ElMessage.error(t('platform.sshConnectionSettings.selectPrivateKeyFailed'));
  }
};
</script>

<style scoped>
.ssh-settings {
  margin-bottom: 18px;
  padding: 14px 14px 4px;
  border: 1px solid var(--layout-border-color);
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-bg-color) 86%, var(--el-fill-color-light) 14%);
}

.ssh-settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.ssh-settings-copy {
  min-width: 0;
}

.ssh-settings-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.ssh-settings-description {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}

.ssh-settings-fields {
  display: flex;
  flex-direction: column;
}

.ssh-settings-row {
  display: flex;
  gap: 10px;
}

.ssh-form-item {
  margin-bottom: 14px;
}

.ssh-form-item-grow {
  flex: 1;
}

.ssh-form-item-port {
  width: 200px;
  flex-shrink: 0;
}

.ssh-key-picker {
  width: 100%;
  display: flex;
  gap: 10px;
}

.ssh-key-picker :deep(.el-input) {
  flex: 1;
}

@media (max-width: 640px) {
  .ssh-settings {
    padding-inline: 12px;
  }

  .ssh-settings-header,
  .ssh-settings-row {
    flex-direction: column;
  }

  .ssh-key-picker {
    flex-direction: column;
  }

  .ssh-form-item-port {
    width: 100%;
  }
}
</style>
