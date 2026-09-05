<template>
  <div class="table-struct flex-1" :class="{ 'p-3': isCreateMode }">
    <h4>{{ isCreateMode ? t('title.create') : t('title.edit') }}</h4>
    <div class="actions flex justify-between mb-10px">
      <div>
        <el-button plain size="small" type="primary" @click="saveChanges">{{ isCreateMode ? t('actions.createTable') : t('actions.saveChanges') }}</el-button>
        <el-button size="small" @click="resetChanges">{{ t('actions.reset') }}</el-button>
      </div>
      <div>
        <el-button size="small" type="default" @click="addColumn">{{ t('actions.addColumn') }}</el-button>
      </div>
    </div>

    <div v-if="isCreateMode" class="table-name-section mb-3">
      <div class="table-name-label">{{ t('tableName') }}</div>
      <el-input
        v-model="tableNameDraft"
        size="small"
        :placeholder="t('placeholders.tableName')"
      />
    </div>
  
    <div class="struct-table-container mb-3">
      <el-table 
        class="flex-1"
        :data="columns" 
        stripe 
        border
        height="100%"
        style="width: 100%"
      >
        <el-table-column prop="name" :label="t('columns.name')" min-width="130">
          <template #default="{ row, $index }">
            <el-input size="small"
              v-model="row.name" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              @change="markAsModified($index, 'name', row.name)"
            />
          </template>
        </el-table-column>
        
        <el-table-column prop="data_type" :label="t('columns.dataType')" min-width="130">
          <template #default="{ row, $index }">
            <el-select size="small"
              v-model="row.data_type" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              style="width: 100%"
              @change="markAsModified($index, 'data_type', row.data_type)"
            >
              <!-- 根据数据库类型动态显示选项 -->
              <el-option 
                v-for="option in dbTypeOptions" 
                :key="option.value" 
                :label="option.label" 
                :value="option.value" 
              />
            </el-select>
          </template>
        </el-table-column>
        
        <el-table-column prop="is_nullable" :label="t('columns.nullable')" width="70">
          <template #default="{ row, $index }">
            <el-checkbox size="small"
              v-model="row.is_nullable" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              @change="markAsModified($index, 'is_nullable', row.is_nullable)"
            />
          </template>
        </el-table-column>
        
        <el-table-column prop="default_value" :label="t('columns.defaultValue')" min-width="150">
          <template #default="{ row, $index }">
            <el-input
              size="small"
              v-model="row.default_value" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              :placeholder="t('placeholders.defaultValue')"
              @change="markAsModified($index, 'default_value', row.default_value)"
            >
              <template #append>
                <el-dropdown trigger="click" @command="(value) => selectDefaultValue(value, row, $index)">
                  <el-button size="small"> <el-icon><ArrowDown /></el-icon></el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item 
                        v-for="option in dbDefaultOptions" 
                        :key="option.value" 
                        :command="option.value"
                      >
                        {{ option.label }}
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
            </el-input>
          </template>
        </el-table-column>
        
        <el-table-column prop="character_maximum_length" :label="t('columns.maxLength')" min-width="120">
          <template #default="{ row, $index }">
            <el-input-number size="small"
              v-model="row.character_maximum_length" 
              :disabled="!isEditing(row)"
              :min="0"
              :class="getRowClass(row)"
              style="width: 100%"
              @change="markAsModified($index, 'character_maximum_length', row.character_maximum_length)"
            />
          </template>
        </el-table-column>
        
        <el-table-column prop="is_primary_key" :label="t('columns.primaryKey')" width="40">
          <template #default="{ row, $index }">
            <el-checkbox size="small"
              v-model="row.is_primary_key" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              @change="markAsModified($index, 'is_primary_key', row.is_primary_key)"
            />
          </template>
        </el-table-column>

        <el-table-column prop="column_comment" :label="t('columns.comment')" min-width="130">
          <template #default="{ row, $index }">
            <el-input size="small"
              v-model="row.column_comment" 
              :disabled="!isEditing(row)"
              :class="getRowClass(row)"
              @change="markAsModified($index, 'column_comment', row.column_comment)"
            />
          </template>
        </el-table-column>
        
        <el-table-column :label="t('columns.actions')" width="70">
          <template #default="{ row, $index }">
            <div class="action-buttons">
              <el-button 
                v-if="row.status === 'added'" 
                type="danger" 
                size="small"
                @click="removeColumn($index)"
              >
                {{ t('actions.delete') }}
              </el-button>
              <el-button 
                v-else-if="row.status !== 'deleted'" 
                type="warning" 
                size="small"
                plain
                @click="markForDeletion($index)"
              >
                {{ t('actions.delete') }}
              </el-button>
              <el-button 
                v-else 
                type="info" 
                size="small"
                @click="cancelDeletion($index)"
              >
                {{ t('actions.cancel') }}
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 表备注编辑区 -->
    <div class="table-comment-section mb-4">
      <el-input
        v-model="tableComment"
        type="textarea"
        :rows="3"
        :placeholder="t('placeholders.tableComment')"
        @input="markCommentAsModified"
      />
    </div>
    
    <!-- 索引管理 -->
    <div v-if="!isCreateMode" class="indexes-section mb-4">
     <div class="flex justify-between items-center mb-10px">
      <div class="flex items-center">
        <h4>{{ t('indexes.title') }}</h4>
        <span class="text-12px ml-2">{{ t('indexes.count', { count: indexes?.length || 0 }) }}</span>
      </div>
      <div class="actions flex justify-between mt-2">
        <el-button size="small" type="primary" plain
          @click="openAddIndexDialog">{{ t('indexes.add') }}</el-button>
      </div>
     </div>
      <el-table 
        :data="indexes" 
        stripe 
        border
        style="width: 100%"
        header-cell-class-name="bg-gray-100"
      >
        <el-table-column prop="name" :label="t('indexes.columns.name')" min-width="150">
          <template #default="{ row }">
            <span>{{ row.name }}</span>
          </template>
        </el-table-column>
        
        <el-table-column prop="columns" :label="t('indexes.columns.fields')" min-width="200">
          <template #default="{ row }">
            <el-tag 
              v-for="col in row.columns" 
              :key="col" 
              size="small" 
              class="mr-1 mt-1"
              type="info"
            >
              {{ col }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="is_unique" :label="t('indexes.columns.uniqueness')" width="100">
          <template #default="{ row }">
            <el-tag :type="row.is_unique ? 'success' : 'info'">
              {{ row.is_unique ? t('indexes.unique') : t('indexes.normal') }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column :label="t('indexes.columns.actions')" width="150">
          <template #default="{ row, $index }">
            <el-button 
              size="small" 
              type="danger"
              plain
              @click="deleteIndex(row, $index)"
            >
              {{ t('actions.delete') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    
    <!-- 显示建表SQL语句 -->
    <div v-if="!isCreateMode" class="create-statement-section mt-7 pb-40px">
      <h4>{{ t('createStatement.title') }}</h4>
      <el-input
        v-model="createStatement"
        type="textarea"
        autosize
        readonly
        :placeholder="t('createStatement.loading')"
      />
    </div>
  </div>
  
  <!-- 添加索引对话框 -->
  <el-dialog
    v-if="showAddIndexDialog && !isCreateMode"
    v-model="showAddIndexDialog"
    :title="t('indexes.dialog.title')"
    width="500px"
    :close-on-click-modal="false"
  >
    <el-form :model="newIndexForm" label-width="80px" size="default">
      <el-form-item :label="t('indexes.dialog.name')">
        <el-input v-model="newIndexForm.name" :placeholder="t('indexes.dialog.namePlaceholder')" />
      </el-form-item>
      
      <el-form-item :label="t('indexes.dialog.fields')">
        <el-select 
          v-model="newIndexForm.selectedColumns" 
          multiple 
          :placeholder="t('indexes.dialog.fieldsPlaceholder')"
          style="width: 100%"
        >
          <el-option 
            v-for="col in columns" 
            :key="col.name" 
            :label="col.name" 
            :value="col.name" 
          />
        </el-select>
      </el-form-item>
      
      <el-form-item :label="t('indexes.dialog.type')">
        <el-radio-group v-model="newIndexForm.is_unique">
          <el-radio :label="false">{{ t('indexes.normal') }}</el-radio>
          <el-radio :label="true">{{ t('indexes.unique') }}</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    
    <template #footer>
      <span class="dialog-footer">
        <el-button size="small" @click="showAddIndexDialog = false">{{ t('actions.cancel') }}</el-button>
        <el-button size="small" type="primary" @click="confirmAddIndex">{{ t('actions.confirm') }}</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { DbmApi, type ColumnModifySchema, type ColumnSchema } from './service';
import { useI18nScope } from '@/platform/i18n';

interface Props {
  connectionId: string;
  databaseName: string;
  schemaName?: string;
  tableName?: string;
  mode?: 'edit' | 'create';
}

const props = withDefaults(defineProps<Props>(), {
  tableName: '',
  mode: 'edit'
});

const emit = defineEmits<{
  'created-table': [payload: { connectionId: string; databaseName: string; schemaName?: string; tableName: string }]
}>();
const { t } = useI18nScope('dbm.tableStruct');

// 定义扩展的列类型，包含状态信息
interface ExtendedColumn extends ColumnSchema {
  status?: 'original' | 'added' | 'modified' | 'deleted';
  isEditing?: boolean;
  original_name?: string;
  column_comment?: string; // 新增字段备注属性
}

const columns = ref<ExtendedColumn[]>([]);
const originalColumns = ref<Record<string, Pick<ExtendedColumn, 'name' | 'data_type' | 'is_nullable' | 'default_value' | 'character_maximum_length' | 'is_primary_key' | 'column_comment'>>>({});
const indexes = ref<any[]>([]); // 索引列表
const currentDbType = ref<string>(''); // 当前数据库类型
const tableComment = ref<string>(''); // 表备注
const originalTableComment = ref<string>(''); // 原始表备注
const isCommentModified = ref<boolean>(false); // 表备注是否被修改
const createStatement = ref<string>(''); // 建表语句
const showAddIndexDialog = ref(false); // 控制添加索引对话框显示
const newIndexForm = ref({
  name: '',
  selectedColumns: [] as string[],
  is_unique: false
}); // 新建索引表单
const tableNameDraft = ref('');
const isCreateMode = computed(() => props.mode === 'create');
const parseErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    return JSON.stringify(error);
  }
  return t('messages.unknownError');
};

// 定义不同数据库类型的数据类型选项
const dbTypeOptionsMap = {
  mysql: [
    // 字符串类型
    { label: 'VARCHAR', value: 'VARCHAR' },
    { label: 'CHAR', value: 'CHAR' },
    { label: 'TEXT', value: 'TEXT' },
    { label: 'TINYTEXT', value: 'TINYTEXT' },
    { label: 'MEDIUMTEXT', value: 'MEDIUMTEXT' },
    { label: 'LONGTEXT', value: 'LONGTEXT' },
    { label: 'TINYBLOB', value: 'TINYBLOB' },
    { label: 'BLOB', value: 'BLOB' },
    { label: 'MEDIUMBLOB', value: 'MEDIUMBLOB' },
    { label: 'LONGBLOB', value: 'LONGBLOB' },
    
    // 数值类型
    { label: 'INT', value: 'INT' },
    { label: 'INTEGER', value: 'INTEGER' },
    { label: 'SMALLINT', value: 'SMALLINT' },
    { label: 'TINYINT', value: 'TINYINT' },
    { label: 'MEDIUMINT', value: 'MEDIUMINT' },
    { label: 'BIGINT', value: 'BIGINT' },
    
    // 小数类型
    { label: 'DECIMAL', value: 'DECIMAL' },
    { label: 'NUMERIC', value: 'NUMERIC' },
    { label: 'FLOAT', value: 'FLOAT' },
    { label: 'DOUBLE', value: 'DOUBLE' },
    
    // 日期时间类型
    { label: 'DATE', value: 'DATE' },
    { label: 'TIME', value: 'TIME' },
    { label: 'DATETIME', value: 'DATETIME' },
    { label: 'TIMESTAMP', value: 'TIMESTAMP' },
    { label: 'YEAR', value: 'YEAR' },
    
    // 其他类型
    { label: 'BOOLEAN', value: 'BOOLEAN' },
    { label: 'BOOL', value: 'BOOL' },
    { label: 'BIT', value: 'BIT' },
    { label: 'ENUM', value: 'ENUM' },
  ],
  postgresql: [
    // 字符串类型
    { label: 'VARCHAR', value: 'VARCHAR' },
    { label: 'CHAR', value: 'CHAR' },
    { label: 'TEXT', value: 'TEXT' },
    
    // 数值类型
    { label: 'INTEGER', value: 'INTEGER' },
    { label: 'INT', value: 'INT' },
    { label: 'SMALLINT', value: 'SMALLINT' },
    { label: 'BIGINT', value: 'BIGINT' },
    { label: 'SERIAL', value: 'SERIAL' },
    { label: 'BIGSERIAL', value: 'BIGSERIAL' },
    
    // 小数类型
    { label: 'DECIMAL', value: 'DECIMAL' },
    { label: 'NUMERIC', value: 'NUMERIC' },
    { label: 'REAL', value: 'REAL' },
    { label: 'DOUBLE PRECISION', value: 'DOUBLE PRECISION' },
    
    // 日期时间类型
    { label: 'DATE', value: 'DATE' },
    { label: 'TIME', value: 'TIME' },
    { label: 'TIMESTAMP', value: 'TIMESTAMP' },
    { label: 'TIMESTAMPTZ', value: 'TIMESTAMPTZ' },
    { label: 'INTERVAL', value: 'INTERVAL' },
    
    // 布尔类型
    { label: 'BOOLEAN', value: 'BOOLEAN' },
    
    // UUID
    { label: 'UUID', value: 'UUID' },
    
    // JSON类型
    { label: 'JSON', value: 'JSON' },
    { label: 'JSONB', value: 'JSONB' },
    
    // 网络地址类型
    { label: 'INET', value: 'INET' },
    { label: 'CIDR', value: 'CIDR' },
    
    // 二进制类型
    { label: 'BYTEA', value: 'BYTEA' },
    
    // XML
    { label: 'XML', value: 'XML' },
  ],
  sqlserver: [
    { label: 'NVARCHAR', value: 'NVARCHAR' },
    { label: 'VARCHAR', value: 'VARCHAR' },
    { label: 'NCHAR', value: 'NCHAR' },
    { label: 'TEXT', value: 'TEXT' },
    { label: 'INT', value: 'INT' },
    { label: 'BIGINT', value: 'BIGINT' },
    { label: 'DECIMAL', value: 'DECIMAL' },
    { label: 'FLOAT', value: 'FLOAT' },
    { label: 'BIT', value: 'BIT' },
    { label: 'DATE', value: 'DATE' },
    { label: 'DATETIME2', value: 'DATETIME2' },
    { label: 'VARBINARY', value: 'VARBINARY' }
  ],
  kingbasees: [] as Array<{ label: string; value: string }>,
  dameng: [] as Array<{ label: string; value: string }>,
  sqlite: [
    // SQLite使用动态类型系统，但通常使用以下类型
    { label: 'TEXT', value: 'TEXT' },
    { label: 'INTEGER', value: 'INTEGER' },
    { label: 'REAL', value: 'REAL' },
    { label: 'BLOB', value: 'BLOB' },
    { label: 'NUMERIC', value: 'NUMERIC' },
    
    // 映射到SQLite类型
    { label: 'VARCHAR', value: 'VARCHAR' },
    { label: 'CHAR', value: 'CHAR' },
    { label: 'DATE', value: 'DATE' },
    { label: 'TIMESTAMP', value: 'TIMESTAMP' },
    { label: 'BOOLEAN', value: 'BOOLEAN' },
  ],
  oracle: [
    { label: 'VARCHAR2', value: 'VARCHAR2' },
    { label: 'NVARCHAR2', value: 'NVARCHAR2' },
    { label: 'CHAR', value: 'CHAR' },
    { label: 'NCHAR', value: 'NCHAR' },
    { label: 'CLOB', value: 'CLOB' },
    { label: 'NCLOB', value: 'NCLOB' },
    { label: 'NUMBER', value: 'NUMBER' },
    { label: 'FLOAT', value: 'FLOAT' },
    { label: 'BINARY_FLOAT', value: 'BINARY_FLOAT' },
    { label: 'BINARY_DOUBLE', value: 'BINARY_DOUBLE' },
    { label: 'DATE', value: 'DATE' },
    { label: 'TIMESTAMP', value: 'TIMESTAMP' },
    { label: 'TIMESTAMP WITH TIME ZONE', value: 'TIMESTAMP WITH TIME ZONE' },
    { label: 'RAW', value: 'RAW' },
    { label: 'BLOB', value: 'BLOB' }
  ],
  mongodb: [] // MongoDB 不适用传统数据类型
};

// 根据当前数据库类型返回对应的数据类型选项
const dbTypeOptions = computed(() => {
  if (currentDbType.value) {
    const nextType = currentDbType.value.toLowerCase() === 'kingbasees'
      ? 'postgresql'
      : currentDbType.value.toLowerCase() === 'dameng'
        ? 'oracle'
        : currentDbType.value.toLowerCase();
    const options = dbTypeOptionsMap[nextType];
    return options || dbTypeOptionsMap.mysql; // 默认返回MySQL选项
  }
  return dbTypeOptionsMap.mysql; // 默认返回MySQL选项
});

// 根据当前数据库类型返回对应的默认值选项
const dbDefaultOptions = computed(() => {
  const options = [
    { label: t('defaultOptions.emptyString'), value: "''" },
    { label: 'NULL', value: 'NULL' },
    { label: t('defaultOptions.currentTimestamp'), value: 'CURRENT_TIMESTAMP' },
    { label: t('defaultOptions.currentTime'), value: 'NOW()' },
    { label: t('defaultOptions.currentTime'), value: 'NOW()' },
    { label: t('defaultOptions.sysdate'), value: 'SYSDATE()' },
    { label: t('defaultOptions.zero'), value: '0' },
    { label: t('defaultOptions.one'), value: '1' },
  ];
  
  if (currentDbType.value === 'mysql' || currentDbType.value === 'mariadb') {
    options.push({ label: t('defaultOptions.mysqlTimestampAutoUpdate'), value: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' });
  }
  
  if (currentDbType.value === 'postgresql' || currentDbType.value === 'kingbasees') {
    options.push({ label: t('defaultOptions.postgresqlRandom'), value: '(random())' });
  }
  
  if (currentDbType.value === 'sqlite') {
    options.push({ label: t('defaultOptions.sqliteCurrentTime'), value: 'datetime(\'now\')' });
    options.push({ label: t('defaultOptions.sqliteCurrentDate'), value: 'date(\'now\')' });
  }

  if (currentDbType.value === 'oracle' || currentDbType.value === 'dameng') {
    options.push({ label: t('defaultOptions.oracleCurrentTimestamp'), value: 'SYSTIMESTAMP' });
    options.push({ label: t('defaultOptions.oracleSysdate'), value: 'SYSDATE' });
  }
  
  return options;
});

const getOriginalKey = (col: ExtendedColumn) => col.original_name || col.name;

const createEmptyColumn = (): ExtendedColumn => ({
  name: '',
  data_type: dbTypeOptions.value[0]?.value || 'VARCHAR',
  is_nullable: true,
  default_value: null,
  character_maximum_length: null,
  is_primary_key: false,
  column_comment: '',
  status: 'added',
  isEditing: true,
  original_name: undefined
});

const loadConnectionType = async () => {
  const connection = await DbmApi.getConnection(props.connectionId);
  if (connection) {
    currentDbType.value = connection.db_type;
  }
};

const normalizeDefaultValue = (value: string | null | undefined) => {
  return value ?? null;
};

const toComparable = (col: ExtendedColumn) => ({
  name: col.name,
  data_type: col.data_type,
  is_nullable: col.is_nullable,
  default_value: normalizeDefaultValue(col.default_value),
  character_maximum_length: col.character_maximum_length ?? null,
  is_primary_key: col.is_primary_key,
  column_comment: col.column_comment || '' // 添加备注字段
});

const syncRowStatusWithOriginal = (col: ExtendedColumn) => {
  if (col.status === 'added' || col.status === 'deleted') return;
  const key = getOriginalKey(col);
  const original = originalColumns.value[key];
  if (!original) {
    col.status = 'modified';
    return;
  }
  col.status = JSON.stringify(toComparable(col)) === JSON.stringify(original) ? 'original' : 'modified';
};

// 获取表结构
const loadStructure = async () => {
  try {
    if (!props.tableName) {
      return;
    }
    await loadConnectionType();
    
    const tableStruct = await DbmApi.getTableStruct(
      props.connectionId,
      props.databaseName,
      props.tableName,
      props.schemaName
    );
    const loadedColumns = tableStruct.columns.map(col => ({
      ...col, 
      status: 'original', 
      isEditing: false,
      original_name: col.name,  // 记录原始字段名
      column_comment: col.column_comment || '', // 初始化字段备注
      // 规范化数据类型
      data_type: normalizeDataType(col.data_type),
      // 保留后端返回值，避免把有效默认值误覆盖
      default_value: col.default_value
    }));
    columns.value = loadedColumns;
    originalColumns.value = Object.fromEntries(
      loadedColumns.map(col => [getOriginalKey(col), toComparable(col)])
    );
    
    // 设置表备注
    tableComment.value = tableStruct.comment || '';
    originalTableComment.value = tableStruct.comment || '';
    isCommentModified.value = false;
    
    // 设置索引数据
    indexes.value = tableStruct.indexes || [];
    
    // 加载建表语句
    loadCreateStatement();
  } catch (error) {
    console.error('加载表结构失败:', error);
    ElMessage.error(t('messages.loadStructureFailed', { error: parseErrorMessage(error) }));
  }
};

// 加载建表语句
const loadCreateStatement = async () => {
  try {
    const statement = await DbmApi.getCreateTableStatement(
      props.connectionId, 
      props.databaseName, 
      props.tableName,
      props.schemaName
    );
    createStatement.value = statement || t('createStatement.unavailable');
  } catch (error) {
    console.error('加载建表语句失败:', error);
    createStatement.value = t('createStatement.unavailable');
  }
};

// 添加新字段
const addColumn = () => {
  columns.value.push(createEmptyColumn());
};

// 移除字段（仅从列表移除新增的字段）
const removeColumn = (index: number) => {
  if (columns.value[index].status === 'added') {
    columns.value.splice(index, 1);
  } else {
    // 对于已存在的字段，标记为删除
    columns.value[index].status = 'deleted';
  }
};

// 标记字段为删除
const markForDeletion = (index: number) => {
  ElMessageBox.confirm(
    t('messages.confirmDeleteColumn', { name: columns.value[index].name }),
    t('messages.warningTitle'),
    {
      confirmButtonText: t('actions.confirm'),
      cancelButtonText: t('actions.cancel'),
      type: 'warning'
    }
  ).then(() => {
    columns.value[index].status = 'deleted';
  }).catch(() => {
    // 用户取消操作
  });
};

// 取消删除标记
const cancelDeletion = (index: number) => {
  columns.value[index].status = 'original';
};

// 重置更改
const resetChanges = () => {
  if (isCreateMode.value) {
    tableNameDraft.value = '';
    columns.value = [createEmptyColumn()];
    originalColumns.value = {};
    indexes.value = [];
    tableComment.value = '';
    originalTableComment.value = '';
    isCommentModified.value = false;
    createStatement.value = '';
    return;
  }
  loadStructure();
};

// 标记表备注为已修改
const markCommentAsModified = () => {
  isCommentModified.value = tableComment.value !== originalTableComment.value;
};

// 保存更改
const saveChanges = async () => {
  if (isCreateMode.value) {
    await createTable();
    return;
  }

  try {
    // 分离不同的操作
    const addedCols = columns.value.filter(col => col.status === 'added');
    const modifiedCols = columns.value.filter(col => col.status === 'modified');
    const deletedCols = columns.value.filter(col => col.status === 'deleted');

    // 检查是否有表备注修改
    const isTableCommentChanged = isCommentModified.value;

    // 提示用户即将执行的操作
    let operations = [];
    if (addedCols.length > 0) operations.push(t('messages.operationAddColumns', { count: addedCols.length }));
    if (modifiedCols.length > 0) operations.push(t('messages.operationModifyColumns', { count: modifiedCols.length }));
    if (deletedCols.length > 0) operations.push(t('messages.operationDeleteColumns', { count: deletedCols.length }));
    if (isTableCommentChanged) operations.push(t('messages.operationUpdateComment'));

    if (operations.length === 0) {
      ElMessage.info(t('messages.noChanges'));
      return;
    }

    const confirmMsg = t('messages.confirmOperations', { operations: operations.join(', ') });
    
    await ElMessageBox.confirm(confirmMsg, t('messages.confirmTitle'), {
      confirmButtonText: t('actions.confirm'),
      cancelButtonText: t('actions.cancel'),
      type: 'warning'
    });

    // 如果表备注被修改，则更新表备注
    if (isTableCommentChanged) {
      await DbmApi.updateTableComment(
        props.connectionId,
        props.databaseName,
        props.tableName,
        tableComment.value,
        props.schemaName
      );
      ElMessage.success(t('messages.tableCommentUpdated'));
    }

    // 执行数据库操作
    for (const col of addedCols) {
      if (!col.name.trim()) {
        ElMessage.error(t('messages.columnNameRequired'));
        continue;
      }
      await DbmApi.addColumn(props.connectionId, props.databaseName, props.tableName, {
        name: col.name,
        data_type: col.data_type,
        is_nullable: col.is_nullable,
        default_value: col.default_value,
        character_maximum_length: col.character_maximum_length,
        is_primary_key: col.is_primary_key,
        column_comment: col.column_comment // 传递字段备注
      }, props.schemaName);
      ElMessage.success(t('messages.columnAdded', { name: col.name }));
    }

    for (const col of modifiedCols) {
      await DbmApi.modifyColumn(props.connectionId, props.databaseName, props.tableName, {
        name: col.name,
        data_type: col.data_type,
        is_nullable: col.is_nullable,
        default_value: col.default_value,
        character_maximum_length: col.character_maximum_length,
        is_primary_key: col.is_primary_key,
        column_comment: col.column_comment, // 传递字段备注
        old_name: col.original_name  // 确保始终传递原始字段名
      }, props.schemaName);
      ElMessage.success(t('messages.columnModified', { name: col.name }));
    }

    for (const col of deletedCols) {
      await DbmApi.deleteColumn(
        props.connectionId,
        props.databaseName,
        props.tableName,
        col.name,
        props.schemaName
      );
      ElMessage.success(t('messages.columnDeleted', { name: col.name }));
    }

    await loadStructure();
    ElMessage.success(t('messages.saveSuccess'));
  } catch (error) {
    if (error !== 'cancel') { // 用户取消操作时不显示错误
      console.error('保存更改失败:', error);
      ElMessage.error(t('messages.saveFailed', { error: parseErrorMessage(error) }));
    }
  }
};

const createTable = async () => {
  const nextTableName = tableNameDraft.value.trim();
  if (!nextTableName) {
    ElMessage.error(t('messages.tableNameRequired'));
    return;
  }

  const activeColumns = columns.value.filter((col) => col.status !== 'deleted');
  if (!activeColumns.length) {
    ElMessage.error(t('messages.atLeastOneColumn'));
    return;
  }

  const invalidColumn = activeColumns.find((col) => !col.name.trim());
  if (invalidColumn) {
    ElMessage.error(t('messages.columnNameRequired'));
    return;
  }

  const payloadColumns: ColumnModifySchema[] = activeColumns.map((col) => ({
    name: col.name.trim(),
    data_type: col.data_type,
    is_nullable: col.is_nullable,
    default_value: col.default_value,
    character_maximum_length: col.character_maximum_length,
    is_primary_key: col.is_primary_key,
    column_comment: col.column_comment
  }));

  try {
    await ElMessageBox.confirm(
      t('messages.confirmCreateTable', {
        databaseName: props.databaseName,
        schemaName: props.schemaName ? `.${props.schemaName}` : '',
        tableName: nextTableName
      }),
      t('messages.confirmTitle'),
      {
        confirmButtonText: t('actions.confirm'),
        cancelButtonText: t('actions.cancel'),
        type: 'warning'
      }
    );

    await DbmApi.createTable(
      props.connectionId,
      props.databaseName,
      nextTableName,
      payloadColumns,
      props.schemaName
    );

    if (tableComment.value.trim()) {
      await DbmApi.updateTableComment(
        props.connectionId,
        props.databaseName,
        nextTableName,
        tableComment.value,
        props.schemaName
      );
    }

    ElMessage.success(t('messages.tableCreated', { name: nextTableName }));
    emit('created-table', {
      connectionId: props.connectionId,
      databaseName: props.databaseName,
      schemaName: props.schemaName,
      tableName: nextTableName
    });
  } catch (error) {
    if (error !== 'cancel') {
      console.error('创建表失败:', error);
      ElMessage.error(t('messages.createTableFailed', { error: parseErrorMessage(error) }));
    }
  }
};

// 检查字段是否正在编辑
const isEditing = (row: ExtendedColumn) => {
  // 只有新增的字段和未被标记为删除的原始字段可以编辑
  return row.status === 'added' || row.status === 'original' || row.status === 'modified';
};

// 根据状态返回行的CSS类
const getRowClass = (row: ExtendedColumn) => {
  if (row.status === 'added') {
    return 'row-added';
  } else if (row.status === 'modified') {
    return 'row-modified';
  } else if (row.status === 'deleted') {
    return 'row-deleted';
  }
  return '';
};

// 规范化数据类型，确保正确显示在下拉框中
const normalizeDataType = (dataType: string): string => {
  if (!dataType) return dataType;
  
  // 转换为大写，便于匹配
  const upperType = dataType.toUpperCase();
  
  // 根据当前数据库类型获取有效的数据类型选项
  const normalizedType = currentDbType.value === 'kingbasees'
    ? 'postgresql'
    : currentDbType.value === 'dameng'
      ? 'oracle'
      : currentDbType.value;
  const validTypes = dbTypeOptionsMap[normalizedType]?.map(opt => opt.value) || dbTypeOptionsMap.mysql.map(opt => opt.value);
  
  // 如果当前类型存在于有效类型列表中，返回选项的标准值
  const exactType = validTypes.find(validType => validType.toUpperCase() === upperType);
  if (exactType) {
    return exactType;
  }
  
  // 如果不在当前数据库的有效类型中，尝试映射到最接近的类型
  const typeMappings: Record<string, string> = {
    // MySQL类型映射
    'VARCHAR': 'VARCHAR',
    'CHAR': 'CHAR',
    'TINYTEXT': 'TINYTEXT',
    'TEXT': 'TEXT',
    'MEDIUMTEXT': 'MEDIUMTEXT',
    'LONGTEXT': 'LONGTEXT',
    'INT': 'INT',
    'INTEGER': 'INTEGER',
    'SMALLINT': 'SMALLINT',
    'TINYINT': 'TINYINT',
    'MEDIUMINT': 'MEDIUMINT',
    'BIGINT': 'BIGINT',
    'DECIMAL': 'DECIMAL',
    'NUMERIC': 'NUMERIC',
    'FLOAT': 'FLOAT',
    'DOUBLE': 'DOUBLE',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'DATETIME': 'DATETIME',
    'TIMESTAMP': 'TIMESTAMP',
    'YEAR': 'YEAR',
    'BOOLEAN': 'BOOLEAN',
    'BOOL': 'BOOL',
    'BIT': 'BIT',
    
    // PostgreSQL类型
    'BIGSERIAL': 'BIGSERIAL',
    'BYTEA': 'BYTEA',
    'CIDR': 'CIDR',
    'INET': 'INET',
    'INTERVAL': 'INTERVAL',
    'JSON': 'JSON',
    'JSONB': 'JSONB',
    'SERIAL': 'SERIAL',
    'UUID': 'UUID',
    'XML': 'XML',
    'BIGINT[]': 'BIGINT',  // 数组类型
    'INTEGER[]': 'INTEGER',
    'TEXT[]': 'TEXT',
    
    // SQLite类型
    'REAL': 'REAL',
    'BLOB': 'BLOB',
    'NONE': 'NONE',
    
    // 映射小写或其他变体到标准类型
    'VARBINARY': 'VARCHAR',
    'NVARCHAR': 'VARCHAR',
    'NCHAR': 'CHAR',
    'LONG VARCHAR': 'TEXT',
    'MEDIUMBLOB': 'BLOB',
    'LONGBLOB': 'BLOB',
    'UNSIGNED BIG INT': 'BIGINT',
    'UNSIGNED INT': 'INT',
    'UNSIGNED SMALLINT': 'SMALLINT',
    'UNSIGNED TINYINT': 'TINYINT',
  };

  // 如果直接映射存在，返回映射值
  if (typeMappings[upperType]) {
    const mappedType = typeMappings[upperType];
    // 检查映射后的类型是否在当前数据库支持的类型中
    if (validTypes.some(validType => validType.toUpperCase() === mappedType.toUpperCase())) {
      return validTypes.find(validType => validType.toUpperCase() === mappedType.toUpperCase()) || mappedType;
    }
  }

  // 检查是否包含特定类型关键词
  for (const [key, value] of Object.entries(typeMappings)) {
    if (upperType.includes(key) && validTypes.some(validType => validType.toUpperCase() === value.toUpperCase())) {
      return validTypes.find(validType => validType.toUpperCase() === value.toUpperCase()) || value;
    }
  }

  // 如果没有匹配项，返回原始值的大写形式（如果在有效类型中）
  const sameType = validTypes.find(validType => validType.toUpperCase() === upperType);
  if (sameType) {
    return sameType;
  }

  // 最后，返回当前数据库的第一个类型作为兜底
  return validTypes[0] || dataType;
};

// 添加一个函数来标记列为已修改
const markAsModified = (rowIndex: number, field: keyof ExtendedColumn, newValue: any) => {
  const col = columns.value[rowIndex];
  if (!col) return;
  syncRowStatusWithOriginal(col);
};

// 选择默认值
const selectDefaultValue = (value: string, row: ExtendedColumn, rowIndex: number) => {
  row.default_value = value;
  markAsModified(rowIndex, 'default_value', value);
};

// 打开添加索引对话框
const openAddIndexDialog = () => {
  // 重置表单
  newIndexForm.value = {
    name: '',
    selectedColumns: [],
    is_unique: false
  };
  showAddIndexDialog.value = true;
};

// 确认添加索引
const confirmAddIndex = async () => {
  if (!newIndexForm.value.name.trim()) {
    ElMessage.error(t('messages.indexNameRequired'));
    return;
  }
  
  if (newIndexForm.value.selectedColumns.length === 0) {
    ElMessage.error(t('messages.indexFieldsRequired'));
    return;
  }
  
  try {
    // 创建索引
    await DbmApi.createIndex(
      props.connectionId,
      props.databaseName,
      props.tableName,
      newIndexForm.value.name,
      newIndexForm.value.selectedColumns,
      newIndexForm.value.is_unique,
      props.schemaName
    );
    
    ElMessage.success(t('messages.indexCreated'));
    showAddIndexDialog.value = false;
    
    // 重新加载结构
    await loadStructure();
  } catch (error) {
    console.error('创建索引失败:', error);
    ElMessage.error(t('messages.createIndexFailed', { error: parseErrorMessage(error) }));
  }
};

// 删除索引
const deleteIndex = async (index: any, indexIdx: number) => {
  try {
    await ElMessageBox.confirm(
      t('messages.confirmDeleteIndex', { name: index.name }),
      t('messages.warningTitle'),
      {
        confirmButtonText: t('actions.confirm'),
        cancelButtonText: t('actions.cancel'),
        type: 'warning'
      }
    );
    
    // 删除索引
    await DbmApi.dropIndex(
      props.connectionId,
      props.databaseName,
      props.tableName,
      index.name,
      props.schemaName
    );
    
    ElMessage.success(t('messages.indexDeleted'));
    
    // 重新加载结构
    await loadStructure();
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除索引失败:', error);
      ElMessage.error(t('messages.deleteIndexFailed', { error: parseErrorMessage(error) }));
    }
  }
};

onMounted(() => {
  if (isCreateMode.value) {
    void loadConnectionType().then(() => {
      resetChanges();
    });
    return;
  }

  loadStructure();
});
</script>

<style scoped lang="scss">
.table-struct {
  .table-name-section {
    .table-name-label {
      margin-bottom: 8px;
      font-weight: bold;
    }
  }

  .table-comment-section {
    margin-bottom: 20px;
    
    h4 {
      margin-bottom: 8px;
      font-weight: bold;
    }
  }

  .create-statement-section {
    
    h4 {
      margin-bottom: 8px;
      font-weight: bold;
    }
  }

  .struct-table-container {
    .row-added {
      :deep(.el-input__wrapper),
      :deep(.el-select),
      :deep(.el-checkbox__input),
      :deep(.el-input-number) {
        background-color: rgba(144, 238, 144, 0.3) !important; // 浅绿色
      }
    }

    .row-modified {
      :deep(.el-input__wrapper),
      :deep(.el-select),
      :deep(.el-checkbox__input),
      :deep(.el-input-number) {
        background-color: rgba(255, 255, 0, 0.3) !important; // 浅黄色
      }
    }

    .row-deleted {
      :deep(.el-input__wrapper),
      :deep(.el-select),
      :deep(.checkbox__input),
      :deep(.el-input-number) {
        background-color: rgba(255, 182, 193, 0.3) !important; // 浅红色
        text-decoration: line-through;
      }
    }
  }
}
</style>
