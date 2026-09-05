/**
 * Splitting a script into statements.
 *
 * Every naive `sql.split(';')` breaks on the first semicolon inside a string
 * literal, and the workbench sends whole editor buffers. This is a character
 * scanner instead, and it knows the four things that actually bite:
 *
 * - single/double-quoted strings, backtick and `[bracket]` identifiers, with
 *   doubled-quote escapes (`'it''s'`) and backslash escapes where the dialect has
 *   them (MySQL does, Postgres does not by default);
 * - `--`, `#` and `/* *\/` comments;
 * - Postgres/Kingbase dollar quoting (`$$ … $$`, `$body$ … $body$`), without which
 *   any function body splits into rubbish;
 * - `DELIMITER $$` (MySQL routines) and a lone `/` on its own line
 *   (Oracle/Dameng routines), which are how those dialects say "the statement ends
 *   here, ignore the semicolons inside it".
 *
 * @module dsh-plugin-otools-dbm/host/sql/split
 */

import { DbmError, ERR } from '../../shared/protocol.js'

/** Dialect families with distinct lexing rules. */
const BACKSLASH_ESCAPES = new Set(['mysql', 'mariadb', 'clickhouse'])
const DOLLAR_QUOTES = new Set(['postgresql', 'kingbasees'])
const SLASH_TERMINATOR = new Set(['oracle', 'dameng'])

/**
 * @param script - the whole text.
 * @param options.dbType - engine name; picks the lexing quirks.
 * @returns array of `{ sql, index }`, comments and empty statements dropped.
 */
export function splitStatements(script, options = {}) {
  const text = String(script ?? '')
  const dbType = String(options.dbType ?? '').toLowerCase()
  const backslash = BACKSLASH_ESCAPES.has(dbType)
  const dollar = DOLLAR_QUOTES.has(dbType)
  const slashEnds = SLASH_TERMINATOR.has(dbType)

  const statements = []
  let buffer = ''
  let delimiter = ';'
  let index = 0

  const flush = () => {
    const sql = buffer.trim()
    buffer = ''
    if (sql.length === 0) {
      return
    }
    statements.push({ sql, index: index++ })
  }

  let position = 0
  let atLineStart = true

  while (position < text.length) {
    const char = text[position]
    const rest = text.slice(position)

    // DELIMITER directive: only meaningful at the start of a line.
    if (atLineStart) {
      const match = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(rest)
      if (match !== null) {
        flush()
        delimiter = match[1]
        position += match[0].length
        atLineStart = true
        continue
      }
      if (slashEnds) {
        const slash = /^[ \t]*\/[ \t]*(?:\r?\n|$)/.exec(rest)
        if (slash !== null) {
          flush()
          position += slash[0].length
          atLineStart = true
          continue
        }
      }
    }

    // Line comment.
    if (rest.startsWith('--') || char === '#') {
      const end = text.indexOf('\n', position)
      const stop = end === -1 ? text.length : end
      buffer += text.slice(position, stop)
      position = stop
      atLineStart = false
      continue
    }

    // Block comment.
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', position + 2)
      const stop = end === -1 ? text.length : end + 2
      buffer += text.slice(position, stop)
      position = stop
      atLineStart = false
      continue
    }

    // Dollar-quoted body.
    if (dollar && char === '$') {
      const tag = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/.exec(rest)
      if (tag !== null) {
        const marker = tag[0]
        const end = text.indexOf(marker, position + marker.length)
        const stop = end === -1 ? text.length : end + marker.length
        buffer += text.slice(position, stop)
        position = stop
        atLineStart = false
        continue
      }
    }

    // Quoted literal or identifier.
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      let cursor = position + 1
      buffer += char
      while (cursor < text.length) {
        const inner = text[cursor]
        if (backslash && inner === '\\' && cursor + 1 < text.length) {
          buffer += inner + text[cursor + 1]
          cursor += 2
          continue
        }
        if (inner === close) {
          // A doubled closer is an escaped closer, not the end.
          if (text[cursor + 1] === close) {
            buffer += inner + close
            cursor += 2
            continue
          }
          buffer += inner
          cursor += 1
          break
        }
        buffer += inner
        cursor += 1
      }
      position = cursor
      atLineStart = false
      continue
    }

    // Statement delimiter.
    if (text.startsWith(delimiter, position)) {
      // Oracle and Dameng use `;` both to end a statement and to end a line
      // INSIDE a PL/SQL block, so a routine body would otherwise be chopped into
      // fragments. In those dialects a block is terminated only by a lone `/`,
      // which is exactly what SQL*Plus does.
      if (slashEnds && delimiter === ';' && inPlSqlBlock(buffer)) {
        buffer += text.slice(position, position + delimiter.length)
        position += delimiter.length
        atLineStart = false
        continue
      }
      position += delimiter.length
      flush()
      atLineStart = false
      continue
    }

    buffer += char
    atLineStart = char === '\n'
    position += 1
  }

  flush()
  return statements.filter((statement) => !isCommentOnly(statement.sql))
}

/** Whether a statement is nothing but comments and whitespace. */
export function isCommentOnly(sql) {
  const stripped = String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*(--|#).*$/gm, ' ')
    .trim()
  return stripped.length === 0
}

/**
 * Whether the text so far opened a PL/SQL block, in which `;` is punctuation.
 *
 * Deliberately shallow: it looks at what the statement STARTS with rather than
 * counting BEGIN/END pairs, because a `BEGIN` inside a string or a comment would
 * throw a counter off and the failure mode of over-counting (one huge statement) is
 * worse than the failure mode of this (a `;` kept inside an anonymous block).
 */
function inPlSqlBlock(buffer) {
  const head = String(buffer ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*--.*$/gm, ' ')
    .trimStart()
  if (/^(declare|begin)\b/i.test(head)) {
    return true
  }
  return /^create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type)\b/i.test(head)
}

/** The first keyword of a statement, upper-cased (`SELECT`, `INSERT`, `WITH`…). */
export function leadingKeyword(sql) {
  const stripped = String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*(--|#).*$/gm, ' ')
    .replace(/^[\s(]+/, '')
  const match = /^([A-Za-z_]+)/.exec(stripped)
  return match === null ? '' : match[1].toUpperCase()
}

/** Whether a statement returns rows rather than an affected-row count. */
export function returnsRows(sql) {
  const keyword = leadingKeyword(sql)
  if (['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'PRAGMA', 'VALUES', 'TABLE', 'CALL'].includes(keyword)) {
    return true
  }
  // `INSERT … RETURNING` / `UPDATE … RETURNING` (Postgres family) do too.
  return /\breturning\b/i.test(String(sql ?? ''))
}

/** A short single-line preview, as the workbench's statement list shows it. */
export function previewOf(sql, limit = 120) {
  const text = String(sql ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * The AI dashboard may only read.
 *
 * The generated dashboard code runs in the browser and sends whatever SQL the model
 * wrote, so this is the only thing standing between a hallucinated `DROP TABLE` and
 * a real database. One statement, and its first keyword must be a read. Comments
 * are stripped first, because `/* SELECT *\/ DELETE FROM t` starts with neither.
 */
export function assertReadOnly(sql) {
  const stripped = String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*(--|#).*$/gm, ' ')
    .trim()
  const single = stripped.replace(/;\s*$/, '')
  if (single.includes(';')) {
    throw new DbmError(ERR.invalidInput, 'AI 大屏只允许执行单条只读 SQL')
  }
  const keyword = leadingKeyword(single)
  const allowed = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES']
  if (!allowed.includes(keyword)) {
    throw new DbmError(ERR.invalidInput, 'AI 大屏只允许执行 SELECT/WITH/SHOW/EXPLAIN/PRAGMA 等只读 SQL')
  }
  return single
}
