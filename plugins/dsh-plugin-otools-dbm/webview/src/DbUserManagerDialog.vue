<template>
  <el-dialog
    v-if="modelValue"
    :model-value="modelValue"
    :title="t('title')"
    width="920px"
    @close="emit('update:modelValue', false)"
  >
    <div v-if="!connection || !canManageUsers" class="empty-holder">
      <el-empty :description="t('empty.unsupported')" />
    </div>

    <template v-else>
      <div class="user-toolbar">
        <el-button size="small" type="primary" @click="openCreateDialog">{{ t('toolbar.create') }}</el-button>
        <el-button size="small" @click="loadUsers">{{ t('toolbar.refreshList') }}</el-button>
        <el-button v-if="isMysql" size="small" :loading="flushing" @click="flushPrivileges">{{ t('toolbar.flushPrivileges') }}</el-button>
      </div>

      <el-table :data="users" border height="440" size="small" v-loading="loading">
        <el-table-column prop="username" :label="t('columns.username')" min-width="150" show-overflow-tooltip />
        <el-table-column v-if="isMysql" prop="host" :label="t('columns.host')" min-width="150" show-overflow-tooltip />
        <el-table-column :label="t('columns.grantedDatabases')" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="table-text">{{ row.databases.length ? row.databases.join(', ') : t('mode.none') }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('columns.privileges')" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="privilege-cell" :title="row.privilegeTooltip">
              <el-tag size="small" :type="getPrivilegeTagType(row.privilegeMode)">
                {{ getPrivilegeModeLabel(row.privilegeMode) }}
              </el-tag>
              <span class="table-text privilege-summary">{{ row.privilegeSummary }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('columns.actions')" width="250">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button size="small" @click="openGrantDialog(row)">{{ t('buttons.grantSettings') }}</el-button>
              <el-button size="small" @click="openPasswordDialog(row)">{{ t('buttons.changePassword') }}</el-button>
              <el-button size="small" type="danger" @click="removeUser(row)">{{ t('buttons.delete') }}</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </el-dialog>

  <el-dialog
    v-if="createDialogVisible"
    :model-value="createDialogVisible"
    :title="t('createDialog.title')"
    width="560px"
    @close="createDialogVisible = false"
  >
    <el-form :model="createForm" label-width="96px" size="small">
      <el-form-item :label="t('fields.username')">
        <el-input v-model="createForm.username" size="small" />
      </el-form-item>
      <el-form-item v-if="isMysql" :label="t('fields.host')">
        <el-input v-model="createForm.host" size="small" :placeholder="t('createDialog.hostPlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('fields.password')">
        <el-input v-model="createForm.password" size="small" show-password type="password" />
      </el-form-item>
      <el-form-item :label="t('fields.grantDatabases')">
        <el-select
          v-model="createForm.grantDatabases"
          size="small"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          class="w-full"
          :placeholder="t('createDialog.databasePlaceholder')"
        >
          <el-option
            v-for="item in databaseOptions"
            :key="item"
            :label="item"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('fields.privilegeMode')">
        <el-radio-group v-model="createForm.privilegeMode" size="small">
          <el-radio-button label="readonly">{{ t('mode.readonly') }}</el-radio-button>
          <el-radio-button label="readwrite">{{ t('mode.readwrite') }}</el-radio-button>
          <el-radio-button label="custom">{{ t('mode.custom') }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="createForm.privilegeMode === 'custom'" :label="t('fields.customPrivileges')">
        <el-checkbox-group v-model="createForm.customPrivileges" size="small" class="privilege-grid">
          <el-checkbox
            v-for="item in activePrivilegeOptions"
            :key="item"
            :label="item"
          >
            {{ item }}
          </el-checkbox>
        </el-checkbox-group>
      </el-form-item>
      <div class="form-tip">{{ t('createDialog.tip') }}</div>
    </el-form>
    <template #footer>
      <el-button size="small" @click="createDialogVisible = false">{{ t('buttons.cancel') }}</el-button>
      <el-button size="small" type="primary" :loading="submitting" @click="createUser">{{ t('buttons.create') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-if="grantDialogVisible"
    :model-value="grantDialogVisible"
    :title="t('grantDialog.title')"
    width="560px"
    @close="grantDialogVisible = false"
  >
    <el-form :model="grantForm" label-width="96px" size="small">
      <el-form-item :label="t('fields.account')">
        <el-input :model-value="grantTargetLabel" size="small" disabled />
      </el-form-item>
      <el-form-item :label="t('fields.grantDatabases')">
        <el-select
          v-model="grantForm.grantDatabases"
          size="small"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          class="w-full"
          :placeholder="t('grantDialog.databasePlaceholder')"
        >
          <el-option
            v-for="item in databaseOptions"
            :key="item"
            :label="item"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('fields.privilegeMode')">
        <el-radio-group v-model="grantForm.privilegeMode" size="small">
          <el-radio-button label="readonly">{{ t('mode.readonly') }}</el-radio-button>
          <el-radio-button label="readwrite">{{ t('mode.readwrite') }}</el-radio-button>
          <el-radio-button label="custom">{{ t('mode.custom') }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="grantForm.privilegeMode === 'custom'" :label="t('fields.customPrivileges')">
        <el-checkbox-group v-model="grantForm.customPrivileges" size="small" class="privilege-grid">
          <el-checkbox
            v-for="item in activePrivilegeOptions"
            :key="item"
            :label="item"
          >
            {{ item }}
          </el-checkbox>
        </el-checkbox-group>
      </el-form-item>
      <div class="form-tip">{{ t('grantDialog.tip') }}</div>
    </el-form>
    <template #footer>
      <el-button size="small" @click="grantDialogVisible = false">{{ t('buttons.cancel') }}</el-button>
      <el-button size="small" type="primary" :loading="submitting" @click="saveGrantSettings">{{ t('buttons.save') }}</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-if="passwordDialogVisible"
    :model-value="passwordDialogVisible"
    :title="t('passwordDialog.title')"
    width="420px"
    @close="passwordDialogVisible = false"
  >
    <el-form :model="passwordForm" label-width="96px" size="small">
      <el-form-item :label="t('fields.account')">
        <el-input :model-value="passwordTargetLabel" size="small" disabled />
      </el-form-item>
      <el-form-item :label="t('passwordDialog.newPassword')">
        <el-input v-model="passwordForm.password" size="small" show-password type="password" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button size="small" @click="passwordDialogVisible = false">{{ t('buttons.cancel') }}</el-button>
      <el-button size="small" type="primary" :loading="submitting" @click="updatePassword">{{ t('buttons.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { DbmApi, type DbConnection } from './service';
import { useI18nScope } from '@/platform/i18n';

type PrivilegeMode = 'readonly' | 'readwrite' | 'custom';
type PrivilegeModeSummary = PrivilegeMode | 'none';

interface DbUserRow {
  username: string;
  host: string;
  databases: string[];
  databasePrivileges: Record<string, string[]>;
  privilegeMode: PrivilegeModeSummary;
  privilegeSummary: string;
  privilegeTooltip: string;
}

interface GrantDialogTarget {
  username: string;
  host: string;
  previousDatabases: string[];
}

const READONLY_PRIVILEGES = ['SELECT', 'SHOW VIEW'];
const STANDARD_READONLY_PRIVILEGES = ['SELECT'];
const STANDARD_WRITE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const CUSTOM_PRIVILEGE_OPTIONS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'EXECUTE',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER',
  'REFERENCES'
];
const WRITE_PRIVILEGE_HINTS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'EXECUTE',
  'TRIGGER',
  'REFERENCES'
]);

const props = defineProps<{
  modelValue: boolean;
  connection: DbConnection | null;
  databaseName?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
const { t } = useI18nScope('dbm.userManager');

const normalizedDbType = computed(() => props.connection?.db_type?.toLowerCase() || '');
const isMysql = computed(() => ['mysql', 'mariadb'].includes(normalizedDbType.value));
const isPostgresFamily = computed(() => ['postgresql', 'kingbasees'].includes(normalizedDbType.value));
const isSqlServer = computed(() => normalizedDbType.value === 'sqlserver');
const isOracle = computed(() => normalizedDbType.value === 'oracle');
const isOracleFamily = computed(() => ['oracle', 'dameng'].includes(normalizedDbType.value));
const canManageUsers = computed(() =>
  ['mysql', 'mariadb', 'postgresql', 'kingbasees', 'sqlserver', 'oracle', 'dameng'].includes(normalizedDbType.value)
);
const defaultCustomPrivileges = computed(() =>
  isMysql.value ? READONLY_PRIVILEGES : STANDARD_READONLY_PRIVILEGES
);
const activePrivilegeOptions = computed(() => {
  if (isMysql.value) {
    return CUSTOM_PRIVILEGE_OPTIONS;
  }
  if (isPostgresFamily.value || isSqlServer.value || isOracleFamily.value) {
    return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'EXECUTE'];
  }
  return STANDARD_WRITE_PRIVILEGES;
});

const users = ref<DbUserRow[]>([]);
const availableDatabases = ref<string[]>([]);
const loading = ref(false);
const submitting = ref(false);
const flushing = ref(false);
const createDialogVisible = ref(false);
const grantDialogVisible = ref(false);
const passwordDialogVisible = ref(false);
const passwordTarget = ref<DbUserRow | null>(null);
const grantTarget = ref<GrantDialogTarget | null>(null);

const createForm = reactive({
  username: '',
  host: '%',
  password: '',
  grantDatabases: [] as string[],
  privilegeMode: 'readonly' as PrivilegeMode,
  customPrivileges: [...READONLY_PRIVILEGES]
});

const grantForm = reactive({
  username: '',
  host: '',
  grantDatabases: [] as string[],
  privilegeMode: 'readonly' as PrivilegeMode,
  customPrivileges: [...READONLY_PRIVILEGES]
});

const passwordForm = reactive({
  password: ''
});

const passwordTargetLabel = computed(() =>
  passwordTarget.value ? getAccountDisplay(passwordTarget.value.username, passwordTarget.value.host) : ''
);

const grantTargetLabel = computed(() =>
  grantTarget.value ? getAccountDisplay(grantTarget.value.username, grantTarget.value.host) : ''
);

const databaseOptions = computed(() => {
  const values = new Set(availableDatabases.value);
  if (props.databaseName) {
    values.add(props.databaseName);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
});

const escapeSqlString = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const escapeSqlLiteral = (value: string) => value.replace(/'/g, "''");
const escapeIdentifier = (value: string) => value.replace(/`/g, '``');
const quotePgIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteSqlServerIdentifier = (value: string) => `[${value.replace(/\]/g, ']]')}]`;
const quoteOracleIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

const getUserKey = (username: string, host: string) => `${username}@${host}`;
const getAccountDisplay = (username: string, host: string) =>
  isMysql.value ? `${username}@${host}` : username;

const normalizeStringList = (values: string[]) =>
  Array.from(new Set(values.map((item) => item.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

const normalizePrivileges = (values: string[]) =>
  Array.from(new Set(values.map((item) => item.trim().toUpperCase()).filter(Boolean)));

const resolveCustomPrivileges = (databasePrivileges: Record<string, string[]>) =>
  normalizePrivileges(Object.values(databasePrivileges).flat()).filter((item) => activePrivilegeOptions.value.includes(item));

const isReadonlyPrivilegeSet = (privileges: string[]) =>
  privileges.length > 0 && privileges.every((item) => (isMysql.value ? READONLY_PRIVILEGES : STANDARD_READONLY_PRIVILEGES).includes(item));

const resolvePrivilegeMode = (databasePrivileges: Record<string, string[]>): PrivilegeModeSummary => {
  const privilegeSets = Object.values(databasePrivileges).map((item) => normalizePrivileges(item));
  if (privilegeSets.length === 0) {
    return 'none';
  }

  if (privilegeSets.every((item) => isReadonlyPrivilegeSet(item))) {
    return 'readonly';
  }

  const unionPrivileges = normalizePrivileges(privilegeSets.flat());
  if (unionPrivileges.some((item) => WRITE_PRIVILEGE_HINTS.has(item))) {
    return 'readwrite';
  }

  return 'custom';
};

const getPrivilegeModeLabel = (mode: PrivilegeModeSummary) => {
  const labels: Record<PrivilegeModeSummary, string> = {
    none: t('mode.none'),
    readonly: t('mode.readonly'),
    readwrite: t('mode.readwrite'),
    custom: t('mode.custom')
  };
  return labels[mode];
};

const getPrivilegeTagType = (mode: PrivilegeModeSummary) => {
  const types: Record<PrivilegeModeSummary, 'info' | 'success' | 'warning'> = {
    none: 'info',
    readonly: 'success',
    readwrite: 'warning',
    custom: 'warning'
  };
  return types[mode];
};

const buildPrivilegeSummary = (databasePrivileges: Record<string, string[]>, mode: PrivilegeModeSummary) => {
  const databaseCount = Object.keys(databasePrivileges).length;
  if (databaseCount === 0) {
    return t('summary.none');
  }
  if (mode === 'readonly') {
    return t('summary.readonly', { count: databaseCount });
  }
  if (mode === 'readwrite') {
    return t('summary.readwrite', { count: databaseCount });
  }
  const unionPrivileges = normalizePrivileges(Object.values(databasePrivileges).flat());
  return unionPrivileges.length ? unionPrivileges.join(', ') : t('summary.custom');
};

const buildPrivilegeTooltip = (databasePrivileges: Record<string, string[]>) => {
  const entries = Object.entries(databasePrivileges)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([databaseName, privileges]) => `${databaseName}: ${normalizePrivileges(privileges).join(', ')}`);
  return entries.join('\n');
};

const getPrivilegeSql = (mode: PrivilegeMode, customPrivileges: string[]) => {
  if (mode === 'readonly') {
    return (isMysql.value ? READONLY_PRIVILEGES : STANDARD_READONLY_PRIVILEGES).join(', ');
  }
  if (mode === 'readwrite') {
    return isMysql.value ? 'ALL PRIVILEGES' : STANDARD_WRITE_PRIVILEGES.join(', ');
  }
  const privileges = normalizePrivileges(customPrivileges);
  if (!privileges.length) {
    throw new Error(t('validation.customPrivilegeRequired'));
  }
  return privileges.join(', ');
};

const getOraclePasswordSql = (password: string) => {
  if (/^[A-Za-z][A-Za-z0-9_$#]*$/.test(password)) {
    return password;
  }
  return `"${password.replace(/"/g, '""')}"`;
};

const isOracleTableLikeObject = (objectType: string) =>
  ['TABLE', 'VIEW'].includes(objectType.toUpperCase());

const isOracleTableOnlyObject = (objectType: string) =>
  objectType.toUpperCase() === 'TABLE';

const isOracleExecutableObject = (objectType: string) =>
  ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE'].includes(objectType.toUpperCase());

const executeSqlBatch = async (sqls: string[], databaseName = props.databaseName) => {
  if (!props.connection) {
    return;
  }
  for (const sql of sqls.filter((item) => item.trim())) {
    await DbmApi.executeQuery(props.connection.id, sql, databaseName);
  }
};

const getOracleObjectRows = async (schemaName: string) => {
  if (!props.connection) {
    return [] as Array<{ name: string; type: string }>;
  }

  const result = await DbmApi.executeQuery(
    props.connection.id,
    [
      'SELECT OBJECT_NAME, OBJECT_TYPE',
      'FROM ALL_OBJECTS',
      `WHERE OWNER = '${escapeSqlLiteral(schemaName)}'`,
      "  AND OBJECT_TYPE IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE')",
      'ORDER BY OBJECT_TYPE, OBJECT_NAME'
    ].join('\n'),
    props.databaseName
  ).catch(() => ({ rows: [] as unknown[][] }));

  return (result.rows as unknown[][])
    .map((row) => ({
      name: String(row[0] || ''),
      type: String(row[1] || '')
    }))
    .filter((item) => item.name && item.type);
};

const getOracleGrantedPrivileges = async (username: string, schemaName: string) => {
  if (!props.connection) {
    return [] as Array<{ objectName: string; privilege: string }>;
  }

  const result = await DbmApi.executeQuery(
    props.connection.id,
    [
      'SELECT TABLE_NAME, PRIVILEGE',
      'FROM ALL_TAB_PRIVS',
      `WHERE GRANTEE = '${escapeSqlLiteral(username)}'`,
      `  AND OWNER = '${escapeSqlLiteral(schemaName)}'`,
      'ORDER BY TABLE_NAME, PRIVILEGE'
    ].join('\n'),
    props.databaseName
  ).catch(() => ({ rows: [] as unknown[][] }));

  return (result.rows as unknown[][])
    .map((row) => ({
      objectName: String(row[0] || ''),
      privilege: String(row[1] || '').toUpperCase()
    }))
    .filter((item) => item.objectName && item.privilege);
};

const revokeOracleSchemaGrants = async (username: string, schemaName: string) => {
  const userName = quoteOracleIdentifier(username);
  const grantedPrivileges = await getOracleGrantedPrivileges(username, schemaName);
  const privilegesByObject = new Map<string, string[]>();

  grantedPrivileges.forEach(({ objectName, privilege }) => {
    const values = privilegesByObject.get(objectName) || [];
    privilegesByObject.set(objectName, normalizePrivileges([...values, privilege]));
  });

  const sqls = Array.from(privilegesByObject.entries()).map(([objectName, privileges]) =>
    `REVOKE ${privileges.join(', ')} ON ${quoteOracleIdentifier(schemaName)}.${quoteOracleIdentifier(objectName)} FROM ${userName}`
  );
  await executeSqlBatch(sqls);
};

const getOracleObjectPrivilegeSelection = (mode: PrivilegeMode, customPrivileges: string[]) => {
  const selected = mode === 'readonly'
    ? ['SELECT']
    : mode === 'readwrite'
      ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      : normalizePrivileges(customPrivileges);

  return {
    tableLike: selected.filter((item) => item === 'SELECT'),
    tableOnly: selected.filter((item) => ['INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALTER'].includes(item)),
    executable: selected.filter((item) => item === 'EXECUTE'),
    system: selected.flatMap((item) => {
      if (item === 'CREATE') {
        return ['CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE', 'CREATE PROCEDURE'];
      }
      if (item === 'DROP') {
        return ['DROP ANY TABLE', 'DROP ANY SEQUENCE', 'DROP ANY PROCEDURE'];
      }
      return [];
    })
  };
};

const grantOracleSchemaPrivileges = async (
  username: string,
  schemaName: string,
  mode: PrivilegeMode,
  customPrivileges: string[]
) => {
  const userName = quoteOracleIdentifier(username);
  const privileges = getOracleObjectPrivilegeSelection(mode, customPrivileges);
  const objectRows = await getOracleObjectRows(schemaName);
  const sqls: string[] = [];

  for (const object of objectRows) {
    const grants = [
      ...(isOracleTableLikeObject(object.type) ? privileges.tableLike : []),
      ...(isOracleTableOnlyObject(object.type) ? privileges.tableOnly : []),
      ...(isOracleExecutableObject(object.type) ? privileges.executable : [])
    ];

    if (grants.length) {
      sqls.push(
        `GRANT ${normalizePrivileges(grants).join(', ')} ON ${quoteOracleIdentifier(schemaName)}.${quoteOracleIdentifier(object.name)} TO ${userName}`
      );
    }
  }

  if (isOracle.value) {
    sqls.unshift(`GRANT CREATE SESSION TO ${userName}`);
  }
  privileges.system.forEach((privilege) => {
    sqls.push(`GRANT ${privilege} TO ${userName}`);
  });

  await executeSqlBatch(sqls);
};

const mapRowsToUsers = (rows: unknown[][], privilegeMap = new Map<string, Record<string, string[]>>) =>
  rows.map((row) => {
    const username = String(row[0] || '');
    const host = String(row[1] || '');
    const databasePrivileges = privilegeMap.get(getUserKey(username, host)) || {};
    const databases = Object.keys(databasePrivileges).sort((a, b) => a.localeCompare(b));
    const privilegeMode = resolvePrivilegeMode(databasePrivileges);

    return {
      username,
      host,
      databases,
      databasePrivileges,
      privilegeMode,
      privilegeSummary: buildPrivilegeSummary(databasePrivileges, privilegeMode),
      privilegeTooltip: buildPrivilegeTooltip(databasePrivileges)
    };
  });

const loadScopeOptions = async () => {
  if (!props.connection) {
    return [];
  }
  if (isMysql.value) {
    return await DbmApi.getDatabases(props.connection.id).catch(() => [] as string[]);
  }
  if (isPostgresFamily.value || isOracleFamily.value) {
    return await DbmApi.getSchemas(props.connection.id, props.databaseName).catch(() => [] as string[]);
  }
  if (isSqlServer.value) {
    return [props.databaseName || props.connection.database || ''].filter(Boolean);
  }
  return [];
};

const getSqlServerDatabaseScope = () => props.databaseName || props.connection?.database || 'database';

const collectPrivilegeMap = (rows: unknown[][]) => {
  const privilegeMap = new Map<string, Record<string, string[]>>();
  rows.forEach((row) => {
    const username = String(row[0] || '');
    const host = String(row[1] || '');
    const databaseName = String(row[2] || '');
    const privilegeType = String(row[3] || '').toUpperCase();

    if (!username || !databaseName || !privilegeType) {
      return;
    }

    const userKey = getUserKey(username, host);
    const currentValue = privilegeMap.get(userKey) || {};
    const databasePrivileges = currentValue[databaseName] || [];
    currentValue[databaseName] = normalizePrivileges([...databasePrivileges, privilegeType]);
    privilegeMap.set(userKey, currentValue);
  });
  return privilegeMap;
};

const loadUsers = async () => {
  if (!props.modelValue || !props.connection || !canManageUsers.value) {
    return;
  }

  loading.value = true;
  try {
    const scopeOptions = await loadScopeOptions();
    availableDatabases.value = normalizeStringList(scopeOptions);

    if (isMysql.value) {
      const [userResult, privilegeResult] = await Promise.all([
        DbmApi.executeQuery(
          props.connection.id,
          "SELECT User AS username, Host AS host FROM mysql.user WHERE User <> '' ORDER BY User, Host"
        ),
        DbmApi.executeQuery(
          props.connection.id,
          [
            'SELECT',
            "  REPLACE(SUBSTRING_INDEX(GRANTEE, '@', 1), '\\'', '') AS username,",
            "  REPLACE(SUBSTRING_INDEX(GRANTEE, '@', -1), '\\'', '') AS host,",
            '  TABLE_SCHEMA AS database_name,',
            '  PRIVILEGE_TYPE AS privilege_type',
            'FROM information_schema.schema_privileges',
            'ORDER BY username, host, TABLE_SCHEMA, PRIVILEGE_TYPE'
          ].join('\n')
        )
      ]);
      users.value = mapRowsToUsers(userResult.rows as unknown[][], collectPrivilegeMap(privilegeResult.rows as unknown[][]));
      return;
    }

    if (isPostgresFamily.value) {
      const [userResult, privilegeResult] = await Promise.all([
        DbmApi.executeQuery(
          props.connection.id,
          "SELECT rolname AS username, '' AS host FROM pg_roles WHERE rolcanlogin = true ORDER BY rolname"
        ),
        DbmApi.executeQuery(
          props.connection.id,
          [
            'SELECT',
            "  grantee AS username,",
            "  '' AS host,",
            '  table_schema AS database_name,',
            '  privilege_type',
            'FROM information_schema.role_table_grants',
            "WHERE grantee <> 'PUBLIC'",
            'ORDER BY grantee, table_schema, privilege_type'
          ].join('\n')
        ).catch(() => ({ rows: [] as unknown[][] }))
      ]);
      users.value = mapRowsToUsers(userResult.rows as unknown[][], collectPrivilegeMap(privilegeResult.rows as unknown[][]));
      return;
    }

    if (isSqlServer.value) {
      const [userResult, roleResult] = await Promise.all([
        DbmApi.executeQuery(
          props.connection.id,
          [
            'SELECT name AS username, \'\' AS host',
            'FROM sys.database_principals',
            "WHERE type IN ('S', 'U')",
            "  AND name NOT IN ('dbo', 'guest', 'INFORMATION_SCHEMA', 'sys')",
            'ORDER BY name'
          ].join('\n')
        ),
        DbmApi.executeQuery(
          props.connection.id,
          [
            'SELECT',
            "  member.name AS username,",
            "  '' AS host,",
            `  '${escapeSqlLiteral(getSqlServerDatabaseScope())}' AS database_name,`,
            '  role.name AS privilege_type',
            'FROM sys.database_role_members drm',
            'JOIN sys.database_principals role ON drm.role_principal_id = role.principal_id',
            'JOIN sys.database_principals member ON drm.member_principal_id = member.principal_id',
            "WHERE role.name IN ('db_datareader', 'db_datawriter', 'db_ddladmin')"
          ].join('\n')
        ).catch(() => ({ rows: [] as unknown[][] }))
      ]);
      const privilegeRows = (roleResult.rows as unknown[][]).flatMap((row) => {
        const roleName = String(row[3] || '');
        const privileges = roleName === 'db_datareader'
          ? ['SELECT']
          : roleName === 'db_datawriter'
            ? ['INSERT', 'UPDATE', 'DELETE']
            : roleName === 'db_ddladmin'
              ? ['CREATE', 'ALTER', 'DROP']
              : [];
        return privileges.map((privilege) => [row[0], row[1], row[2], privilege]);
      });
      users.value = mapRowsToUsers(userResult.rows as unknown[][], collectPrivilegeMap(privilegeRows));
      return;
    }

    const [userResult, privilegeResult] = await Promise.all([
      DbmApi.executeQuery(
        props.connection.id,
        'SELECT USERNAME AS username, \'\' AS host FROM ALL_USERS ORDER BY USERNAME'
      ),
      DbmApi.executeQuery(
        props.connection.id,
        [
          'SELECT',
          "  GRANTEE AS username,",
          "  '' AS host,",
          '  OWNER AS database_name,',
          '  PRIVILEGE AS privilege_type',
          'FROM ALL_TAB_PRIVS',
          'ORDER BY GRANTEE, OWNER, PRIVILEGE'
        ].join('\n')
      ).catch(() => ({ rows: [] as unknown[][] }))
    ]);
    users.value = mapRowsToUsers(userResult.rows as unknown[][], collectPrivilegeMap(privilegeResult.rows as unknown[][]));
  } catch (error) {
    ElMessage.error(`${t('messages.loadUsersFailed')}: ${(error as Error).message}`);
  } finally {
    loading.value = false;
  }
};

watch(
  () => [props.modelValue, props.connection?.id],
  ([visible]) => {
    if (visible) {
      void loadUsers();
    }
  },
  { immediate: true }
);

const openCreateDialog = () => {
  createForm.username = '';
  createForm.host = '%';
  createForm.password = '';
  createForm.grantDatabases = props.databaseName ? [props.databaseName] : [];
  createForm.privilegeMode = 'readonly';
  createForm.customPrivileges = [...defaultCustomPrivileges.value];
  createDialogVisible.value = true;
};

const openGrantDialog = (row: DbUserRow) => {
  const privilegeMode = row.privilegeMode === 'none' ? 'readonly' : row.privilegeMode === 'custom' ? 'custom' : row.privilegeMode;
  grantTarget.value = {
    username: row.username,
    host: row.host,
    previousDatabases: [...row.databases]
  };
  grantForm.username = row.username;
  grantForm.host = row.host;
  grantForm.grantDatabases = [...row.databases];
  grantForm.privilegeMode = privilegeMode;
  grantForm.customPrivileges = resolveCustomPrivileges(row.databasePrivileges).length
    ? resolveCustomPrivileges(row.databasePrivileges)
    : [...defaultCustomPrivileges.value];
  grantDialogVisible.value = true;
};

const flushPrivileges = async (showMessage = true) => {
  if (!props.connection) {
    return;
  }
  if (!isMysql.value) {
    return;
  }

  flushing.value = true;
  try {
    await DbmApi.executeQuery(props.connection.id, 'FLUSH PRIVILEGES');
    if (showMessage) {
      ElMessage.success(t('messages.flushSuccess'));
    }
  } catch (error) {
    ElMessage.error(`${t('messages.flushFailed')}: ${(error as Error).message}`);
    throw error;
  } finally {
    flushing.value = false;
  }
};

const applyDatabaseGrants = async (
  username: string,
  host: string,
  previousDatabases: string[],
  nextDatabases: string[],
  mode: PrivilegeMode,
  customPrivileges: string[]
) => {
  if (!props.connection) {
    return;
  }

  if (isMysql.value) {
    const userSpec = `'${escapeSqlString(username)}'@'${escapeSqlString(host)}'`;
    for (const databaseName of normalizeStringList(previousDatabases)) {
      await DbmApi.executeQuery(
        props.connection.id,
        `REVOKE ALL PRIVILEGES, GRANT OPTION ON \`${escapeIdentifier(databaseName)}\`.* FROM ${userSpec}`
      );
    }

    const databases = normalizeStringList(nextDatabases);
    if (!databases.length) {
      return;
    }

    const privilegeSql = getPrivilegeSql(mode, customPrivileges);
    for (const databaseName of databases) {
      await DbmApi.executeQuery(
        props.connection.id,
        `GRANT ${privilegeSql} ON \`${escapeIdentifier(databaseName)}\`.* TO ${userSpec}`
      );
    }
    return;
  }

  if (isPostgresFamily.value) {
    const userName = quotePgIdentifier(username);
    const schemas = normalizeStringList(nextDatabases);
    const revokeSchemas = normalizeStringList(previousDatabases);
    for (const schemaName of revokeSchemas) {
      await executeSqlBatch([
        `REVOKE ALL PRIVILEGES ON SCHEMA ${quotePgIdentifier(schemaName)} FROM ${userName}`,
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quotePgIdentifier(schemaName)} FROM ${userName}`
      ]);
    }
    for (const schemaName of schemas) {
      const privilegeSql = mode === 'readonly'
        ? ['SELECT']
        : mode === 'readwrite'
          ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
          : normalizePrivileges(customPrivileges).filter((item) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(item));
      const schemaPrivileges = mode === 'readonly'
        ? ['USAGE']
        : mode === 'readwrite'
          ? ['USAGE', 'CREATE']
          : normalizePrivileges(customPrivileges).filter((item) => ['USAGE', 'CREATE'].includes(item));
      await executeSqlBatch([
        ...schemaPrivileges.map((item) => `GRANT ${item} ON SCHEMA ${quotePgIdentifier(schemaName)} TO ${userName}`),
        ...privilegeSql.map((item) => `GRANT ${item} ON ALL TABLES IN SCHEMA ${quotePgIdentifier(schemaName)} TO ${userName}`)
      ]);
    }
    return;
  }

  if (isSqlServer.value) {
    const userName = quoteSqlServerIdentifier(username);
    await executeSqlBatch([
      `IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${escapeSqlLiteral(username)}') BEGIN
  IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE member_principal_id = DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(username)}') AND role_principal_id = DATABASE_PRINCIPAL_ID(N'db_datareader'))
    ALTER ROLE db_datareader DROP MEMBER ${userName};
  IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE member_principal_id = DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(username)}') AND role_principal_id = DATABASE_PRINCIPAL_ID(N'db_datawriter'))
    ALTER ROLE db_datawriter DROP MEMBER ${userName};
  IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE member_principal_id = DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(username)}') AND role_principal_id = DATABASE_PRINCIPAL_ID(N'db_ddladmin'))
    ALTER ROLE db_ddladmin DROP MEMBER ${userName};
END`
    ]);
    if (mode === 'readonly') {
      await executeSqlBatch([`ALTER ROLE db_datareader ADD MEMBER ${userName}`]);
      return;
    }
    if (mode === 'readwrite') {
      await executeSqlBatch([
        `ALTER ROLE db_datareader ADD MEMBER ${userName}`,
        `ALTER ROLE db_datawriter ADD MEMBER ${userName}`
      ]);
      return;
    }
    if (normalizePrivileges(customPrivileges).includes('CREATE') || normalizePrivileges(customPrivileges).includes('ALTER') || normalizePrivileges(customPrivileges).includes('DROP')) {
      await executeSqlBatch([`ALTER ROLE db_ddladmin ADD MEMBER ${userName}`]);
    }
    if (normalizePrivileges(customPrivileges).includes('SELECT')) {
      await executeSqlBatch([`ALTER ROLE db_datareader ADD MEMBER ${userName}`]);
    }
    if (normalizePrivileges(customPrivileges).some((item) => ['INSERT', 'UPDATE', 'DELETE'].includes(item))) {
      await executeSqlBatch([`ALTER ROLE db_datawriter ADD MEMBER ${userName}`]);
    }
    return;
  }

  for (const schemaName of normalizeStringList(previousDatabases)) {
    await revokeOracleSchemaGrants(username, schemaName);
  }
  for (const schemaName of normalizeStringList(nextDatabases)) {
    await grantOracleSchemaPrivileges(username, schemaName, mode, customPrivileges);
  }
};

const createUser = async () => {
  if (!props.connection) {
    return;
  }

  const username = createForm.username.trim();
  const host = createForm.host.trim() || '%';
  const password = createForm.password.trim();

  if (!username || !password) {
    ElMessage.warning(t('validation.usernamePasswordRequired'));
    return;
  }

  submitting.value = true;
  try {
    if (isMysql.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `CREATE USER IF NOT EXISTS '${escapeSqlString(username)}'@'${escapeSqlString(host)}' IDENTIFIED BY '${escapeSqlString(password)}'`
      );
    } else if (isPostgresFamily.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `CREATE USER ${quotePgIdentifier(username)} WITH PASSWORD '${escapeSqlLiteral(password)}'`
      );
    } else if (isSqlServer.value) {
      await executeSqlBatch([
        `IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${escapeSqlLiteral(username)}')
CREATE LOGIN ${quoteSqlServerIdentifier(username)} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`,
        `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${escapeSqlLiteral(username)}')
CREATE USER ${quoteSqlServerIdentifier(username)} FOR LOGIN ${quoteSqlServerIdentifier(username)}`
      ]);
    } else {
      await DbmApi.executeQuery(
        props.connection.id,
        `CREATE USER ${quoteOracleIdentifier(username)} IDENTIFIED BY ${getOraclePasswordSql(password)}`
      );
    }
    await applyDatabaseGrants(
      username,
      host,
      [],
      createForm.grantDatabases,
      createForm.privilegeMode,
      createForm.customPrivileges
    );
    await flushPrivileges(false);
    createDialogVisible.value = false;
    await loadUsers();
    ElMessage.success(t('messages.createSuccess'));
  } catch (error) {
    ElMessage.error(`${t('messages.createFailed')}: ${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
};

const saveGrantSettings = async () => {
  if (!props.connection || !grantTarget.value) {
    return;
  }

  submitting.value = true;
  try {
    await applyDatabaseGrants(
      grantTarget.value.username,
      grantTarget.value.host,
      grantTarget.value.previousDatabases,
      grantForm.grantDatabases,
      grantForm.privilegeMode,
      grantForm.customPrivileges
    );
    await flushPrivileges(false);
    grantDialogVisible.value = false;
    await loadUsers();
    ElMessage.success(t('messages.grantSaved'));
  } catch (error) {
    ElMessage.error(`${t('messages.grantSaveFailed')}: ${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
};

const openPasswordDialog = (row: DbUserRow) => {
  passwordTarget.value = row;
  passwordForm.password = '';
  passwordDialogVisible.value = true;
};

const updatePassword = async () => {
  if (!props.connection || !passwordTarget.value) {
    return;
  }

  const password = passwordForm.password.trim();
  if (!password) {
    ElMessage.warning(t('validation.newPasswordRequired'));
    return;
  }

  submitting.value = true;
  try {
    if (isMysql.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `ALTER USER '${escapeSqlString(passwordTarget.value.username)}'@'${escapeSqlString(passwordTarget.value.host)}' IDENTIFIED BY '${escapeSqlString(password)}'`
      );
      await flushPrivileges(false);
    } else if (isPostgresFamily.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `ALTER USER ${quotePgIdentifier(passwordTarget.value.username)} WITH PASSWORD '${escapeSqlLiteral(password)}'`
      );
    } else if (isSqlServer.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `ALTER LOGIN ${quoteSqlServerIdentifier(passwordTarget.value.username)} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`
      );
    } else {
      await DbmApi.executeQuery(
        props.connection.id,
        `ALTER USER ${quoteOracleIdentifier(passwordTarget.value.username)} IDENTIFIED BY ${getOraclePasswordSql(password)}`
      );
    }
    passwordDialogVisible.value = false;
    await loadUsers();
    ElMessage.success(t('messages.passwordUpdated'));
  } catch (error) {
    ElMessage.error(`${t('messages.passwordUpdateFailed')}: ${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
};

const removeUser = async (row: DbUserRow) => {
  if (!props.connection) {
    return;
  }

  try {
    await ElMessageBox.confirm(
      t('messages.removeConfirm', { account: getAccountDisplay(row.username, row.host) }),
      t('messages.removeTitle'),
      {
        confirmButtonText: t('buttons.delete'),
        cancelButtonText: t('buttons.cancel'),
        type: 'warning'
      }
    );

    submitting.value = true;
    if (isMysql.value) {
      await DbmApi.executeQuery(
        props.connection.id,
        `DROP USER IF EXISTS '${escapeSqlString(row.username)}'@'${escapeSqlString(row.host)}'`
      );
      await flushPrivileges(false);
    } else if (isPostgresFamily.value) {
      await DbmApi.executeQuery(props.connection.id, `DROP USER IF EXISTS ${quotePgIdentifier(row.username)}`);
    } else if (isSqlServer.value) {
      await executeSqlBatch([
        `IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${escapeSqlLiteral(row.username)}')
DROP USER ${quoteSqlServerIdentifier(row.username)}`,
        `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${escapeSqlLiteral(row.username)}')
DROP LOGIN ${quoteSqlServerIdentifier(row.username)}`
      ]);
    } else {
      await DbmApi.executeQuery(props.connection.id, `DROP USER ${quoteOracleIdentifier(row.username)} CASCADE`);
    }
    await loadUsers();
    ElMessage.success(t('messages.removeSuccess'));
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(`${t('messages.removeFailed')}: ${(error as Error).message}`);
    }
  } finally {
    submitting.value = false;
  }
};
</script>

<style scoped>
.user-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.empty-holder {
  padding: 20px 0;
}

.table-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.privilege-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.privilege-summary,
.table-text {
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.4;
}

.form-tip {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.privilege-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  width: 100%;
}
</style>
