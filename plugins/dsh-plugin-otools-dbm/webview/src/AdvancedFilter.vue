<template>
  <div class="advanced-filter">
    <div 
      v-if="showFilterConditions" 
      class="filter-conditions-container py-5px mb-4px rounded-lg"
    >
    <div class="overflow-y-scroll" style="max-height: 180px;">
      <div class="filter-condition-item mb-0px pb-0px" v-for="(condition, index) in conditions" :key="index">
          <div class="flex items-center gap-2">
            <!-- 复选框 -->
            <el-checkbox class="h-29px"
              v-model="condition.enabled" 
            ></el-checkbox>
            
            <!-- 字段名下拉框 -->
            <el-select
              v-model="condition.field"
              :placeholder="t('fieldPlaceholder')"
              size="small"
              style="width: 200px;"
            >
              <el-option
                v-for="field in fields"
                :key="field"
                :label="field"
                :value="field"
              />
            </el-select>

            <!-- 条件操作符 -->
            <el-select
              v-model="condition.operator"
              :placeholder="t('operatorPlaceholder')"
              size="small"
              style="width: 120px;"
            >
              <el-option
                v-for="op in operators"
                :key="op.value"
                :label="op.label"
                :value="op.value"
              />
            </el-select>

            <!-- 值输入 -->
            <div class="flex-1">
              <el-input
                v-model="condition.value"
                :placeholder="getPlaceholder(condition.operator)"
                size="small"
                style="width: 100%;"
              />
            </div>

            <!-- 操作按钮组 -->
            <div class="operation-buttons w-100px flex gap-0px">
              <el-button
                size="small"
                type="danger"
                round
                plain
                class="w-18px h-18px"
                @click="removeCondition(index)"
                :icon="Minus"
              >
              </el-button>
              
              <el-button
                size="small"
                type="primary"
                round
                plain
                class="w-18px h-18px"
                @click="addCondition(index + 1)"
                :icon="Plus"
              >
              </el-button>
            </div>
          </div>
        </div>
      </div>
      <!-- 应用筛选按钮 -->
      <div class="filter-actions mt-4px text-right">
        <el-button 
          size="small" 
          @click="clearAllConditions"
        >
          {{ t('clear') }}
        </el-button>
        <el-button 
          size="small" 
          type="primary" 
          @click="applyFilters"
        >
          {{ t('apply') }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Minus } from '@element-plus/icons-vue';
import { useI18nScope } from '@/platform/i18n';

interface FilterCondition {
  field: string;
  operator: string;
  value: string;
  enabled: boolean; // 新增属性，控制条件是否启用
}

interface Props {
  fields: string[]; // 可供筛选的字段列表
}

const props = defineProps<Props>();
const emit = defineEmits(['apply-filters', 'conditions-change']); // 添加条件变化事件
const { t } = useI18nScope('dbm.advancedFilter');

// 显示筛选条件区域
const showFilterConditions = ref(false);

// 筛选条件列表
const conditions = ref<FilterCondition[]>([
  { field: '', operator: '=', value: '', enabled: true }
]);

// 操作符选项
const operators = [
  { label: t('operators.eq'), value: '=' },
  { label: t('operators.ne'), value: '!=' },
  { label: t('operators.gt'), value: '>' },
  { label: t('operators.lt'), value: '<' },
  { label: t('operators.gte'), value: '>=' },
  { label: t('operators.lte'), value: '<=' },
  { label: t('operators.like'), value: 'LIKE' },
  { label: t('operators.notLike'), value: 'NOT_LIKE' },
  { label: t('operators.isNull'), value: 'IS_NULL' },
  { label: t('operators.isNotNull'), value: 'IS_NOT_NULL' },
];

// 根据操作符返回占位符文本
const getPlaceholder = (operator: string) => {
  if (operator === 'IS_NULL' || operator === 'IS_NOT_NULL') {
    return t('noValueNeeded');
  }
  return t('valuePlaceholder');
};

// 添加筛选条件
const addCondition = (index?: number) => {
  const newCondition: FilterCondition = {
    field: '',
    operator: '=',
    value: '',
    enabled: true
  };

  if (index !== undefined) {
    conditions.value.splice(index, 0, newCondition);
  } else {
    conditions.value.push(newCondition);
  }
  
  // 发出条件变化事件
  emit('conditions-change', conditions.value.length);
};

// 移除筛选条件
const removeCondition = (index: number) => {
  if (conditions.value.length <= 1) {
    conditions.value[0] = { field: '', operator: '=', value: '', enabled: true };
  } else {
    conditions.value.splice(index, 1);
  }
  
  // 发出条件变化事件
  emit('conditions-change', conditions.value.length);
};

// 清空所有筛选条件
const clearAllConditions = () => {
  conditions.value = [{ field: '', operator: '=', value: '', enabled: true }];
  showFilterConditions.value = false;
  
  // 发出条件变化事件
  emit('conditions-change', conditions.value.length);
};

// 应用筛选
const applyFilters = () => {
  // 获取被启用的筛选条件
  const enabledConditions = conditions.value.filter(c => 
    c.enabled &&
    c.field && 
    c.operator && 
    (c.value || ['IS_NULL', 'IS_NOT_NULL'].includes(c.operator))
  );
  
  // 发出条件变化事件
  emit('conditions-change', conditions.value.length);
  
  // 发送筛选条件给父组件
  emit('apply-filters', enabledConditions);
  ElMessage.success(t('applied', { count: enabledConditions.length }));
};

const toggleFilterConditions = () => {
  showFilterConditions.value = !showFilterConditions.value;
};

defineExpose({
  toggleFilterConditions,
  showFilterConditions,
  conditions  // 暴露条件数组，以便外部访问
});
</script>

<style scoped lang="scss">
.advanced-filter {
  .filter-header {
    display: flex;
    justify-content: flex-start;
  }

  .filter-conditions-container {
    border: 1px solid var(--layout-border-color);
    background: var(--el-bg-color);
  }

  .filter-condition-item {
    border-bottom: 1px solid var(--layout-border-color);

    &:last-child {
      border-bottom: none;
      padding-bottom: 0;
      margin-bottom: 0;
    }
  }

  .filter-actions {
    button {
      margin-left: 10px;
    }
  }
}
</style>
