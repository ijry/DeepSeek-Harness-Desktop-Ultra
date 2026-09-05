<template>
  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-width="96px"
    class="db-connection-form"
  >
    <div class="db-connection-form-body">
      <el-form-item :label="t('name')" prop="name">
        <el-input v-model="form.name" :placeholder="t('namePlaceholder')" />
      </el-form-item>

      <el-form-item :label="t('type')" prop="db_type">
        <div class="db-type-grid">
          <button
            v-for="item in dbTypeOptions"
            :key="item.value"
            type="button"
            class="db-type-card"
            :class="{ 'is-active': form.db_type === item.value }"
            @click="form.db_type = item.value"
          >
            <span class="db-type-logo" :style="{ background: item.logoBg, color: item.logoColor }">
              <component
                :is="item.iconComponent"
                v-if="item.iconComponent"
                v-bind="item.iconProps"
                aria-hidden="true"
                class="db-type-logo-image"
              />
              <span v-else>{{ item.logoText }}</span>
            </span>
            <span class="db-type-name">{{ item.label }}</span>
          </button>
        </div>
      </el-form-item>

      <div v-if="!isSqlite" class="host-row">
        <el-form-item class="host-row-item host-row-main" :label="t('host')" prop="host">
          <el-input v-model="form.host" :placeholder="t('hostPlaceholder')" />
        </el-form-item>

        <el-form-item class="host-row-item host-row-port w-200px" :label="t('port')" prop="port">
          <el-input-number
            v-model="form.port"
            :min="1"
            :max="65535"
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
      </div>

      <el-form-item v-if="!isSqlite" :label="t('username')" prop="username">
        <el-input v-model="form.username" :placeholder="t('usernamePlaceholder')" />
      </el-form-item>

      <el-form-item v-if="!isSqlite" :label="t('password')" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          :placeholder="t('passwordPlaceholder')"
          show-password
        />
      </el-form-item>

      <template v-if="isMongoDb">
        <el-form-item :label="t('mongodbAuthSource')">
          <el-input
            v-model="form.mongodb!.auth_source"
            :placeholder="t('mongodbAuthSourcePlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('mongodbAuthMechanism')">
          <el-select
            v-model="form.mongodb!.auth_mechanism"
            size="small"
            filterable
            allow-create
            default-first-option
            :placeholder="t('mongodbAuthMechanismPlaceholder')"
          >
            <el-option
              v-for="item in mongoAuthMechanismOptions"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('mongodbReplicaSet')">
          <el-input
            v-model="form.mongodb!.replica_set"
            :placeholder="t('mongodbReplicaSetPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('mongodbReadPreference')">
          <el-select
            v-model="form.mongodb!.read_preference"
            size="small"
            filterable
            allow-create
            default-first-option
            :placeholder="t('mongodbReadPreferencePlaceholder')"
          >
            <el-option
              v-for="item in mongoReadPreferenceOptions"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('mongodbRetryWrites')">
          <el-switch v-model="form.mongodb!.retry_writes" />
        </el-form-item>

        <el-form-item :label="t('mongodbTls')">
          <el-checkbox v-model="form.mongodb!.tls">{{ t('enabled') }}</el-checkbox>
        </el-form-item>

        <el-form-item v-if="form.mongodb?.tls" :label="t('mongodbTlsAllowInvalidCerts')">
          <el-checkbox v-model="form.mongodb!.tls_allow_invalid_certificates">
            {{ t('enabled') }}
          </el-checkbox>
        </el-form-item>

        <el-form-item v-if="form.mongodb?.tls" :label="t('mongodbTlsCaFile')">
          <el-input
            v-model="form.mongodb!.tls_ca_file"
            :placeholder="t('mongodbTlsCaFilePlaceholder')"
          />
        </el-form-item>

        <el-form-item v-if="form.mongodb?.tls" :label="t('mongodbTlsClientKeyFile')">
          <el-input
            v-model="form.mongodb!.tls_certificate_key_file"
            :placeholder="t('mongodbTlsClientKeyFilePlaceholder')"
          />
        </el-form-item>

        <el-form-item v-if="form.mongodb?.tls" :label="t('mongodbTlsClientKeyPassword')">
          <el-input
            v-model="form.mongodb!.tls_certificate_key_file_password"
            type="password"
            show-password
            :placeholder="t('mongodbTlsClientKeyPasswordPlaceholder')"
          />
        </el-form-item>
      </template>

      <DbOdbcSettings
        v-if="isDameng"
        v-model="form.odbc"
      />

      <SshConnectionSettings
        v-if="showSshSettings"
        v-model="form.ssh"
        prop-prefix="ssh"
      />

      <el-form-item :label="databaseLabel" prop="database">
        <div v-if="isSqlite" class="sqlite-file-row">
          <el-input v-model="form.database" :placeholder="databasePlaceholder" />
          <el-button size="small" @click="selectSqliteFile">{{ t('selectFile') }}</el-button>
        </div>
        <el-input v-else v-model="form.database" :placeholder="databasePlaceholder" />
        <div v-if="isSqlite" class="field-hint">
          {{ t('sqliteHint') }}
        </div>
      </el-form-item>
    </div>

    <div class="form-actions">
      <el-button size="small" @click="emit('cancel')">{{ t('cancel') }}</el-button>
      <el-button size="small" type="primary" @click="handleSubmit">{{ t('save') }}</el-button>
    </div>
  </el-form>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { open } from '@tauri-apps/plugin-dialog';
import { ElMessage } from 'element-plus';
import {
  createDefaultDbSshConfig,
  normalizeDbSshConfig,
  type DbMongoConfig,
  type DbOdbcConfig,
  type DbConnection
} from './service';
import { getDbTypeOptions } from './dbTypeMeta';
import DbOdbcSettings from './DbOdbcSettings.vue';
import SshConnectionSettings from '@/platform/ui/common/SshConnectionSettings.vue';
import { useI18nScope } from '@/platform/i18n';

type DatabaseConnection = Partial<DbConnection>;
type SupportedDbType = NonNullable<DatabaseConnection['db_type']>;

const props = defineProps<{
  connection: DatabaseConnection | null;
}>();

const emit = defineEmits<{
  (e: 'save', connection: DatabaseConnection): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18nScope('dbm.connectionForm');
const formRef = ref<FormInstance>();
const dbTypeOptions = computed(() => getDbTypeOptions());
const defaultPortMap: Record<SupportedDbType, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgresql: 5432,
  sqlserver: 1433,
  kingbasees: 54321,
  dameng: 5236,
  sqlite: 0,
  elasticsearch: 9200,
  clickhouse: 8123,
  kafka: 9092,
  snowflake: 443,
  mongodb: 27017,
  redis: 6379,
  oracle: 1521
};

const createDefaultOdbcConfig = (): DbOdbcConfig => ({
  mode: 'driver',
  dsn: '',
  driver: '',
  connection_string: '',
  extra: ''
});

const createDefaultMongoConfig = (): DbMongoConfig => ({
  auth_source: '',
  auth_mechanism: '',
  replica_set: '',
  read_preference: '',
  retry_writes: true,
  tls: false,
  tls_allow_invalid_certificates: false,
  tls_ca_file: '',
  tls_certificate_key_file: '',
  tls_certificate_key_file_password: ''
});

const createDefaultForm = (): DatabaseConnection => ({
  name: '',
  db_type: 'mysql',
  host: 'localhost',
  port: 3306,
  username: '',
  password: '',
  database: '',
  ssh: createDefaultDbSshConfig(),
  odbc: createDefaultOdbcConfig(),
  mongodb: createDefaultMongoConfig()
});

const form = reactive<DatabaseConnection>(createDefaultForm());

const isSqlite = computed(() => form.db_type === 'sqlite');
const isDameng = computed(() => form.db_type === 'dameng');
const isMongoDb = computed(() => form.db_type === 'mongodb');
const showSshSettings = computed(() => !isSqlite.value);
const mongoAuthMechanismOptions = [
  'SCRAM-SHA-1',
  'SCRAM-SHA-256',
  'MONGODB-X509',
  'MONGODB-AWS',
  'PLAIN',
  'GSSAPI'
];
const mongoReadPreferenceOptions = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
];
const databaseLabel = computed(() => (isSqlite.value ? t('databaseFile') : t('databaseName')));
const databasePlaceholder = computed(() =>
  isSqlite.value
    ? t('databaseFilePlaceholder')
    : t('databaseNamePlaceholder')
);

const applyFormState = (value: DatabaseConnection | null) => {
  const defaults = createDefaultForm();
  const nextType = (value?.db_type || defaults.db_type) as SupportedDbType;
  const nextForm: DatabaseConnection = {
    ...defaults,
    ...(value || {}),
    db_type: nextType,
    host: nextType === 'sqlite'
      ? ''
      : (typeof value?.host === 'string' && value.host.trim() ? value.host : defaults.host),
    port: typeof value?.port === 'number' && Number.isFinite(value.port)
      ? value.port
      : defaultPortMap[nextType],
    username: typeof value?.username === 'string' ? value.username : '',
    password: typeof value?.password === 'string' ? value.password : '',
    database: typeof value?.database === 'string' ? value.database : '',
    ssh: normalizeDbSshConfig(value?.ssh),
    odbc: {
      ...createDefaultOdbcConfig(),
      ...(value?.odbc || {})
    },
    mongodb: {
      ...createDefaultMongoConfig(),
      ...(value?.mongodb || {})
    },
  };

  form.id = nextForm.id;
  form.name = nextForm.name;
  form.db_type = nextForm.db_type;
  form.host = nextForm.host;
  form.port = nextForm.port;
  form.username = nextForm.username;
  form.password = nextForm.password;
  form.database = nextForm.database;
  form.ssh = nextForm.ssh;
  form.odbc = nextForm.odbc;
  form.mongodb = nextForm.mongodb;
  form.created_at = nextForm.created_at;
  form.connection_string = nextForm.connection_string;

  void nextTick(() => formRef.value?.clearValidate());
};

const rules = reactive<FormRules<DatabaseConnection>>({
  name: [
    { required: true, message: t('validation.nameRequired'), trigger: 'blur' }
  ],
  db_type: [
    { required: true, message: t('validation.typeRequired'), trigger: 'change' }
  ],
  host: [
    {
      validator: (_rule, value, callback) => {
        if (isSqlite.value || String(value || '').trim()) {
          callback();
          return;
        }
        if (
          isDameng.value
          && ((form.odbc?.mode === 'dsn' && String(form.odbc?.dsn || '').trim())
            || (form.odbc?.mode === 'connection_string' && String(form.odbc?.connection_string || '').trim()))
        ) {
          callback();
          return;
        }
        callback(new Error(t('validation.hostRequired')));
      },
      trigger: 'blur'
    }
  ],
  port: [
    {
      validator: (_rule, value, callback) => {
        if (isSqlite.value) {
          callback();
          return;
        }
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          callback();
          return;
        }
        callback(new Error(t('validation.portInvalid')));
      },
      trigger: 'change'
    }
  ],
  username: [
    {
      validator: (_rule, value, callback) => {
        if (
          ['redis', 'sqlite', 'mongodb', 'elasticsearch', 'clickhouse', 'kafka'].includes(form.db_type || '')
          || (isDameng.value && form.odbc?.mode === 'connection_string' && String(form.odbc?.connection_string || '').trim())
        ) {
          callback();
          return;
        }
        if (String(value || '').trim()) {
          callback();
          return;
        }
        callback(new Error(t('validation.usernameRequired')));
      },
      trigger: 'blur'
    }
  ],
  database: [
    {
      validator: (_rule, value, callback) => {
        if (isSqlite.value && !String(value || '').trim()) {
          callback(new Error(t('validation.sqliteFileRequired')));
          return;
        }
        callback();
      },
      trigger: 'blur'
    }
  ],
  'ssh.host': [
    {
      validator: (_rule, value, callback) => {
        if (!showSshSettings.value || !form.ssh?.enabled || String(value || '').trim()) {
          callback();
          return;
        }
        callback(new Error(t('validation.sshHostRequired')));
      },
      trigger: 'blur'
    }
  ],
  'ssh.port': [
    {
      validator: (_rule, value, callback) => {
        if (!showSshSettings.value || !form.ssh?.enabled) {
          callback();
          return;
        }
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          callback();
          return;
        }
        callback(new Error(t('validation.sshPortInvalid')));
      },
      trigger: 'change'
    }
  ],
  'ssh.username': [
    {
      validator: (_rule, value, callback) => {
        if (!showSshSettings.value || !form.ssh?.enabled || String(value || '').trim()) {
          callback();
          return;
        }
        callback(new Error(t('validation.sshUsernameRequired')));
      },
      trigger: 'blur'
    }
  ],
  'ssh.password': [
    {
      validator: (_rule, value, callback) => {
        if (!showSshSettings.value || !form.ssh?.enabled || form.ssh?.auth_type !== 'password') {
          callback();
          return;
        }
        if (String(value || '').trim()) {
          callback();
          return;
        }
        callback(new Error(t('validation.sshPasswordRequired')));
      },
      trigger: 'blur'
    }
  ],
  'ssh.private_key_path': [
    {
      validator: (_rule, value, callback) => {
        if (!showSshSettings.value || !form.ssh?.enabled || form.ssh?.auth_type !== 'private_key') {
          callback();
          return;
        }
        if (String(value || '').trim()) {
          callback();
          return;
        }
        callback(new Error(t('validation.sshPrivateKeyRequired')));
      },
      trigger: 'blur'
    }
  ]
});

watch(
  () => props.connection,
  (value) => {
    applyFormState(value);
  },
  { immediate: true }
);

watch(
  () => form.db_type,
  (nextType, prevType) => {
    if (!nextType) {
      return;
    }

    const prevDefaultPort = prevType ? defaultPortMap[prevType] : undefined;
    if (form.port == null || form.port === 0 || form.port === prevDefaultPort) {
      form.port = defaultPortMap[nextType];
    }

    if (nextType !== 'sqlite' && !String(form.host || '').trim()) {
      form.host = 'localhost';
    }

    if (nextType === 'clickhouse' && !String(form.username || '').trim()) {
      form.username = 'default';
    }

    if (nextType !== 'dameng') {
      form.odbc = createDefaultOdbcConfig();
    }

    if (nextType !== 'mongodb') {
      form.mongodb = createDefaultMongoConfig();
    }
  }
);

const selectSqliteFile = async () => {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: t('sqliteFilter'), extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: t('allFilesFilter'), extensions: ['*'] }
      ]
    });

    if (typeof selected === 'string' && selected.trim()) {
      form.database = selected;
    }
  } catch {
    ElMessage.error(t('selectSqliteFailed'));
  }
};

const handleSubmit = async () => {
  if (!formRef.value) {
    return;
  }

  try {
    await formRef.value.validate();

    const ssh = normalizeDbSshConfig(form.ssh);
    const normalizedSsh = !isSqlite.value && ssh.enabled
      ? {
          ...ssh,
          host: ssh.host.trim(),
          username: ssh.username.trim(),
          password: ssh.auth_type === 'password' ? ssh.password : '',
          private_key_path: ssh.auth_type === 'private_key' ? ssh.private_key_path.trim() : '',
          passphrase: ssh.auth_type === 'private_key' ? ssh.passphrase : ''
        }
      : null;

    const connectionData: DbConnection = {
      id: form.id || Date.now().toString(),
      name: (form.name || '').trim(),
      db_type: form.db_type || 'mysql',
      host: isSqlite.value ? '' : String(form.host || '').trim(),
      port: isSqlite.value ? 0 : Number(form.port) || defaultPortMap[(form.db_type || 'mysql') as SupportedDbType],
      username: isSqlite.value
        ? ''
        : ((form.db_type === 'clickhouse' && !String(form.username || '').trim())
            ? 'default'
            : String(form.username || '').trim()),
      password: isSqlite.value ? '' : String(form.password || ''),
      database: form.db_type === 'redis'
        ? (String(form.database || '').trim() || '0')
        : String(form.database || '').trim(),
      ssh: normalizedSsh,
      odbc: isDameng.value
        ? {
            ...createDefaultOdbcConfig(),
            ...(form.odbc || {}),
            mode: (form.odbc?.mode || 'driver') as DbOdbcConfig['mode'],
            dsn: String(form.odbc?.dsn || '').trim(),
            driver: String(form.odbc?.driver || '').trim(),
            connection_string: String(form.odbc?.connection_string || '').trim(),
            extra: String(form.odbc?.extra || '').trim()
          }
        : null,
      mongodb: isMongoDb.value
        ? {
            ...createDefaultMongoConfig(),
            ...(form.mongodb || {}),
            auth_source: String(form.mongodb?.auth_source || '').trim(),
            auth_mechanism: String(form.mongodb?.auth_mechanism || '').trim(),
            replica_set: String(form.mongodb?.replica_set || '').trim(),
            read_preference: String(form.mongodb?.read_preference || '').trim(),
            retry_writes: typeof form.mongodb?.retry_writes === 'boolean' ? form.mongodb.retry_writes : null,
            tls: !!form.mongodb?.tls,
            tls_allow_invalid_certificates: !!form.mongodb?.tls_allow_invalid_certificates,
            tls_ca_file: String(form.mongodb?.tls_ca_file || '').trim(),
            tls_certificate_key_file: String(form.mongodb?.tls_certificate_key_file || '').trim(),
            tls_certificate_key_file_password: String(form.mongodb?.tls_certificate_key_file_password || '')
          }
        : null,
      connection_string: form.connection_string || '',
      created_at: form.created_at || new Date().toISOString()
    };

    emit('save', connectionData);
  } catch {
    // validation errors are displayed by Element Plus
  }
};
</script>

<style scoped>
.db-connection-form {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.db-connection-form-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.host-row {
  display: flex;
  gap: 10px;
}

.host-row-item {
  margin-bottom: 18px;
}

.host-row-main {
  flex: 1;
}

.host-row-port {
  flex-shrink: 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-shrink: 0;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.sqlite-file-row {
  width: 100%;
  display: flex;
  gap: 8px;
}

.field-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}

.db-type-grid {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
  gap: 10px;
}

.db-type-card {
  border: 1px solid var(--layout-border-color);
  background: var(--el-bg-color);
  border-radius: 10px;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.db-type-card:hover {
  border-color: #409eff;
  transform: translateY(-1px);
}

.db-type-card.is-active {
  border-color: #409eff;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.18);
}

.db-type-logo {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.db-type-logo-image {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

:deep(.db-type-logo-mysql path) {
  fill: var(--db-type-logo-fill) !important;
}

.db-type-name {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1;
}

@media (max-width: 640px) {
  .host-row,
  .sqlite-file-row {
    flex-direction: column;
  }

  .host-row-port {
    width: 100%;
  }
}
</style>
