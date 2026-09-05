import { invoke } from 'otools-plugin-sdk/runtime';

const DBM_ERROR_PREFIXES = [
  '数据库连接错误: ',
  'MySQL/MariaDB连接失败: ',
  'PostgreSQL连接失败: ',
  'SQL Server 连接失败: ',
  'SQLite连接失败: ',
  'MongoDB连接失败: ',
  'Redis连接失败: ',
  'Oracle连接失败: ',
  '查询执行错误: ',
  'MySQL/MariaDB查询失败: ',
  'PostgreSQL查询失败: ',
  'SQLite查询失败: ',
  'MongoDB查询失败: ',
  'Redis查询失败: ',
  'Oracle查询失败: '
];

const stripDbmErrorPrefixes = (message: string) => {
  let normalized = message.trim();
  const statementPrefixMatch = normalized.match(/^(第\s*\d+\s*条\s*SQL\s*执行失败:\s*)(.+)$/);

  if (statementPrefixMatch) {
    const [, statementPrefix, rest] = statementPrefixMatch;
    return `${statementPrefix}${stripDbmErrorPrefixes(rest)}`;
  }

  while (true) {
    const prefix = DBM_ERROR_PREFIXES.find((item) => normalized.startsWith(item));
    if (!prefix) {
      return normalized;
    }
    normalized = normalized.slice(prefix.length).trim();
  }
};

const humanizeDbmErrorMessage = (message: string) => {
  const normalized = stripDbmErrorPrefixes(message);
  const codedMatch = normalized.match(/^\[([A-Z0-9_]+)\]\s*(.+)$/);
  if (codedMatch) {
    const [, code, detail] = codedMatch;
    const codeMap: Record<string, string> = {
      DBM_MONGO_CONN_TIMEOUT: 'MongoDB 连接超时，请检查网络、地址和端口后重试。',
      DBM_MONGO_CONN_AUTH: 'MongoDB 认证失败，请检查用户名、密码和 authSource。',
      DBM_MONGO_CONN_TLS: 'MongoDB TLS 握手失败，请检查 TLS 参数和证书配置。',
      DBM_MONGO_CONN_DNS: 'MongoDB 地址解析失败，请检查主机名或 DNS 配置。',
      DBM_MYSQL_CONN_TIMEOUT: 'MySQL/MariaDB 连接超时，请检查网络、地址和端口。',
      DBM_MYSQL_CONN_AUTH: 'MySQL/MariaDB 认证失败，请检查用户名或密码。',
      DBM_MYSQL_CONN_TLS: 'MySQL/MariaDB TLS 握手失败，请检查证书与加密参数。',
      DBM_MYSQL_CONN_DNS: 'MySQL/MariaDB 地址解析失败，请检查主机名或 DNS。',
      DBM_MYSQL_CONN_UNKNOWN: 'MySQL/MariaDB 连接失败，请检查连接参数。',
      DBM_PG_CONN_TIMEOUT: 'PostgreSQL 连接超时，请检查网络、地址和端口。',
      DBM_PG_CONN_AUTH: 'PostgreSQL 认证失败，请检查用户名或密码。',
      DBM_PG_CONN_TLS: 'PostgreSQL TLS 握手失败，请检查证书与加密参数。',
      DBM_PG_CONN_DNS: 'PostgreSQL 地址解析失败，请检查主机名或 DNS。',
      DBM_PG_CONN_UNKNOWN: 'PostgreSQL 连接失败，请检查连接参数。',
      DBM_SQLSERVER_CONN_TIMEOUT: 'SQL Server 连接超时，请检查网络、地址和端口。',
      DBM_SQLSERVER_CONN_AUTH: 'SQL Server 认证失败，请检查用户名或密码。',
      DBM_SQLSERVER_CONN_TLS: 'SQL Server TLS 握手失败，请检查证书与加密参数。',
      DBM_SQLSERVER_CONN_DNS: 'SQL Server 地址解析失败，请检查主机名或 DNS。',
      DBM_SQLSERVER_CONN_UNKNOWN: 'SQL Server 连接失败，请检查连接参数。',
      DBM_ORACLE_CONN_TIMEOUT: 'Oracle 连接超时，请检查网络、地址和端口。',
      DBM_ORACLE_CONN_AUTH: 'Oracle 认证失败，请检查用户名或密码。',
      DBM_ORACLE_CONN_TLS: 'Oracle TLS 握手失败，请检查证书与加密参数。',
      DBM_ORACLE_CONN_DNS: 'Oracle 地址解析失败，请检查主机名或 DNS。',
      DBM_ORACLE_CONN_UNKNOWN: 'Oracle 连接失败，请检查连接参数。',
      DBM_KINGBASE_CONN_TIMEOUT: 'KingbaseES 连接超时，请检查网络、地址和端口。',
      DBM_KINGBASE_CONN_AUTH: 'KingbaseES 认证失败，请检查用户名或密码。',
      DBM_KINGBASE_CONN_TLS: 'KingbaseES TLS 握手失败，请检查证书与加密参数。',
      DBM_KINGBASE_CONN_DNS: 'KingbaseES 地址解析失败，请检查主机名或 DNS。',
      DBM_KINGBASE_CONN_UNKNOWN: 'KingbaseES 连接失败，请检查连接参数。',
      DBM_DAMENG_CONN_TIMEOUT: '达梦连接超时，请检查网络、地址和端口。',
      DBM_DAMENG_CONN_AUTH: '达梦认证失败，请检查用户名或密码。',
      DBM_DAMENG_CONN_TLS: '达梦 TLS 握手失败，请检查证书与加密参数。',
      DBM_DAMENG_CONN_DNS: '达梦地址解析失败，请检查主机名或 DNS。',
      DBM_DAMENG_CONN_UNKNOWN: '达梦连接失败，请检查连接参数。',
      DBM_ES_CONN_TIMEOUT: 'Elasticsearch 连接超时，请检查网络、地址和端口。',
      DBM_ES_CONN_AUTH: 'Elasticsearch 认证失败，请检查用户名或密码。',
      DBM_ES_CONN_TLS: 'Elasticsearch TLS 握手失败，请检查证书与加密参数。',
      DBM_ES_CONN_DNS: 'Elasticsearch 地址解析失败，请检查主机名或 DNS。',
      DBM_ES_CONN_UNKNOWN: 'Elasticsearch 连接失败，请检查连接参数。',
      DBM_CLICKHOUSE_CONN_TIMEOUT: 'ClickHouse 连接超时，请检查网络、地址和端口。',
      DBM_CLICKHOUSE_CONN_AUTH: 'ClickHouse 认证失败，请检查用户名或密码。',
      DBM_CLICKHOUSE_CONN_TLS: 'ClickHouse TLS 握手失败，请检查证书与加密参数。',
      DBM_CLICKHOUSE_CONN_DNS: 'ClickHouse 地址解析失败，请检查主机名或 DNS。',
      DBM_CLICKHOUSE_CONN_UNKNOWN: 'ClickHouse 连接失败，请检查连接参数。',
      DBM_KAFKA_CONN_TIMEOUT: 'Kafka 连接超时，请检查网络、地址和端口。',
      DBM_KAFKA_CONN_AUTH: 'Kafka 认证失败，请检查用户名或密码。',
      DBM_KAFKA_CONN_TLS: 'Kafka TLS 握手失败，请检查证书与加密参数。',
      DBM_KAFKA_CONN_DNS: 'Kafka 地址解析失败，请检查主机名或 DNS。',
      DBM_KAFKA_CONN_UNKNOWN: 'Kafka 连接失败，请检查连接参数。',
      DBM_SNOWFLAKE_CONN_TIMEOUT: 'Snowflake 连接超时，请检查网络、地址和端口。',
      DBM_SNOWFLAKE_CONN_AUTH: 'Snowflake 认证失败，请检查用户名或密码。',
      DBM_SNOWFLAKE_CONN_TLS: 'Snowflake TLS 握手失败，请检查证书与加密参数。',
      DBM_SNOWFLAKE_CONN_DNS: 'Snowflake 地址解析失败，请检查主机名或 DNS。',
      DBM_SNOWFLAKE_CONN_UNKNOWN: 'Snowflake 连接失败，请检查连接参数。',
      DBM_REDIS_CONN_TIMEOUT: 'Redis 连接超时，请检查网络和服务状态。',
      DBM_REDIS_CONN_AUTH: 'Redis 认证失败，请检查用户名或密码。',
      DBM_REDIS_CONN_TLS: 'Redis TLS/SSL 握手失败，请检查加密配置。',
      DBM_REDIS_CONN_DNS: 'Redis 地址解析失败，请检查主机名或 DNS 配置。',
      DBM_REDIS_CONN_UNKNOWN: 'Redis 连接失败，请检查连接参数。',
      DBM_REDIS_TXN_EXEC: 'Redis 批量事务执行失败，已终止本次写入。',
      DBM_REDIS_WATCH_CONFLICT: 'Redis 检测到并发冲突，本次保存已取消，请重试。',
      DBM_REDIS_KEY_EMPTY: 'Redis 键名为空，请补全 key 后重试。',
      DBM_REDIS_KEY_MISSING: 'Redis 记录缺少 key，请补全 key 后重试。',
      DBM_REDIS_VALUE_TYPE_MISSING: 'Redis 记录缺少 value_type，请补全类型后重试。',
      DBM_REDIS_HASH_EMPTY: 'Redis Hash 缺少 field，请补全数据后重试。',
      DBM_REDIS_HASH_FIELD_EMPTY: 'Redis Hash 字段名为空，请补全 field 后重试。',
      DBM_REDIS_LIST_EMPTY: 'Redis List 缺少成员，请补全 entries 后重试。',
      DBM_REDIS_SET_EMPTY: 'Redis Set 缺少成员，请补全 entries 后重试。',
      DBM_REDIS_ZSET_EMPTY: 'Redis ZSet 缺少成员，请补全 entries 后重试。',
      DBM_REDIS_ZSET_SCORE_INVALID: 'Redis ZSet 的 score 非法，请检查数值后重试。',
      DBM_REDIS_TYPE_UNSUPPORTED: 'Redis value_type 暂不支持写入，请检查类型设置。',
      DBM_REDIS_TTL_INVALID: 'Redis ttl_seconds 非法，请输入大于等于 0 的值。'
    };

    if (codeMap[code]) {
      return `${codeMap[code]} ${detail}`;
    }
    return detail;
  }

  const mysqlPrivilegeMatch = normalized.match(
    /1142 \(42000\): (.+?) command denied to user '([^']+)'@'([^']+)'(?: for table '([^']+)')?/i
  );

  if (!mysqlPrivilegeMatch) {
    return normalized;
  }

  const [, privilege, username, host, objectName] = mysqlPrivilegeMatch;
  const privilegeName = privilege.trim().toUpperCase();
  const objectHint =
    objectName && objectName !== 'view_name' ? `，对象：${objectName}` : '';

  if (privilegeName === 'CREATE VIEW') {
    return `当前账号 '${username}'@'${host}' 缺少 CREATE VIEW 权限，无法创建视图${objectHint}。请为目标库授予 CREATE VIEW（通常也建议同时授予 SHOW VIEW）权限后重试。`;
  }

  return `当前账号 '${username}'@'${host}' 缺少 ${privilegeName} 权限，无法执行当前操作${objectHint}。`;
};

export const extractDbmErrorMessage = (error: unknown, fallback = '操作失败') => {
  if (error instanceof Error && error.message) {
    return humanizeDbmErrorMessage(error.message);
  }

  if (typeof error === 'string' && error.trim()) {
    return humanizeDbmErrorMessage(error);
  }

  if (error && typeof error === 'object') {
    const candidateKeys = ['message', 'msg', 'error', 'details'];
    for (const key of candidateKeys) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        return humanizeDbmErrorMessage(value);
      }
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') {
        return humanizeDbmErrorMessage(serialized);
      }
    } catch {
      // ignore serialization errors
    }
  }

  return fallback;
};

export const toDbmError = (error: unknown, fallback = '操作失败') =>
  new Error(extractDbmErrorMessage(error, fallback));

export type DbSshAuthType = 'password' | 'private_key';

export interface DbOdbcConfig {
  mode: 'driver' | 'dsn' | 'connection_string';
  dsn: string;
  driver: string;
  connection_string: string;
  extra: string;
}

export interface DbMongoConfig {
  auth_source: string;
  auth_mechanism: string;
  replica_set: string;
  read_preference: string;
  retry_writes?: boolean | null;
  tls: boolean;
  tls_allow_invalid_certificates: boolean;
  tls_ca_file: string;
  tls_certificate_key_file: string;
  tls_certificate_key_file_password: string;
}

export interface DbSshConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  auth_type: DbSshAuthType;
  password: string;
  private_key_path: string;
  passphrase: string;
}

export const createDefaultDbSshConfig = (): DbSshConfig => ({
  enabled: false,
  host: '',
  port: 22,
  username: '',
  auth_type: 'password',
  password: '',
  private_key_path: '',
  passphrase: ''
});

export const normalizeDbSshConfig = (ssh?: Partial<DbSshConfig> | null): DbSshConfig => {
  const raw = (ssh || {}) as Partial<DbSshConfig> & {
    authType?: unknown;
    privateKeyPath?: unknown;
  };
  const auth_type: DbSshAuthType =
    raw.auth_type === 'private_key' || raw.authType === 'private_key'
      ? 'private_key'
      : 'password';

  return {
    ...createDefaultDbSshConfig(),
    ...(ssh || {}),
    enabled: !!raw.enabled,
    host: typeof raw.host === 'string' ? raw.host : '',
    port: typeof raw.port === 'number' && Number.isFinite(raw.port) && raw.port > 0 ? raw.port : 22,
    username: typeof raw.username === 'string' ? raw.username : '',
    auth_type,
    password: typeof raw.password === 'string' ? raw.password : '',
    private_key_path: typeof raw.private_key_path === 'string'
      ? raw.private_key_path
      : (typeof raw.privateKeyPath === 'string' ? raw.privateKeyPath : ''),
    passphrase: typeof raw.passphrase === 'string' ? raw.passphrase : ''
  };
};

// 数据库连接相关接口
export interface DbConnection {
  id: string;
  name: string;
  db_type:
    | 'mysql'
    | 'mariadb'
    | 'postgresql'
    | 'sqlserver'
    | 'kingbasees'
    | 'dameng'
    | 'sqlite'
    | 'elasticsearch'
    | 'clickhouse'
    | 'kafka'
    | 'snowflake'
    | 'mongodb'
    | 'redis'
    | 'oracle';
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssh?: DbSshConfig | null;
  odbc?: DbOdbcConfig | null;
  mongodb?: DbMongoConfig | null;
  created_at: string;
  connection_string: string;
  isConnected?: boolean
}

// 查询结果接口
export interface QueryStatementResult {
  statement_index: number;
  sql: string;
  sql_preview: string;
  columns: string[];
  rows: any[][];
  row_count: number | null;
  execution_time: number | null;
  success?: boolean;
  error_message?: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  row_count: number | null;
  execution_time: number | null;
  statements?: QueryStatementResult[];
  has_errors?: boolean;
  batch_error_message?: string | null;
  failed_statement_index?: number | null;
}

export interface RedisKeyInfo {
  key: string;
  database: string;
  value_type: string;
  ttl_seconds: number;
  ttl_label: string;
  columns: string[];
  rows: any[][];
}

export interface RedisKeyEntry {
  field?: string | null;
  value: string;
  score?: string | null;
}

export interface RedisKeyMutation {
  key_name: string;
  value_type: 'string' | 'hash' | 'list' | 'set' | 'zset';
  ttl_seconds?: number | null;
  entries: RedisKeyEntry[];
}

export interface RedisTreeNode {
  node_type: 'prefix' | 'key';
  label: string;
  full_path: string;
}

export interface RedisTreeChildrenPage {
  nodes: RedisTreeNode[];
  next_cursor?: string | null;
}

// 表结构接口
export interface TableStruct {
  table_name: string;
  columns: ColumnSchema[];
  primary_keys: string[];
  foreign_keys: ForeignKey[];
  indexes: IndexInfo[];
  comment: string;
}

export interface ColumnSchema {
  name: string;
  data_type: string;
  is_nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  character_maximum_length: number | null;
  original_name?: string;
  column_comment?: string; // 新增字段备注
}

export interface ColumnModifySchema {
  name: string;
  data_type: string;
  is_nullable: boolean;
  default_value: string | null;
  character_maximum_length: number | null;
  is_primary_key: boolean;
  column_comment?: string; // 新增字段备注
  old_name?: string;  // 添加旧字段名，用于字段重命名
}

export interface ForeignKey {
  constraint_name: string;
  column_name: string;
  referenced_schema?: string | null;
  referenced_table: string;
  referenced_column: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
}

export type BackupPlanScheduleType = 'daily' | 'interval';

export interface BackupPlan {
  id: string;
  name: string;
  connectionId: string;
  databaseName: string;
  exportPath: string;
  scheduleType: BackupPlanScheduleType;
  dailyTime: string;
  intervalHours: number;
  enabled: boolean;
  retentionDays: number;
  createdAt: string;
  lastTriggeredAt?: string | null;
  lastTaskId?: string | null;
  lastRunStatus?: string | null;
  lastSuccessAt?: string | null;
  lastErrorMessage?: string | null;
}

export interface BackupStorageInfo {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  sampleBackupCount: number;
  averageBackupBytes: number;
  estimatedBackupCount: number;
}

export interface DbSyncLog {
  id: string;
  taskId: string;
  sourceConnectionId: string;
  sourceDatabaseName: string;
  targetConnectionId: string;
  targetDatabaseName: string;
  syncStructure: boolean;
  syncData: boolean;
  tableCount: number;
  status: string;
  message?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  resultFile?: string | null;
  createdTableCount?: number;
  alteredTableCount?: number;
  failedTableCount?: number;
  insertedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  details?: DbSyncTableDetail[];
}

export interface DbSyncTableDetail {
  tableName: string;
  structureStatus?: string;
  dataStatus?: string;
  structureActions?: string[];
  insertedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  skippedReason?: string | null;
  errorMessage?: string | null;
  elapsedMs?: number;
  sqlCount?: number;
  retryCount?: number;
}

export interface DbSyncPreviewResult {
  tableCount: number;
  createdTableCount: number;
  alteredTableCount: number;
  failedTableCount: number;
  insertedCount: number;
  updatedCount: number;
  deletedCount: number;
  details: DbSyncTableDetail[];
  sqlStatements: string[];
  message: string;
  planToken?: string;
}

// 数据库管理API类
export class DbmApi {
  // 连接管理
  static async addConnection(connection: Omit<DbConnection, 'id' | 'created_at'>): Promise<string> {
    const connectionWithDefaults = {
      ...connection,
      id: Date.now().toString(),
      created_at: new Date().toISOString(),
      connection_string: generateConnectionString({
        ...connection,
        id: Date.now().toString(),
        created_at: new Date().toISOString()
      })
    };
    try {
      return await invoke<string>('add_db_connection', { connection: connectionWithDefaults });
    } catch (error) {
      throw toDbmError(error, '保存连接失败');
    }
  }

  static async getConnections(): Promise<DbConnection[]> {
    return await invoke<DbConnection[]>('get_db_connections');
  }

  static async getConnection(id: string): Promise<DbConnection | null> {
    return await invoke<DbConnection | null>('get_db_connection', { id });
  }

  static async updateConnection(id: string, connection: DbConnection): Promise<void> {
    const connectionWithConnectionString = {
      ...connection,
      connection_string: generateConnectionString(connection)
    };
    try {
      return await invoke<void>('update_db_connection', { id, connection: connectionWithConnectionString });
    } catch (error) {
      throw toDbmError(error, '更新连接失败');
    }
  }

  static async deleteConnection(id: string): Promise<void> {
    return await invoke<void>('delete_db_connection', { id });
  }

  static async openConnection(connection: DbConnection): Promise<boolean> {
    try {
      return await invoke<boolean>('open_db_connection', { connection });
    } catch (error) {
      throw toDbmError(error, '连接失败');
    }
  }

  static async closeConnection(id: string): Promise<boolean> {
    return await invoke<boolean>('close_db_connection', { id });
  }

  static async isConnectionActive(id: string): Promise<boolean> {
    return await invoke<boolean>('is_db_connection_active', { id });
  }

  // 查询执行
  static async executeQuery(connectionId: string, sql: string, databaseName?: string): Promise<QueryResult> {
    try {
      return await invoke<QueryResult>('execute_query', { connectionId, sql, databaseName });
    } catch (error) {
      throw toDbmError(error, 'SQL 执行失败');
    }
  }

  static async executeWorkbenchQuery(connectionId: string, sql: string, databaseName?: string): Promise<QueryResult> {
    try {
      return await invoke<QueryResult>('execute_query_workbench', { connectionId, sql, databaseName });
    } catch (error) {
      throw toDbmError(error, 'SQL 执行失败');
    }
  }

  static async executeDashboardQuery(
    connectionId: string,
    sql: string,
    databaseName?: string
  ): Promise<QueryResult> {
    try {
      return await invoke<QueryResult>('dbm_execute_dashboard_query', {
        connectionId,
        sql,
        databaseName
      });
    } catch (error) {
      throw toDbmError(error, '大屏查询失败');
    }
  }

  static async getDatabases(connectionId: string): Promise<string[]> {
    return await invoke<string[]>('get_databases', { connectionId });
  }

  static async getSchemas(connectionId: string, databaseName?: string): Promise<string[]> {
    return await invoke<string[]>('get_schemas', { connectionId, databaseName });
  }

  static async getTables(
    connectionId: string,
    databaseName?: string,
    schemaName?: string
  ): Promise<string[]> {
    return await invoke<string[]>('get_tables', { connectionId, databaseName, schemaName });
  }

  static async getTableData(
    connectionId: string, 
    databaseName: string | undefined, 
    tableName: string, 
    schemaName?: string,
    limit?: number, 
    offset?: number,
    orderBy?: string,
    filters?: Record<string, any>
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('get_table_data', { 
      connectionId, 
      databaseName, 
      tableName, 
      schemaName,
      limit, 
      offset,
      orderBy,
      filters
    });
  }

  static async getRedisKeyInfo(
    connectionId: string,
    databaseName: string | undefined,
    keyName: string
  ): Promise<RedisKeyInfo> {
    return await invoke<RedisKeyInfo>('get_redis_key_info', {
      connectionId,
      databaseName,
      keyName
    });
  }

  static async getRedisTreeChildren(
    connectionId: string,
    databaseName: string | undefined,
    prefix?: string,
    cursor?: string,
    limit?: number,
    keywords?: string[]
  ): Promise<RedisTreeChildrenPage> {
    try {
      return await invoke<RedisTreeChildrenPage>('get_redis_tree_children', {
        connectionId,
        databaseName,
        prefix,
        cursor,
        limit,
        keywords
      });
    } catch (error) {
      throw toDbmError(error, '加载 Redis 键目录失败');
    }
  }

  static async setRedisKey(
    connectionId: string,
    databaseName: string | undefined,
    payload: RedisKeyMutation
  ): Promise<RedisKeyInfo> {
    try {
      return await invoke<RedisKeyInfo>('set_redis_key', {
        connectionId,
        databaseName,
        payload
      });
    } catch (error) {
      throw toDbmError(error, '保存 Redis 键失败');
    }
  }

  static async deleteRedisKey(
    connectionId: string,
    databaseName: string | undefined,
    keyName: string
  ): Promise<void> {
    try {
      return await invoke<void>('delete_redis_key', {
        connectionId,
        databaseName,
        keyName
      });
    } catch (error) {
      throw toDbmError(error, '删除 Redis 键失败');
    }
  }

  static async explainQuery(connectionId: string, sql: string): Promise<QueryResult> {
    return await invoke<QueryResult>('explain_query', { connectionId, sql });
  }

  // 视图和存储过程
  static async getViews(
    connectionId: string,
    databaseName?: string,
    schemaName?: string
  ): Promise<string[]> {
    return await invoke<string[]>('get_views', { connectionId, databaseName, schemaName });
  }

  static async getStoredProcedures(
    connectionId: string,
    databaseName?: string,
    schemaName?: string
  ): Promise<string[]> {
    return await invoke<string[]>('get_stored_procedures', {
      connectionId,
      databaseName,
      schemaName
    });
  }

  static async getViewDefinition(
    connectionId: string,
    databaseName: string | undefined,
    viewName: string,
    schemaName?: string
  ): Promise<string> {
    return await invoke<string>('get_view_definition', {
      connectionId,
      databaseName,
      viewName,
      schemaName
    });
  }

  static async getProcedureDefinition(
    connectionId: string,
    databaseName: string | undefined,
    procedureName: string,
    schemaName?: string
  ): Promise<string> {
    return await invoke<string>('get_procedure_definition', {
      connectionId,
      databaseName,
      procedureName,
      schemaName
    });
  }

  // 表结构
  static async getTableStruct(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    schemaName?: string
  ): Promise<TableStruct> {
    return await invoke<TableStruct>('get_table_struct', {
      connectionId,
      databaseName,
      tableName,
      schemaName
    });
  }

  static async getAllTableStructs(
    connectionId: string,
    databaseName?: string,
    schemaName?: string,
    forceRefresh = false
  ): Promise<TableStruct[]> {
    return await invoke<TableStruct[]>('get_all_table_structs', {
      connectionId,
      databaseName,
      schemaName,
      forceRefresh
    });
  }

  static async exportDataDictionaryDocx(
    connectionId: string,
    outputPath: string,
    databaseName?: string,
    schemaName?: string,
    progressToken?: string
  ): Promise<string> {
    return await invoke<string>('export_data_dictionary_docx', {
      connectionId,
      outputPath,
      databaseName,
      schemaName,
      progressToken
    });
  }

  static async getDatabaseStats(connectionId: string): Promise<any> {
    return await invoke<any>('get_database_stats', { connectionId });
  }

  // CRUD操作
  static async insertRecord(connectionId: string, tableName: string, data: Record<string, any>): Promise<QueryResult> {
    return await invoke<QueryResult>('insert_record', { connectionId, tableName, data });
  }

  static async updateRecord(connectionId: string, tableName: string, id: any, data: Record<string, any>): Promise<QueryResult> {
    return await invoke<QueryResult>('update_record', { connectionId, tableName, id, data });
  }

  static async deleteRecord(connectionId: string, tableName: string, id: any): Promise<QueryResult> {
    return await invoke<QueryResult>('delete_record', { connectionId, tableName, id });
  }

  static async bulkInsert(connectionId: string, tableName: string, records: Record<string, any>[]): Promise<QueryResult> {
    return await invoke<QueryResult>('bulk_insert', { connectionId, tableName, records });
  }

  static async paginatedQuery(
    connectionId: string,
    tableName: string,
    page: number,
    pageSize: number,
    orderBy?: string,
    filters?: Record<string, any>
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('paginated_query', { 
      connectionId, 
      tableName, 
      page, 
      pageSize, 
      orderBy, 
      filters 
    });
  }

  static async createTable(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    columns: ColumnModifySchema[],
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('create_table', {
      connectionId,
      databaseName,
      tableName,
      columns,
      schemaName
    });
  }

  static async dropTable(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('drop_table', {
      connectionId,
      databaseName,
      tableName,
      schemaName
    });
  }

  // 数据库结构修改操作
  static async addColumn(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    column: ColumnModifySchema,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('add_column', {
      connectionId,
      databaseName,
      tableName,
      column,
      schemaName
    });
  }

  static async modifyColumn(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    column: ColumnModifySchema,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('modify_column', {
      connectionId,
      databaseName,
      tableName,
      column,
      schemaName
    });
  }

  static async deleteColumn(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    columnName: string,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('delete_column', {
      connectionId,
      databaseName,
      tableName,
      columnName,
      schemaName
    });
  }
  
  static async updateTableComment(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    comment: string,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('update_table_comment', {
      connectionId,
      databaseName,
      tableName,
      comment,
      schemaName
    });
  }
  
  static async getCreateTableStatement(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    schemaName?: string
  ): Promise<string> {
    return await invoke<string>('get_create_table_statement', {
      connectionId,
      databaseName,
      tableName,
      schemaName
    });
  }
  
  static async createIndex(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    indexName: string,
    columns: string[],
    isUnique: boolean,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('create_index', { 
      connectionId, 
      databaseName, 
      tableName, 
      indexName, 
      columns, 
      isUnique,
      schemaName 
    });
  }

  static async dropIndex(
    connectionId: string,
    databaseName: string | undefined,
    tableName: string,
    indexName: string,
    schemaName?: string
  ): Promise<QueryResult> {
    return await invoke<QueryResult>('drop_index', { 
      connectionId, 
      databaseName, 
      tableName, 
      indexName,
      schemaName 
    });
  }
  
  // 保存表数据更改
  static async saveTableData(
    connectionId: string,
    databaseName: string,
    tableName: string,
    schemaName: string | undefined,
    changes: {
      added: any[];
      modified: Array<{
        current: any;
        original: any;
      }>;
      deleted: any[];
      validate_only?: boolean;
      redis_atomic_batch?: boolean;
      redis_watch_keys?: boolean;
    }
  ): Promise<any> {
    return await invoke('save_table_data', {
      connectionId,
      databaseName,
      tableName,
      schemaName,
      changes
    });
  }

  static async importDatabaseFromSql(connectionId: string, databaseName: string, filePath: string) {
    return await invoke('import_database_from_sql_as_task', {
      connectionId,
      databaseName,
      filePath
    });
  }

  static async backupDatabase(
    connectionId: string,
    databaseName: string,
    tableNames: string[],
    exportPath?: string
  ) {
    return await invoke<string>('backup_database_as_task', {
      connectionId,
      databaseName,
      tableNames,
      exportPath: exportPath || null
    });
  }

  static async restoreDatabaseFromBackup(connectionId: string, databaseName: string, filePath: string) {
    return await invoke<string>('restore_database_from_backup_as_task', {
      connectionId,
      databaseName,
      filePath
    });
  }

  static async getBackupPlans(): Promise<BackupPlan[]> {
    return await invoke<BackupPlan[]>('dbm_get_backup_plans');
  }

  static async saveBackupPlans(plans: BackupPlan[]): Promise<BackupPlan[]> {
    return await invoke<BackupPlan[]>('dbm_save_backup_plans', { plans });
  }

  static async triggerBackupPlan(planId: string): Promise<string> {
    return await invoke<string>('dbm_trigger_backup_plan', { planId });
  }

  static async getBackupStorageInfo(path?: string): Promise<BackupStorageInfo> {
    return await invoke<BackupStorageInfo>('dbm_get_backup_storage_info', { path: path || null });
  }

  static async syncDatabasesAsTask(
    sourceConnectionId: string,
    sourceDatabaseName: string,
    targetConnectionId: string,
    targetDatabaseName: string,
    syncStructure: boolean,
    syncData: boolean,
    planToken?: string | null
  ): Promise<string> {
    return await invoke<string>('dbm_sync_databases_as_task', {
      sourceConnectionId,
      sourceDatabaseName,
      targetConnectionId,
      targetDatabaseName,
      syncStructure,
      syncData,
      planToken: planToken || null
    });
  }

  static async getSyncLogs(): Promise<DbSyncLog[]> {
    return await invoke<DbSyncLog[]>('dbm_get_sync_logs');
  }

  static async previewSyncPlan(
    sourceConnectionId: string,
    sourceDatabaseName: string,
    targetConnectionId: string,
    targetDatabaseName: string,
    syncStructure: boolean,
    syncData: boolean
  ): Promise<DbSyncPreviewResult> {
    return await invoke<DbSyncPreviewResult>('dbm_preview_sync_plan', {
      sourceConnectionId,
      sourceDatabaseName,
      targetConnectionId,
      targetDatabaseName,
      syncStructure,
      syncData
    });
  }

  static async importTableFromSql(
    connectionId: string,
    databaseName: string,
    tableName: string,
    filePath: string,
    schemaName?: string
  ) {
    return await invoke('import_table_from_sql_as_task', {
      connectionId,
      databaseName,
      tableName,
      schemaName,
      filePath
    });
  }

  static async importTableFromDataFile(
    connectionId: string,
    databaseName: string,
    tableName: string,
    filePath: string,
    columnMappings: Record<string, string | null>,
    schemaName?: string
  ) {
    return await invoke('import_table_from_data_file_as_task', {
      connectionId,
      databaseName,
      tableName,
      schemaName,
      filePath,
      columnMappings
    });
  }

  static async getFileHeaders(filePath: string) {
    const extension = filePath.split('.').pop()?.toLowerCase();
    let format: 'csv' | 'excel' | 'json' | 'sql' = 'csv';
    if (extension === 'xlsx' || extension === 'xls') {
      format = 'excel';
    } else if (extension === 'json') {
      format = 'json';
    } else if (extension === 'sql') {
      format = 'sql';
    }
    return await invoke<string[]>('get_file_headers', { filePath, format });
  }
}

// 工具函数
export const dbTypeLabels: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlserver: 'SQL Server',
  kingbasees: '人大金仓',
  dameng: '达梦',
  sqlite: 'SQLite',
  elasticsearch: 'Elasticsearch',
  clickhouse: 'ClickHouse',
  kafka: 'Kafka',
  snowflake: 'Snowflake',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle'
};

export function getDbTypeLabel(dbType: string): string {
  switch (dbType.toLowerCase()) {
    case 'mysql':
      return 'MySQL';
    case 'mariadb':
      return 'MariaDB';
    case 'postgresql':
      return 'PostgreSQL';
    case 'sqlserver':
      return 'SQL Server';
    case 'kingbasees':
      return '人大金仓';
    case 'dameng':
      return '达梦';
    case 'sqlite':
      return 'SQLite';
    case 'elasticsearch':
      return 'Elasticsearch';
    case 'clickhouse':
      return 'ClickHouse';
    case 'kafka':
      return 'Kafka';
    case 'snowflake':
      return 'Snowflake';
    case 'mongodb':
      return 'MongoDB';
    case 'redis':
      return 'Redis';
    case 'oracle':
      return 'Oracle';
    default:
      return dbType;
  }
}

export const formatExecutionTime = (milliseconds: number): string => {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  } else {
    return `${(milliseconds / 1000).toFixed(2)}s`;
  }
};

// 生成数据库连接字符串
export function generateConnectionString(connection: DbConnection): string {
  switch (connection.db_type) {
    case 'mysql':
      return `mysql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'mariadb':
      return `mariadb://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'postgresql':
      return `postgresql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'sqlserver':
      return `sqlserver://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'kingbasees':
      return `kingbasees://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'dameng':
      return connection.odbc?.connection_string || `odbc://${connection.host}:${connection.port}/${connection.database}`;
    case 'sqlite':
      return `sqlite://${connection.database}`;
    case 'elasticsearch':
      return `elasticsearch://${connection.host}:${connection.port}/${connection.database}`;
    case 'clickhouse':
      return `clickhouse://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'kafka':
      return `kafka://${connection.host}:${connection.port}/${connection.database || 'topics'}`;
    case 'snowflake':
      return `snowflake://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    case 'mongodb':
      return (() => {
        const auth = connection.username
          ? `${connection.username}:${connection.password}@`
          : '';
        const base = `mongodb://${auth}${connection.host}:${connection.port}/${connection.database}`;
        const params = new URLSearchParams();
        if (connection.mongodb?.auth_source?.trim()) {
          params.set('authSource', connection.mongodb.auth_source.trim());
        }
        if (connection.mongodb?.auth_mechanism?.trim()) {
          params.set('authMechanism', connection.mongodb.auth_mechanism.trim());
        }
        if (connection.mongodb?.replica_set?.trim()) {
          params.set('replicaSet', connection.mongodb.replica_set.trim());
        }
        if (connection.mongodb?.read_preference?.trim()) {
          params.set('readPreference', connection.mongodb.read_preference.trim());
        }
        if (typeof connection.mongodb?.retry_writes === 'boolean') {
          params.set('retryWrites', connection.mongodb.retry_writes ? 'true' : 'false');
        }
        if (connection.mongodb?.tls) {
          params.set('tls', 'true');
        }
        if (connection.mongodb?.tls_allow_invalid_certificates) {
          params.set('tlsAllowInvalidCertificates', 'true');
        }
        if (connection.mongodb?.tls_ca_file?.trim()) {
          params.set('tlsCAFile', connection.mongodb.tls_ca_file.trim());
        }
        if (connection.mongodb?.tls_certificate_key_file?.trim()) {
          params.set('tlsCertificateKeyFile', connection.mongodb.tls_certificate_key_file.trim());
        }
        if (connection.mongodb?.tls_certificate_key_file_password?.trim()) {
          params.set('tlsCertificateKeyFilePassword', connection.mongodb.tls_certificate_key_file_password.trim());
        }
        const query = params.toString();
        return query ? `${base}?${query}` : base;
      })();
    case 'redis':
      return `redis://${connection.password ? `:${connection.password}@` : ''}${connection.host}:${connection.port}/${connection.database || '0'}`;
    case 'oracle':
      return `oracle://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    default:
      return '';
  }
}

// 修改导入相关的API函数，使其返回任务ID
export async function importDatabaseFromSql(connectionId: string, databaseName: string, filePath: string) {
  try {
    const result = await DbmApi.importDatabaseFromSql(connectionId, databaseName, filePath);
    return result; // 返回任务ID
  } catch (error) {
    console.error('启动数据库导入任务失败:', error);
    throw error;
  }
}

export async function importTableFromSql(
  connectionId: string,
  databaseName: string,
  tableName: string,
  filePath: string,
  schemaName?: string
) {
  try {
    const result = await DbmApi.importTableFromSql(connectionId, databaseName, tableName, filePath, schemaName);
    return result; // 返回任务ID
  } catch (error) {
    console.error('启动表导入任务失败:', error);
    throw error;
  }
}

export async function importTableFromDataFile(
  connectionId: string, 
  databaseName: string, 
  tableName: string, 
  filePath: string, 
  columnMappings: Record<string, string | null>,
  schemaName?: string
) {
  try {
    const result = await DbmApi.importTableFromDataFile(
      connectionId,
      databaseName,
      tableName,
      filePath,
      columnMappings,
      schemaName
    );
    return result; // 返回任务ID
  } catch (error) {
    console.error('启动数据文件导入任务失败:', error);
    throw error;
  }
}

export async function getFileHeaders(filePath: string) {
  try {
    const result = await DbmApi.getFileHeaders(filePath);
    return result;
  } catch (error) {
    console.error('获取文件头部失败:', error);
    throw error;
  }
}

export async function getTables(
  connectionId: string,
  databaseName?: string,
  schemaName?: string
): Promise<string[]> {
  return await DbmApi.getTables(connectionId, databaseName, schemaName);
}

// 添加多表导出API函数
export async function exportMultipleTables(
  connectionId: string, 
  databaseName: string, 
  tableNames: string[], 
  format: 'csv' | 'json' | 'sql' | 'excel',
  exportPath?: string,
  schemaName?: string
) {
  try {
    const params = {
      connectionId,
      databaseName,
      schemaName,
      tableNames,
      format,
      useFilters: false,
      filters: {},
      remarks: `导出表 ${tableNames.join(', ')}`,
      exportPath: exportPath || null
    };
    
    const result = await invoke('export_multiple_tables', { params });
    return result; // 返回任务ID
  } catch (error) {
    console.error('启动多表导出任务失败:', error);
    throw error;
  }
}
