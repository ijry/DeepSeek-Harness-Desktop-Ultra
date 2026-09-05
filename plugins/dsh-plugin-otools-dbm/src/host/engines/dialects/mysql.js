/**
 * MySQL / MariaDB.
 *
 * The reference dialect for this port: every other dialect in this directory is a
 * variation on it, and the panel's own defaults (backtick quoting, `LIMIT n OFFSET
 * m`, column comments inline in the DDL) are MySQL's.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/mysql
 */
import { SqlDialect } from '../sql-dialect.js'

export class MysqlDialect extends SqlDialect {
  get dbType() {
    return 'mysql'
  }

  showDatabases() {
    return `SELECT schema_name AS name FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
      ORDER BY schema_name`
  }

  showTables(database) {
    return `SELECT table_name AS name FROM information_schema.tables
      WHERE ${this.catalogFilter(database)} AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  }

  showViews(database) {
    return `SELECT table_name AS name FROM information_schema.views
      WHERE ${this.catalogFilter(database)} ORDER BY table_name`
  }

  showProcedures(database) {
    return `SELECT routine_name AS name FROM information_schema.routines
      WHERE ${this.routineFilter(database)} ORDER BY routine_name`
  }

  showColumns(database, table) {
    return `SELECT
        column_name AS name,
        data_type AS data_type,
        column_type AS full_type,
        is_nullable AS is_nullable,
        column_default AS default_value,
        CASE WHEN column_key = 'PRI' THEN 1 ELSE 0 END AS is_primary_key,
        character_maximum_length AS character_maximum_length,
        column_comment AS column_comment,
        extra AS extra
      FROM information_schema.columns
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(table)}
      ORDER BY ordinal_position`
  }

  showPrimaryKeys(database, table) {
    return `SELECT column_name AS column_name FROM information_schema.key_column_usage
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(table)}
        AND constraint_name = 'PRIMARY'
      ORDER BY ordinal_position`
  }

  showForeignKeys(database, table) {
    return `SELECT
        constraint_name AS constraint_name,
        column_name AS column_name,
        referenced_table_schema AS referenced_schema,
        referenced_table_name AS referenced_table,
        referenced_column_name AS referenced_column
      FROM information_schema.key_column_usage
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(table)}
        AND referenced_table_name IS NOT NULL
      ORDER BY constraint_name, ordinal_position`
  }

  showIndexes(database, table) {
    return `SELECT
        index_name AS name,
        column_name AS column_name,
        CASE WHEN non_unique = 0 THEN 1 ELSE 0 END AS is_unique
      FROM information_schema.statistics
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(table)}
      ORDER BY index_name, seq_in_index`
  }

  showTableComment(database, table) {
    return `SELECT table_comment AS comment FROM information_schema.tables
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(table)}`
  }

  showCreateTable(database, table) {
    return `SHOW CREATE TABLE ${this.qualify({ database, table })}`
  }

  viewSource(database, view) {
    return `SELECT view_definition AS definition FROM information_schema.views
      WHERE ${this.catalogFilter(database)} AND table_name = ${this.literal(view)}`
  }

  procedureSource(database, procedure) {
    return `SELECT routine_definition AS definition, routine_type AS routine_type,
        routine_name AS routine_name
      FROM information_schema.routines
      WHERE ${this.routineFilter(database)} AND routine_name = ${this.literal(procedure)}`
  }

  stats() {
    return `SELECT
        table_schema AS database_name,
        COUNT(*) AS table_count,
        COALESCE(SUM(table_rows), 0) AS row_count,
        COALESCE(SUM(data_length), 0) AS data_size,
        COALESCE(SUM(index_length), 0) AS index_size
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
      GROUP BY table_schema
      ORDER BY table_schema`
  }

  // -------------------------------------------------------------------- DDL
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'VARCHAR(255)'
    }
    // A type the designer already spelled out in full (`varchar(64)`, `decimal(10,2)`)
    // is used as written; the length box only applies to bare char/varchar/binary.
    if (/[(]/.test(type)) {
      return type
    }
    const length = Number(column?.character_maximum_length)
    if (Number.isFinite(length) && length > 0 && /^(var)?(char|binary)$/i.test(type)) {
      return `${type.toUpperCase()}(${length})`
    }
    return type
  }

  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    parts.push(column.is_nullable === false ? 'NOT NULL' : 'NULL')
    const fallback = column.default_value
    if (fallback !== undefined && fallback !== null && String(fallback).length > 0) {
      parts.push(`DEFAULT ${this.defaultExpression(fallback)}`)
    }
    if (column.auto_increment === true) {
      parts.push('AUTO_INCREMENT')
    }
    const comment = column.column_comment
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      parts.push(`COMMENT ${this.literal(comment)}`)
    }
    return parts.join(' ')
  }

  /**
   * A DEFAULT the designer typed.
   *
   * Users type both `0` and `hello`; the first must not be quoted and the second
   * must be. Anything that looks like a number, a boolean, NULL, a function call
   * or an already-quoted literal is passed through, everything else is quoted.
   */
  defaultExpression(value) {
    const text = String(value).trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text
    }
    if (/^(null|true|false|current_timestamp(\(\d*\))?|now\(\))$/i.test(text)) {
      return text.toUpperCase()
    }
    if (/^'.*'$/.test(text) || /^".*"$/.test(text)) {
      return text
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(.*\)$/.test(text)) {
      return text
    }
    return this.literal(text)
  }

  createTable({ database, schema, table, columns, comment }) {
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    const tail = comment !== undefined && comment !== null && String(comment).length > 0
      ? ` COMMENT = ${this.literal(comment)}`
      : ''
    return [
      `CREATE TABLE ${this.qualify({ database, schema, table })} (\n  ${body.join(',\n  ')}\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4${tail}`,
    ]
  }

  modifyColumn({ database, schema, table, column }) {
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    const target = this.qualify({ database, schema, table })
    if (from !== column.name) {
      return [`ALTER TABLE ${target} CHANGE COLUMN ${this.quote(from)} ${this.columnDefinition(column)}`]
    }
    return [`ALTER TABLE ${target} MODIFY COLUMN ${this.columnDefinition(column)}`]
  }

  setTableComment({ database, schema, table, comment }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} COMMENT = ${this.literal(comment ?? '')}`]
  }

  dropIndex({ database, schema, table, index }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} DROP INDEX ${this.quote(index)}`]
  }

  createDatabase(database) {
    return [`CREATE DATABASE ${this.quote(database)} DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci`]
  }
}

/** MariaDB speaks MySQL; only the label differs. */
export class MariadbDialect extends MysqlDialect {
  get dbType() {
    return 'mariadb'
  }
}
