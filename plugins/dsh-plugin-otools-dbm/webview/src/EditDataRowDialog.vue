<template>
  <el-drawer
    v-if="dialogVisible"
    v-model="dialogVisible"
    :title="t('title', { tableName })"
    size="60%"
    :before-close="closeDialog"
  >
    <el-form
      v-if="formData"
      ref="formRef"
      :model="formData"
      label-width="auto"
    >
      <el-form-item
        v-for="(field, fieldName) in fieldConfigs"
        :key="fieldName"
        :label="fieldName"
        :prop="fieldName"
      >
        <el-input
          v-if="isJsonEditableField(fieldName)"
          v-model="jsonDraft[fieldName]"
          type="textarea"
          :rows="8"
          :placeholder="t('enterField', { fieldName })"
        />

        <!-- 普通字段使用普通输入框 -->
        <el-input
          v-else-if="!isTextType(field.data_type) && !isVarcharType(field.data_type)"
          v-model="formData[fieldName]"
          :placeholder="t('enterField', { fieldName })"
        >
          <template v-if="isIdField(fieldName)" #suffix>
            <el-dropdown trigger="click" @command="handleIdCommand($event, fieldName)">
              <el-button type="primary" :icon="MagicStick" size="small" circle />
                <template #dropdown>
                  <el-dropdown-menu>
                  <el-dropdown-item command="uuid" :title="t('generator.uuidPlainTitle')">
                    {{ t('generator.uuidPlain') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="hyphenatedUuid" :title="t('generator.uuidHyphenatedTitle')">
                    {{ t('generator.uuidHyphenated') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="timeOrderedUuid" :title="t('generator.timeOrderedUuidTitle')">
                    {{ t('generator.timeOrderedUuid') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="snowflake" :title="t('generator.snowflakeTitle')">
                    {{ t('generator.snowflake') }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-input>
        
        <!-- varchar类型字段使用textarea -->
        <el-input
          v-else-if="isVarcharType(field.data_type)"
          v-model="formData[fieldName]"
          type="textarea"
          :rows="2"
          :placeholder="t('enterField', { fieldName })"
        >
          <template v-if="isIdField(fieldName)" #suffix>
            <el-dropdown trigger="click" @command="handleIdCommand($event, fieldName)">
              <el-button type="primary" :icon="MagicStick" size="small" circle />
                <template #dropdown>
                  <el-dropdown-menu>
                  <el-dropdown-item command="uuid" :title="t('generator.uuidPlainTitle')">
                    {{ t('generator.uuidPlain') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="hyphenatedUuid" :title="t('generator.uuidHyphenatedTitle')">
                    {{ t('generator.uuidHyphenated') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="timeOrderedUuid" :title="t('generator.timeOrderedUuidTitle')">
                    {{ t('generator.timeOrderedUuid') }}
                  </el-dropdown-item>
                  <el-dropdown-item command="snowflake" :title="t('generator.snowflakeTitle')">
                    {{ t('generator.snowflake') }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-input>
        
        <!-- text类型字段使用选项卡 -->
        <div v-else class="text-editor-container w-full">
          <div class="flex items-center">
            <div v-if="isIdField(fieldName)">
              <el-dropdown trigger="click" @command="handleIdCommand($event, fieldName)">
                <el-button type="primary" :icon="MagicStick" size="small" circle />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="uuid" :title="t('generator.uuidPlainTitle')">
                      {{ t('generator.uuidPlain') }}
                    </el-dropdown-item>
                    <el-dropdown-item command="hyphenatedUuid" :title="t('generator.uuidHyphenatedTitle')">
                      {{ t('generator.uuidHyphenated') }}
                    </el-dropdown-item>
                    <el-dropdown-item command="timeOrderedUuid" :title="t('generator.timeOrderedUuidTitle')">
                      {{ t('generator.timeOrderedUuid') }}
                    </el-dropdown-item>
                    <el-dropdown-item command="snowflake" :title="t('generator.snowflakeTitle')">
                      {{ t('generator.snowflake') }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
          <el-tabs v-model="activeTab[fieldName]" type="">
            <el-tab-pane :label="t('tabs.text')" name="text">
              <el-input class="h-300px"
                v-model="formData[fieldName]"
                type="textarea"
                :rows="10"
                :placeholder="t('enterField', { fieldName })"
              />
            </el-tab-pane>
            <el-tab-pane :label="t('tabs.richText')" name="rich">
              <QuillEditor
                v-model:content="formData[fieldName]"
                theme="snow"
                :style="{ height: '300px', marginBottom: '10px' }"
                contentType="html"
              />
            </el-tab-pane>
            <el-tab-pane :label="t('tabs.markdown')" name="markdown">
              <VditorEditor
                v-model="formData[fieldName]"
                :height="300"
              />
            </el-tab-pane>
          </el-tabs>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <span class="dialog-footer">
        <el-button size="small" @click="closeDialog">{{ t('cancel') }}</el-button>
        <el-button size="small" type="primary" @click="confirmEdit">{{ t('confirm') }}</el-button>
      </span>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage, ElTabs, ElTabPane, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus'
import { MagicStick } from '@element-plus/icons-vue'
import { QuillEditor } from '@vueup/vue-quill'
import VditorEditor from '@/platform/ui/common/VditorEditor.vue'
import 'quill/dist/quill.snow.css'
import 'quill/dist/quill.bubble.css'
import 'quill/dist/quill.core.css'
import type { ColumnSchema } from './service'
import { useI18nScope } from '@/platform/i18n';

// 导入Quill编辑器所需的模块
import { Delta } from 'quill'

interface Props {
  rowData: any;
  fields: ColumnSchema[];
  tableName: string;
  connectionId: string;
  databaseName?: string;
  dbType?: string;
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'confirm', updatedRow: any): void;
}

const props = withDefaults(defineProps<Props>(), {})
const emit = defineEmits<Emits>()
const { t } = useI18nScope('dbm.editRowDialog');

const dialogVisible = computed({
  get: () => props.rowData !== null,
  set: (val) => emit('update:modelValue', val)
})

const formData = ref<Record<string, any> | null>(null)
const formRef = ref()
const jsonDraft = ref<Record<string, string>>({})

// 用于存储每个text字段当前激活的选项卡
const activeTab = ref<Record<string, string>>({})
const isMongoDb = computed(() => (props.dbType || '').toLowerCase() === 'mongodb')

// 从props.fields创建字段配置映射
const fieldConfigs = computed(() => {
  const configs: Record<string, ColumnSchema> = {}
  props.fields.forEach(field => {
    configs[field.name] = field
    // 为每个text类型字段设置默认激活的选项卡
    if (isTextType(field.data_type) && !activeTab.value[field.name]) {
      activeTab.value[field.name] = 'text' // 默认显示文本选项卡
    }
  })
  return configs
})

// 检查是否为text类型（不包含varchar）
const isTextType = (dataType: string) => {
  if (!dataType) return false
  const lowerType = dataType.toLowerCase()
  // 只包含text相关的类型，不包括varchar
  return lowerType.includes('text') || lowerType.includes('longtext') || lowerType.includes('mediumtext') || lowerType.includes('tinytext')
}

// 检查是否为varchar类型
const isVarcharType = (dataType: string) => {
  if (!dataType) return false
  const lowerType = dataType.toLowerCase()
  // 包含varchar或char的类型的判断
  return lowerType.includes('varchar') || lowerType.includes('char')
}

const isJsonDataType = (dataType: string) => {
  if (!dataType) return false
  return dataType.toLowerCase().includes('json')
}

const valueNeedsJsonEditor = (value: unknown) =>
  value !== null && typeof value === 'object'

const isJsonEditableField = (fieldName: string) => {
  const field = fieldConfigs.value[fieldName]
  const value = formData.value?.[fieldName]
  if (field && isJsonDataType(field.data_type)) return true
  if (isMongoDb.value && valueNeedsJsonEditor(value)) return true
  return valueNeedsJsonEditor(value)
}

// 检查字段名是否为id或以_id结尾
const isIdField = (fieldName: string) => {
  const lowerFieldName = fieldName.toLowerCase()
  return lowerFieldName === 'id' || lowerFieldName.endsWith('_id')
}

// 生成不带横线的UUID
const generateUUID = () => {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, function() {
    return (Math.random() * 16 | 0).toString(16);
  }).toUpperCase();
}

// 生成带横线的UUID
const generateHyphenatedUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }).toUpperCase();
}

// 生成基于时间的UUID (简化版)
const generateTimeOrderedUUID = () => {
  const timestamp = Date.now().toString(16).padStart(16, '0');
  const randomPart = Math.random().toString(36).substring(2, 10);
  return (timestamp + randomPart).toUpperCase();
}

// 生成雪花算法ID (简化版)
const generateSnowflakeId = () => {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2);
  return (timestamp + randomPart).toUpperCase();
}

// 处理ID生成命令
const handleIdCommand = (command: string, fieldName: string) => {
  switch(command) {
    case 'uuid':
      formData.value![fieldName] = generateUUID();
      break;
    case 'hyphenatedUuid':
      formData.value![fieldName] = generateHyphenatedUUID();
      break;
    case 'timeOrderedUuid':
      formData.value![fieldName] = generateTimeOrderedUUID();
      break;
    case 'snowflake':
      formData.value![fieldName] = generateSnowflakeId();
      break;
    default:
      console.warn(`Unknown command: ${command}`);
  }

  const commandKeyMap: Record<string, string> = {
    uuid: t('generator.uuidPlain'),
    hyphenatedUuid: t('generator.uuidHyphenated'),
    timeOrderedUuid: t('generator.timeOrderedUuid'),
    snowflake: t('generator.snowflake')
  };
  ElMessage.success(t('generator.filled', {
    fieldName,
    value: commandKeyMap[command] || command
  }));
}

// 初始化表单数据
watch(
  () => props.rowData,
  (newVal) => {
    if (newVal) {
      formData.value = { ...newVal }
      jsonDraft.value = {}
      // 为新数据重新初始化选项卡状态
      Object.keys(fieldConfigs.value).forEach(fieldName => {
        const field = fieldConfigs.value[fieldName];
        if (isTextType(field.data_type) && !activeTab.value[fieldName]) {
          activeTab.value[fieldName] = 'text'; // 默认显示文本选项卡
        }
        if (isJsonEditableField(fieldName)) {
          const rawValue = formData.value?.[fieldName]
          if (typeof rawValue === 'string' && isJsonDataType(field.data_type)) {
            jsonDraft.value[fieldName] = rawValue
          } else if (rawValue === null || rawValue === undefined) {
            jsonDraft.value[fieldName] = ''
          } else {
            jsonDraft.value[fieldName] = JSON.stringify(rawValue, null, 2)
          }
        }
      })
    } else {
      formData.value = null
      jsonDraft.value = {}
    }
  },
  { immediate: true }
)

const confirmEdit = () => {
  if (formData.value) {
    for (const [fieldName, draftValue] of Object.entries(jsonDraft.value)) {
      if (!isJsonEditableField(fieldName)) continue
      const trimmed = String(draftValue ?? '').trim()
      if (!trimmed) {
        formData.value[fieldName] = null
        continue
      }
      try {
        formData.value[fieldName] = JSON.parse(trimmed)
      } catch {
        ElMessage.error(t('jsonInvalid', { fieldName }))
        return
      }
    }
    emit('confirm', formData.value)
    closeDialog()
  }
}

const closeDialog = () => {
  emit('update:modelValue', false)
}
</script>

<style scoped lang="scss">
.text-editor-container {
  :deep(.ql-container) {
    height: 300px;
  }
  
  :deep(.el-textarea__inner) {
    height: 100%;
  }
}
</style>
