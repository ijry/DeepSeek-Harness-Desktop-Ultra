/**
 * SQLite.
 *
 * The odd one out in this directory: a database is a file, not a server, and that
 * runs through everything below.
 *
 * - There is exactly one database ('main') and no schemas, so `useDatabase` is null,
 *   `qualify` prints the bare table name, and CREATE/DROP DATABASE are refusals —
 *   making a database here means opening a path, which is the connection layer's
 *   job and not SQL's.
 * - Introspection is PRAGMA, not information_schema. What makes it look like the
 *   other dialects is the pragma table-valued functions (`pragma_table_info(…)`,
 *   SQLite 3.16+); the table name goes in as a string literal because a pragma
 *   argument cannot be a bind parameter.
 * - ALTER TABLE only knows ADD COLUMN, RENAME and — since 3.35 — DROP COLUMN, and
 *   an added column may not be NOT NULL without a default. `modifyColumn` therefore
 *   refuses rather than quietly running the twelve-step rebuild from the SQLite
 *   docs: doing that behind a designer's Save button is how data goes missing.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/sqlite
 */
import { SqlDialect } from '../sql-dialect.js'

export class SqliteDialect extends SqlDialect {
  get dbType() {
    return 'sqlite'
  }

  quote(name) {
    return `"${String(name).replace(/"/g, '""')}"`
  }

  /** SQLite has no backslash escapes in string literals; only the quote doubles. */
  literal(value) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  /** Just the table — one file is one database, with nothing to hang it under. */
  qualify({ table } = {}) {
    return table === undefined || table === null || String(table).length === 0 ? '' : this.quote(table)
  }

  /** Nothing — the database is the file the connection already opened. */
  useDatabase() {
    return null
  }

  // ------------------------------------------------------------ introspection
  /** One database per file, and `main` is SQLite's own name for it. */
  showDatabases() {
    return `SELECT 'main' AS name`
  }

  showTables() {
    return `SELECT name AS name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  }

  showViews() {
    return `SELECT name AS name FROM sqlite_master
      WHERE type = 'view' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  }

  /** Nothing: SQLite has no stored routines. The engine reads null as an empty list. */
  showProcedures() {
    return null
  }

  /**
   * `pragma_table_info` is a table-valued function, so a pragma can be selected
   * from and ordered like any other row source. `notnull` needs quoting because it
   * is a keyword; `type` is the text the CREATE TABLE declared, which is also all
   * SQLite itself knows about the type, so `data_type` and `full_type` are the same
   * string and there is no length to report separately.
   */
  showColumns(_database, table) {
    return `SELECT
        name AS name,
        type AS data_type,
        type AS full_type,
        CASE WHEN "notnull" = 0 THEN 'YES' ELSE 'NO' END AS is_nullable,
        dflt_value AS default_value,
        pk AS is_primary_key,
        NULL AS character_maximum_length,
        '' AS column_comment
      FROM pragma_table_info(${this.literal(table)})
      ORDER BY cid`
  }

  /** `pk` is not a flag but the column's 1-based position in the key, so it sorts. */
  showPrimaryKeys(_database, table) {
    return `SELECT name AS column_name FROM pragma_table_info(${this.literal(table)})
      WHERE pk > 0 ORDER BY pk`
  }

  /**
   * SQLite foreign keys carry no name, so the id the pragma hands out becomes one:
   * the panel only needs a stable key to group the columns of one constraint under.
   * `from`, `to` and `table` are all keywords, hence the quoting, and a `to` of NULL
   * means "the parent's primary key", which the pragma does not resolve for us.
   */
  showForeignKeys(_database, table) {
    return `SELECT
        'fk_' || CAST(fk.id AS TEXT) AS constraint_name,
        fk."from" AS column_name,
        NULL AS referenced_schema,
        fk."table" AS referenced_table,
        fk."to" AS referenced_column
      FROM pragma_foreign_key_list(${this.literal(table)}) fk
      ORDER BY fk.id, fk.seq`
  }

  /**
   * One row per indexed column, which takes both pragmas: `pragma_index_list` knows
   * the index and whether it is unique, `pragma_index_info` knows the columns. The
   * second one is called with a value from the first, which SQLite allows because a
   * table-valued function reads its argument like a lateral join would.
   *
   * A column name of NULL is an expression or the rowid; the panel skips those rows.
   */
  showIndexes(_database, table) {
    return `SELECT
        il.name AS name,
        ii.name AS column_name,
        il."unique" AS is_unique
      FROM pragma_index_list(${this.literal(table)}) il, pragma_index_info(il.name) ii
      ORDER BY il.name, ii.seqno`
  }

  /** Nothing: SQLite stores no comments, on a table or on a column. */
  showTableComment() {
    return null
  }

  /** The CREATE TABLE text, kept verbatim — the only engine here that hands it back. */
  showCreateTable(_database, table) {
    return `SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = ${this.literal(table)}`
  }

  viewSource(_database, view) {
    return `SELECT sql AS definition FROM sqlite_master
      WHERE type = 'view' AND name = ${this.literal(view)}`
  }

  /**
   * One row, because a file is one database.
   *
   * `page_count * page_size` is the whole file — tables, indexes and free pages
   * together — and splitting it needs the optional `dbstat` module, so it is
   * reported as `data_size` with `index_size` left at 0. `row_count` is 0 for a
   * related reason: SQLite keeps no row estimates anywhere, and a real count would
   * be one extra statement per table.
   */
  stats() {
    return `SELECT
        'main' AS database_name,
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS table_count,
        0 AS row_count,
        (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()) AS data_size,
        0 AS index_size`
  }

  // -------------------------------------------------------------------- DDL
  /**
   * SQLite stores the declared type as written and only reads a type affinity out of
   * it, so passing the designer's text through is not laziness: `VARCHAR(64)` and
   * `TEXT` behave identically, and the text is what the next reader of the schema
   * sees. The length is still appended when the designer typed one, for that reason.
   */
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'TEXT'
    }
    if (/[(]/.test(type)) {
      return type
    }
    const length = Number(column?.character_maximum_length)
    if (Number.isFinite(length) && length > 0 && /^(var)?char$/i.test(type)) {
      return `${type.toUpperCase()}(${length})`
    }
    return type
  }

  /**
   * No AUTOINCREMENT on purpose: it is only legal on an `INTEGER PRIMARY KEY`, and a
   * lone INTEGER primary key is already an alias for the rowid, which hands out
   * increasing ids by itself. Also no COMMENT — there is nowhere to keep one.
   */
  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    parts.push(column.is_nullable === false ? 'NOT NULL' : 'NULL')
    const fallback = column.default_value
    if (fallback !== undefined && fallback !== null && String(fallback).length > 0) {
      parts.push(`DEFAULT ${this.defaultExpression(fallback)}`)
    }
    return parts.join(' ')
  }

  /**
   * A DEFAULT the designer typed.
   *
   * The same quoting problem as MySQL (`0` bare, `hello` quoted) plus one SQLite
   * rule that is easy to miss: a DEFAULT that is not a literal has to be
   * parenthesised, so `datetime('now')` becomes `DEFAULT (datetime('now'))` or
   * SQLite rejects the CREATE TABLE outright.
   */
  defaultExpression(value) {
    const text = String(value).trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text
    }
    if (/^(null|true|false|current_timestamp|current_date|current_time)$/i.test(text)) {
      return text.toUpperCase()
    }
    if (/^'.*'$/.test(text) || /^\(.*\)$/.test(text)) {
      return text
    }
    if (/^[A-Za-z_]\w*\s*\(.*\)$/.test(text)) {
      return `(${text})`
    }
    return this.literal(text)
  }

  /**
   * SQLite only learned DROP COLUMN in 3.35 (2021), and an older file answers with a
   * syntax error. The statement is offered anyway rather than version-gated here: the
   * dialect layer has no connection to ask, and SQLite's own refusal is clearer than
   * a guess would be.
   */
  dropColumn({ database, schema, table, column }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} DROP COLUMN ${this.quote(column)}`]
  }

  /**
   * Refused.
   *
   * Changing a column in SQLite means the twelve-step rebuild from the docs: create a
   * new table, copy the rows, drop the old one, rename, then re-create every index,
   * trigger and view that pointed at it. Doing that silently under a Save button
   * risks the data, so the panel says no and lets the user write the migration.
   */
  modifyColumn() {
    return this.unsupported('修改字段（SQLite 需要重建表）')
  }

  /** Refused: SQLite has nowhere to keep a comment. */
  setTableComment() {
    return this.unsupported('修改表注释')
  }

  /** Index names are file-global in SQLite, so DROP INDEX takes no table. */
  dropIndex({ index }) {
    return [`DROP INDEX ${this.quote(index)}`]
  }

  /** No TRUNCATE in SQLite; a WHERE-less DELETE is the documented equivalent. */
  truncateTable({ database, schema, table }) {
    return [`DELETE FROM ${this.qualify({ database, schema, table })}`]
  }

  /** Refused: a database is a file, and making one is the connection layer's job. */
  createDatabase() {
    return this.unsupported('创建数据库')
  }

  /** Refused for the same reason: deleting the file is not something SQL can do. */
  dropDatabase() {
    return this.unsupported('删除数据库')
  }
}
