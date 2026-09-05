import type { Component } from 'vue';
import { markRaw } from 'vue';
import type { DbConnection } from './service';
import MariadbIcon from '@thesvg/vue/mariadb';
import MysqlIcon from '@thesvg/vue/mysql';
import PostgresqlIcon from '@thesvg/vue/postgresql';
import SqlserverIcon from '@thesvg/vue/microsoft-sql-server';
import SqliteIcon from '@thesvg/vue/sqlite';
import ElasticsearchIcon from '@thesvg/vue/elasticsearch';
import ClickhouseIcon from '@thesvg/vue/clickhouse';
import KafkaIcon from '@thesvg/vue/apache-kafka';
import SnowflakeIcon from '@thesvg/vue/snowflake';
import MongodbIcon from '@thesvg/vue/mongodb';
import RedisIcon from '@thesvg/vue/redis';
import OracleIcon from '@thesvg/vue/oracle';
import { t } from '@/platform/i18n';

export type DbTypeValue = DbConnection['db_type'];

export type DbTypeMeta = {
  label: string;
  value: DbTypeValue;
  logoText: string;
  logoBg: string;
  logoColor: string;
  iconComponent?: Component;
  iconProps?: Record<string, string | number | boolean>;
};

type DbTypeOptionSeed = Omit<DbTypeMeta, 'label'> & {
  labelKey: string;
  fallbackLabel: string;
};

const DB_TYPE_OPTION_SEEDS: DbTypeOptionSeed[] = [
  {
    labelKey: 'dbm.dbTypes.mysql',
    fallbackLabel: 'MySQL',
    value: 'mysql',
    logoText: 'My',
    logoBg: '#fef3e2',
    logoColor: '#d97706',
    iconComponent: markRaw(MysqlIcon),
    iconProps: {
      class: 'db-type-logo-mysql',
      style: '--db-type-logo-fill: #00758f',
    },
  },
  { labelKey: 'dbm.dbTypes.mariadb', fallbackLabel: 'MariaDB', value: 'mariadb', logoText: 'Ma', logoBg: '#ecfeff', logoColor: '#0f766e', iconComponent: markRaw(MariadbIcon) },
  { labelKey: 'dbm.dbTypes.postgresql', fallbackLabel: 'PostgreSQL', value: 'postgresql', logoText: 'PG', logoBg: '#e8f0ff', logoColor: '#2563eb', iconComponent: markRaw(PostgresqlIcon) },
  { labelKey: 'dbm.dbTypes.sqlserver', fallbackLabel: 'SQL Server', value: 'sqlserver', logoText: 'MS', logoBg: '#eef2ff', logoColor: '#4338ca', iconComponent: markRaw(SqlserverIcon) },
  { labelKey: 'dbm.dbTypes.kingbasees', fallbackLabel: 'KingbaseES', value: 'kingbasees', logoText: 'KB', logoBg: '#fef3c7', logoColor: '#b45309' },
  { labelKey: 'dbm.dbTypes.dameng', fallbackLabel: 'Dameng', value: 'dameng', logoText: 'DM', logoBg: '#fee2e2', logoColor: '#b91c1c' },
  { labelKey: 'dbm.dbTypes.sqlite', fallbackLabel: 'SQLite', value: 'sqlite', logoText: 'SQ', logoBg: '#e6f6ff', logoColor: '#0ea5e9', iconComponent: markRaw(SqliteIcon) },
  { labelKey: 'dbm.dbTypes.elasticsearch', fallbackLabel: 'Elasticsearch', value: 'elasticsearch', logoText: 'ES', logoBg: '#ecfccb', logoColor: '#65a30d', iconComponent: markRaw(ElasticsearchIcon), iconProps: { fill: '#65a30d' } },
  { labelKey: 'dbm.dbTypes.clickhouse', fallbackLabel: 'ClickHouse', value: 'clickhouse', logoText: 'CH', logoBg: '#fef3c7', logoColor: '#ca8a04', iconComponent: markRaw(ClickhouseIcon), iconProps: { fill: '#facc15' } },
  { labelKey: 'dbm.dbTypes.kafka', fallbackLabel: 'Kafka', value: 'kafka', logoText: 'KF', logoBg: '#f3f4f6', logoColor: '#111827', iconComponent: markRaw(KafkaIcon), iconProps: { fill: '#111827' } },
  { labelKey: 'dbm.dbTypes.snowflake', fallbackLabel: 'Snowflake', value: 'snowflake', logoText: 'SF', logoBg: '#e0f2fe', logoColor: '#0284c7', iconComponent: markRaw(SnowflakeIcon), iconProps: { fill: '#29b5e8' } },
  { labelKey: 'dbm.dbTypes.mongodb', fallbackLabel: 'MongoDB', value: 'mongodb', logoText: 'MG', logoBg: '#eafaf1', logoColor: '#16a34a', iconComponent: markRaw(MongodbIcon) },
  { labelKey: 'dbm.dbTypes.redis', fallbackLabel: 'Redis', value: 'redis', logoText: 'RD', logoBg: '#fef2f2', logoColor: '#dc2626', iconComponent: markRaw(RedisIcon) },
  { labelKey: 'dbm.dbTypes.oracle', fallbackLabel: 'Oracle', value: 'oracle', logoText: 'OR', logoBg: '#fff1f2', logoColor: '#e11d48', iconComponent: markRaw(OracleIcon) }
];

const FALLBACK_DB_TYPE_META_SEED: DbTypeOptionSeed = {
  labelKey: 'dbm.dbTypes.database',
  fallbackLabel: 'Database',
  value: 'mysql',
  logoText: 'DB',
  logoBg: '#f3f4f6',
  logoColor: '#4b5563'
};

const toDbTypeMeta = ({ labelKey, fallbackLabel, ...seed }: DbTypeOptionSeed): DbTypeMeta => ({
  ...seed,
  label: t(labelKey, undefined, fallbackLabel),
});

export const getDbTypeOptions = (): DbTypeMeta[] =>
  DB_TYPE_OPTION_SEEDS.map(toDbTypeMeta);

export const getDbTypeMeta = (dbType?: string): DbTypeMeta =>
  getDbTypeOptions().find((item) => item.value === dbType) || toDbTypeMeta(FALLBACK_DB_TYPE_META_SEED);
