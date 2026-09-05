/**
 * The wire protocol and the statement splitter.
 *
 * These two modules are where a mistake is silent rather than loud: a validator
 * that lets a quote through produces a broken statement three layers away, and a
 * splitter that mishandles a quoted semicolon runs half a statement. Both are pure
 * functions, so both get exercised directly.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  boundedInt,
  classifyConnectionError,
  connectionErrorMessage,
  DbmError,
  ERR,
  optionalIdentifier,
  requireDbType,
  requireIdentifier,
  requireText,
  statusOf,
} from '../src/shared/protocol.js'
import {
  assertReadOnly,
  isCommentOnly,
  leadingKeyword,
  previewOf,
  returnsRows,
  splitStatements,
} from '../src/host/sql/split.js'

describe('protocol', () => {
  it('accepts every engine the panel offers', () => {
    for (const dbType of ['mysql', 'MariaDB', 'postgresql', 'sqlite', 'redis', 'oracle']) {
      assert.equal(typeof requireDbType(dbType), 'string')
    }
    assert.throws(() => requireDbType('mssql'), /不支持的数据库类型/)
  })

  it('refuses identifiers that could break out of quoting', () => {
    assert.equal(requireIdentifier('users', '表名'), 'users')
    assert.equal(requireIdentifier('  用户表  ', '表名'), '用户表')
    // A space is fine: the dialect quotes every identifier, and refusing spaces
    // would lock out real tables (Northwind's `Order Details`).
    assert.equal(requireIdentifier('Order Details', '表名'), 'Order Details')
    for (const bad of ['a"b', "a'b", 'a`b', 'a;b', 'a\nb', 'a\\b']) {
      assert.throws(() => requireIdentifier(bad, '表名'), /不允许的字符/, `should refuse ${JSON.stringify(bad)}`)
    }
    assert.throws(() => requireIdentifier('', '表名'), /不能为空/)
  })

  it('treats an empty optional identifier as absent', () => {
    assert.equal(optionalIdentifier(undefined, '库名'), undefined)
    assert.equal(optionalIdentifier('   ', '库名'), undefined)
    assert.equal(optionalIdentifier('shop', '库名'), 'shop')
    assert.throws(() => optionalIdentifier('sh"op', '库名'), /不允许的字符/)
  })

  it('bounds integers instead of trusting them', () => {
    assert.equal(boundedInt('50', 10, 1, 100), 50)
    assert.equal(boundedInt(9999, 10, 1, 100), 100)
    assert.equal(boundedInt(-5, 10, 1, 100), 1)
    assert.equal(boundedInt('nonsense', 10, 1, 100), 10)
    assert.equal(boundedInt(undefined, 10, 1, 100), 10)
  })

  it('caps very long text', () => {
    assert.equal(requireText('  select 1  ', 'SQL'), 'select 1')
    assert.throws(() => requireText('x'.repeat(5000), 'SQL', { max: 100 }), /过长/)
  })

  it('maps codes to HTTP statuses', () => {
    assert.equal(statusOf(ERR.invalidInput), 400)
    assert.equal(statusOf(ERR.notFound), 404)
    assert.equal(statusOf(ERR.conflict), 409)
    assert.equal(statusOf(ERR.driverMissing), 501)
    assert.equal(statusOf(ERR.timeout), 504)
    assert.equal(statusOf('anything else'), 500)
  })

  it('classifies driver errors into the four kinds the panel localizes', () => {
    assert.equal(classifyConnectionError({ code: 'ETIMEDOUT' }), 'TIMEOUT')
    assert.equal(classifyConnectionError({ code: 'ENOTFOUND' }), 'DNS')
    assert.equal(classifyConnectionError({ message: 'ER_ACCESS_DENIED_ERROR: Access denied' }), 'AUTH')
    assert.equal(classifyConnectionError({ message: 'self signed certificate' }), 'TLS')
    assert.equal(classifyConnectionError(new Error('something odd')), 'UNKNOWN')
  })

  it('formats a connection failure in the shape the panel already localizes', () => {
    const message = connectionErrorMessage('mysql', 'AUTH', 'Access denied for user')
    assert.match(message, /^\[DBM_MYSQL_CONN_AUTH\] /)
    // An engine the humanizer has no table for keeps its raw message.
    assert.equal(connectionErrorMessage('nonsense', 'AUTH', 'x'), 'x')
  })

  it('carries its code on the error object', () => {
    const error = new DbmError(ERR.notFound, '连接不存在: 1')
    assert.equal(error.code, ERR.notFound)
    assert.match(error.message, /连接不存在/)
  })
})

describe('statement splitting', () => {
  it('splits on semicolons outside literals', () => {
    const statements = splitStatements('SELECT 1; SELECT 2;')
    assert.deepEqual(statements.map((row) => row.sql), ['SELECT 1', 'SELECT 2'])
  })

  it('keeps a semicolon inside a string in one statement', () => {
    const statements = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")
    assert.equal(statements.length, 2)
    assert.match(statements[0].sql, /'a;b'/)
  })

  it('understands doubled-quote escapes', () => {
    const statements = splitStatements("SELECT 'it''s; fine'; SELECT 2")
    assert.equal(statements.length, 2)
    assert.match(statements[0].sql, /it''s; fine/)
  })

  it('understands MySQL backslash escapes only where they exist', () => {
    const mysql = splitStatements("SELECT 'a\\'; b'", { dbType: 'mysql' })
    assert.equal(mysql.length, 1, 'MySQL treats \\\' as an escaped quote')

    // Postgres does NOT, so the quote closes and the semicolon splits.
    const postgres = splitStatements("SELECT 'a\\'; b'", { dbType: 'postgresql' })
    assert.equal(postgres.length, 2)
  })

  it('keeps a dollar-quoted body whole', () => {
    const script = `
      CREATE FUNCTION f() RETURNS int AS $$
      BEGIN
        RAISE NOTICE 'one; two';
        RETURN 1;
      END;
      $$ LANGUAGE plpgsql;
      SELECT f();
    `
    const statements = splitStatements(script, { dbType: 'postgresql' })
    assert.equal(statements.length, 2)
    assert.match(statements[0].sql, /LANGUAGE plpgsql$/)
  })

  it('honours DELIMITER for a MySQL routine', () => {
    const script = `
DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END$$
DELIMITER ;
SELECT 3;
`
    const statements = splitStatements(script, { dbType: 'mysql' })
    assert.equal(statements.length, 2)
    assert.match(statements[0].sql, /CREATE PROCEDURE/)
    assert.match(statements[0].sql, /SELECT 2;/, 'the body keeps its own semicolons')
    assert.equal(statements[1].sql, 'SELECT 3')
  })

  it("honours Oracle's lone slash terminator", () => {
    const script = `
CREATE OR REPLACE PROCEDURE p AS
BEGIN
  NULL;
END;
/
SELECT 1 FROM dual;
`
    const statements = splitStatements(script, { dbType: 'oracle' })
    assert.equal(statements.length, 2)
    assert.match(statements[0].sql, /END;$/)
  })

  it('drops comment-only statements but keeps leading comments attached', () => {
    const statements = splitStatements('-- just a note\n;\n/* another */\nSELECT 1;')
    assert.equal(statements.length, 1)
    assert.match(statements[0].sql, /SELECT 1/)
  })

  it('does not split on a semicolon inside a bracketed identifier', () => {
    const statements = splitStatements('SELECT * FROM [odd;name]; SELECT 1')
    assert.equal(statements.length, 2)
  })

  it('recognizes reads and writes', () => {
    assert.equal(returnsRows('SELECT 1'), true)
    assert.equal(returnsRows('  with x as (select 1) select * from x'), true)
    assert.equal(returnsRows('SHOW TABLES'), true)
    assert.equal(returnsRows('PRAGMA table_info(t)'), true)
    assert.equal(returnsRows('UPDATE t SET a = 1'), false)
    assert.equal(returnsRows('INSERT INTO t VALUES (1) RETURNING id'), true)
    assert.equal(leadingKeyword('/* hi */ select 1'), 'SELECT')
    assert.equal(isCommentOnly('-- nothing\n/* here */'), true)
  })

  it('previews long SQL on one line', () => {
    const preview = previewOf('SELECT\n  a,\n  b\nFROM t')
    assert.equal(preview, 'SELECT a, b FROM t')
    assert.equal(previewOf('x'.repeat(200)).length, 121)
  })
})

describe('AI dashboard read-only guard', () => {
  it('allows a single read', () => {
    assert.equal(assertReadOnly('SELECT count(*) FROM orders;'), 'SELECT count(*) FROM orders')
    assert.equal(typeof assertReadOnly('WITH x AS (SELECT 1) SELECT * FROM x'), 'string')
  })

  it('refuses writes and DDL', () => {
    for (const sql of [
      'DELETE FROM orders',
      'UPDATE orders SET total = 0',
      'DROP TABLE orders',
      'INSERT INTO orders VALUES (1)',
      'TRUNCATE TABLE orders',
      'GRANT ALL ON orders TO bob',
    ]) {
      assert.throws(() => assertReadOnly(sql), /只允许执行/, `should refuse ${sql}`)
    }
  })

  it('refuses a second statement smuggled in after the read', () => {
    assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE orders'), /单条只读/)
    assert.throws(() => assertReadOnly('SELECT 1;DELETE FROM t;'), /单条只读/)
  })

  it('sees through a leading comment', () => {
    assert.throws(() => assertReadOnly('/* SELECT */ DELETE FROM t'), /只允许执行/)
    assert.throws(() => assertReadOnly('-- SELECT\nDROP TABLE t'), /只允许执行/)
  })
})
