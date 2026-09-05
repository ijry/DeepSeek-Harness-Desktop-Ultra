<template>
  <el-drawer
    v-if="drawerVisible"
    :modal="false"
    v-model="drawerVisible"
    :title="t('title')"
    direction="btt"
    size="50%"
  >
    <div class="tasks-panel">
      <div class="toolbar mb-4 flex justify-between">
        <el-button type="primary" size="small" @click="refreshTasks">{{ t('toolbar.refresh') }}</el-button>
        <el-button size="small" @click="clearCompleted">{{ t('toolbar.clear') }}</el-button>
      </div>

      <el-table
        :data="tasks"
        style="width: 100%"
        :default-sort="{ prop: 'created_at', order: 'descending' }"
        v-loading="loading"
      >
        <!-- <el-table-column prop="id" label="任务ID" width="180" /> -->
        <el-table-column prop="name" :label="t('columns.name')" min-width="150" />
        <el-table-column prop="task_type" :label="t('columns.type')" width="100">
          <template #default="{ row }">
            <el-tag 
              :type="getTaskTypeTag(row.task_type)" 
              size="small"
            >
              {{ formatTaskTypeLabel(row.task_type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" :label="t('columns.status')" width="100">
          <template #default="{ row }">
            <el-tag :type="getTaskStatusTag(row.status)" size="small">
              {{ formatTaskStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="progress" :label="t('columns.progress')" width="120">
          <template #default="{ row }">
            <el-progress
              :percentage="row.progress"
              :format="formatProgress"
              :status="getTaskProgressStatus(row.status)"
              :stroke-width="6"
              :show-text="showTaskProgressText(row.status)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="created_at" :label="t('columns.createdAt')" width="150">
          <template #default="{ row }">
            {{ formatDateTime(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column prop="duration" :label="t('columns.duration')" width="100">
          <template #default="{ row }">
            <span>{{ formatDuration(row.duration) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('columns.actions')" width="200">
          <template #default="{ row }">
            <el-button
              v-if="normalizeTaskStatus(row.status) === 'running'"
              size="small"
              type="danger"
              @click="cancelTask(row.id)"
            >
              {{ t('actions.cancel') }}
            </el-button>
            <div
              v-else-if="normalizeTaskStatus(row.status) === 'completed'"
              style="display: flex; gap: 4px;"
            >
              <el-button
                v-if="row.result_path && row.result_path !== '' && row.result_path !== undefined"
                size="small"
                type="primary"
                @click="saveAsFile(row)"
              >
                {{ t('actions.saveAs') }}
              </el-button>
              <el-button
                v-if="row.result_path && row.result_path !== '' && row.result_path !== undefined"
                size="small"
                @click="openDirectory(row.result_path)"
              >
                {{ t('actions.openDirectory') }}
              </el-button>
            </div>
            <el-button
              v-else-if="normalizeTaskStatus(row.status) === 'completed' && (!row.result_path || row.result_path === '' || row.result_path === undefined)"
              size="small"
              disabled
            >
              {{ t('actions.noFile') }}
            </el-button>
            <el-button
              v-else-if="normalizeTaskStatus(row.status) === 'failed'"
              size="small"
              @click="retryTask(row)"
            >
              {{ t('actions.retry') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listen, type UnlistenFn } from '@tauri-apps/api/event'; // 修正导入路径
import { openHostFsWindow } from '@/platform/ui/fsWindow';
import {
  cancelDbmTask,
  clearCompletedDbmTasks,
  copyDbmExportedFile,
  getDbmBackgroundTasks,
  retryDbmTask,
} from './service';
import {
  normalizeDbmTask,
  roundDbmTaskProgress,
} from './service';
import type { DbmBackgroundTask } from './shared';
import { useI18nScope } from '@/platform/i18n';

type Task = DbmBackgroundTask
const { t } = useI18nScope('dbm.taskPanel');

// 任务面板组件的响应式数据
const drawerVisible = ref(false);
const tasks = ref<Task[]>([]);
const loading = ref(false); // 添加加载状态

const formatProgress = (percentage: number) => `${roundDbmTaskProgress(percentage).toFixed(2)}%`;

const normalizeTaskType = (taskType: string) => String(taskType || '').trim().toLowerCase();
const normalizeTaskStatus = (status: string) => String(status || '').trim().toLowerCase();

// 任务类型标签颜色
const getTaskTypeTag = (task_type: string) => {
  switch (normalizeTaskType(task_type)) {
    case 'export': return 'primary';
    case 'import': return 'success';
    case 'backup': return 'warning';
    case 'restore': return 'info';
    default: return 'info';
  }
};

const formatTaskTypeLabel = (taskType: string) => {
  switch (normalizeTaskType(taskType)) {
    case 'export':
      return t('type.export');
    case 'import':
      return t('type.import');
    case 'backup':
      return t('type.backup');
    case 'restore':
      return t('type.restore');
    default:
      return taskType;
  }
};

// 任务状态标签颜色
const getTaskStatusTag = (status: string) => {
  switch (normalizeTaskStatus(status)) {
    case 'completed': return 'success';
    case 'running': return 'primary';
    case 'failed': return 'danger';
    case 'pending': return 'info';
    case 'cancelled':
    case 'canceled':
      return 'info';
    default: return 'info';
  }
};

const formatTaskStatusLabel = (status: string) => {
  switch (normalizeTaskStatus(status)) {
    case 'completed':
      return t('status.completed');
    case 'running':
      return t('status.running');
    case 'failed':
      return t('status.failed');
    case 'pending':
      return t('status.pending');
    case 'cancelled':
    case 'canceled':
      return t('status.cancelled');
    default:
      return status;
  }
};

const getTaskProgressStatus = (status: string) => {
  switch (normalizeTaskStatus(status)) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'exception';
    default:
      return '';
  }
};

const showTaskProgressText = (status: string) => {
  const normalizedStatus = normalizeTaskStatus(status);
  return normalizedStatus !== 'completed' && normalizedStatus !== 'failed';
};

// 日期时间格式化函数
const formatDateTime = (isoString: string) => {
  if (!isoString) return '';
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

// 格式化持续时间
const formatDuration = (milliseconds: number) => {
  if (milliseconds < 1000) return `${Math.floor(milliseconds)}ms`;
  if (milliseconds < 60000) return `${Math.floor(milliseconds / 1000)}s`;
  if (milliseconds < 3600000) return `${Math.floor(milliseconds / 60000)}m`;
  return `${Math.floor(milliseconds / 3600000)}h`;
};

// 显示任务面板
const show = async () => {
  drawerVisible.value = true;
  // 等待DOM更新后再刷新任务列表
  await nextTick();
  refreshTasks(); // 打开时自动刷新任务列表
};

// 隐藏任务面板
const hide = () => {
  drawerVisible.value = false;
};

// 刷新任务列表
const refreshTasks = async () => {
  if (loading.value) return; // 防止重复请求
  
  loading.value = true;
  try {
    const response = await getDbmBackgroundTasks();
    tasks.value = response.map((task) => normalizeDbmTask(task));
    
    // 添加详细调试信息
    console.log('任务列表刷新:', response);
    response.forEach(task => {
      console.log(`任务 ${task.id}: 状态=${task.status}, 结果路径="${task.result_path}", 类型="${typeof task.result_path}"`);
      if(task.status === 'Completed') {
        console.log(`Completed任务 ${task.id}: result_path存在=${!!task.result_path}, result_path为空=${task.result_path === ''}`);
      }
    });
  } catch (error) {
    console.error('获取任务列表失败:', error);
  } finally {
    setTimeout(() => {
      loading.value = false;
    }, 100)
  }
};

// 清除已完成的任务
const clearCompleted = async () => {
  try {
    await ElMessageBox.confirm(
      t('messages.confirmClear'),
      t('messages.confirmActionTitle'),
      {
        confirmButtonText: t('actions.confirm'),
        cancelButtonText: t('actions.cancel'),
        type: 'warning',
      }
    );
    
    // 调用后端API清除已完成任务
    const count = await clearCompletedDbmTasks();
    await refreshTasks(); // 刷新任务列表
    
    if (count > 0) {
      ElMessage.success(t('messages.cleared', { count }));
    } else {
      ElMessage.info(t('messages.nothingToClear'));
    }
  } catch (error) {
    console.error('清除任务失败:', error);
    // 如果是用户取消操作，则不显示错误消息
    if (error && typeof error !== 'object') {
      ElMessage.error(t('messages.clearFailed'));
    }
  }
};

// 取消任务
const cancelTask = async (taskId: string) => {
  try {
    await ElMessageBox.confirm(
      t('messages.confirmCancelTask'),
      t('messages.confirmCancelTitle'),
      {
        confirmButtonText: t('actions.confirm'),
        cancelButtonText: t('actions.cancel'),
        type: 'warning',
      }
    );
    
    // 调用后端API取消任务
    await cancelDbmTask(taskId);
    await refreshTasks(); // 刷新任务列表
    ElMessage.success(t('messages.cancelled'));
  } catch {
    // 用户取消操作
  }
};

// 重试任务
const retryTask = async (task: Task) => {
  try {
    const newTaskId = await retryDbmTask(task.id);
    ElMessage.success(t('messages.retryStarted', { taskId: newTaskId }));
    await refreshTasks();
  } catch (error) {
    console.error('重试任务失败:', error);
    ElMessage.error(t('messages.retryFailed', { error: String(error) }));
  }
};

// 保存文件到新位置
const saveAsFile = async (task: Task) => {
  if (!task.result_path) {
    ElMessage.warning(t('messages.sourcePathMissing'));
    return;
  }

  try {
    // 动态导入Tauri插件
    const dialogModule = await import('@tauri-apps/plugin-dialog');
    
    // 提取原文件名
    const originalFileName = task.result_path.split('/').pop() || `export_${formatDateTime(task.created_at).replace(/[:\s]/g, '-')}.${task.result_path.split('.').pop() || 'dat'}`;
    
    // 打开保存对话框
    const filePath = await dialogModule.save({
      defaultPath: originalFileName,
      filters: [{
        name: t('filters.dataFiles'),
        extensions: ['csv', 'json', 'sql', 'xlsx', 'txt', 'dat']
      }]
    });
    
    if (filePath) {
      // 调用后端命令复制文件
      const result = await copyDbmExportedFile(task.result_path, filePath);
      
      if(result) {
        ElMessage.success(t('messages.fileSaved'));
      } else {
        ElMessage.error(t('messages.saveFileFailed'));
      }
    }
  } catch (error) {
    console.error('保存文件时出错:', error);
    // 如果插件不可用，使用原有下载方式
    try {
      downloadResult(task);
    } catch (fallbackError) {
      console.error('下载文件也失败:', fallbackError);
      ElMessage.error(t('messages.saveFileRetryLater'));
    }
  }
};

// 打开文件所在目录
const openDirectory = async (filePath: string) => {
  if (!filePath) {
    ElMessage.warning(t('messages.filePathMissing'));
    return;
  }

  try {
    await openHostFsWindow(filePath);
    ElMessage.success(t('messages.openDirectoryStarted'));
  } catch (error) {
    console.error('打开目录时出错:', error);
    ElMessage.error(t('messages.openDirectoryFailed'));
  }
};

// 下载结果 (保留原有的下载功能)
const downloadResult = (task: Task) => {
  console.log('Download result clicked for task:', task);
  if (task.result_path) {
    // 创建一个隐藏链接来触发下载
    const link = document.createElement('a');
    link.href = `file://${task.result_path}`;
    link.download = task.name + '_' + formatDateTime(task.created_at) + '.' + task.result_path.split('.').pop();
    link.click();
    ElMessage.success(t('messages.downloading'));
  } else {
    console.log('Task has no result_path:', task);
    ElMessage.warning(t('messages.filePathMissing'));
  }
};

// 任务更新事件监听器
let unlistenTaskUpdate: UnlistenFn | null = null;

// 用于去抖动的计时器
let refreshDebounceTimer: NodeJS.Timeout | null = null;

onMounted(async () => {
  // 监听任务更新事件
  try {
    unlistenTaskUpdate = await listen('task-updated', (event) => {
      // 使用防抖技术避免频繁刷新
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
      }
      
      // 延迟更新，避免连续事件导致的频繁刷新
      refreshDebounceTimer = setTimeout(() => {
        refreshTasks();
      }, 300); // 300ms 内的多次更新只响应最后一次
    });
    
    // 组件挂载后立即刷新一次任务列表，确保数据是最新的
    refreshTasks();
  } catch (error) {
    console.error('监听任务更新事件失败:', error);
  }
});

// 组件卸载时清理监听器
onUnmounted(() => {
  if (unlistenTaskUpdate) {
    unlistenTaskUpdate();
    unlistenTaskUpdate = null;
  }
  
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }
});

defineExpose({
  show,
  hide,
});
</script>

<style scoped>
.tasks-panel {
  padding: 0 20px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
