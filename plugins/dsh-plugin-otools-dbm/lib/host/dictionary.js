/**
 * The data dictionary: every table's structure in one .docx.
 *
 * Unlike an export this is NOT a background task — the panel awaits the command and
 * shows a progress bar fed by `dbm-dictionary-export-progress` events, so the stage
 * names and percentages below are a contract with `DbDataDictionaryDialog.vue` and
 * not decoration. A run with no `progressToken` (an agent calling the tool directly,
 * say) emits nothing, because nobody is listening for it.
 *
 * The document is built in memory: `docx` has no streaming writer, and a structure
 * dump is small — a 500-table dictionary is a few megabytes of text, where the same
 * number of DATA rows would not fit. If that ever stops being true, the fix is to
 * split the document per schema rather than to stream it.
 *
 * @module dsh-plugin-otools-dbm/host/dictionary
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { optionalIdentifier, requireText } from '../shared/protocol.js'

import { formatDate } from './engines/result.js'
import { requireAbsolute } from './fs.js'
import { allTableStructs } from './schema.js'
import { writeFileAtomic } from './sdk.js'

/** The event `DbDataDictionaryDialog.vue` listens for. */
const PROGRESS_EVENT = 'dbm-dictionary-export-progress'

/** SimSun: Word's default has no CJK glyphs, so it substitutes per glyph. */
const FONT = 'SimSun'

/** Half-points, because that is the unit OOXML measures a run in. */
const SIZE = { title: 32, heading: 26, subheading: 22, body: 22, cell: 18, footer: 18 }

/** What an empty cell shows, so no TableCell is ever childless. */
const EMPTY = '-'

/**
 * `export_data_dictionary_docx`: write the dictionary and return the file's path.
 *
 * @param context - the host context; `store`, `connections` and `emit` are used.
 * @param options.outputPath - absolute path the panel's save dialog produced.
 * @param options.progressToken - the panel's per-run token; no token, no events.
 */
export async function exportDataDictionaryDocx(
  context,
  { connectionId, outputPath, databaseName, schemaName, progressToken },
) {
  const id = requireText(connectionId, '连接 ID')
  const database = optionalIdentifier(databaseName, '数据库名')
  const schema = optionalIdentifier(schemaName, 'Schema 名')
  const target = docxPath(outputPath)
  const report = progressReporter(context, progressToken)

  // Fail on an impossible directory now, not after a minute of reading structures.
  await mkdir(dirname(target), { recursive: true })
  report('preparing', 3, '正在准备导出任务...')

  const connection = await context.store.require(id)
  report('loading_tables', 12, '正在加载表列表和结构信息...')

  const structs = await context.connections.with(id, (engine) =>
    allTableStructs(engine, { connectionId: id, database, schema, force: false }),
  )
  const total = structs.length
  report('tables_loaded', 22, `已加载 ${total} 张表，开始生成文档。`, { total })

  const docx = await import('docx').then((module) => module?.default ?? module)
  const children = [
    ...documentHeading(docx, { connection, database, schema, structs }),
  ]

  if (total === 0) {
    report('build_empty', 88, '未检测到可导出的表结构，正在生成空模板。', { total })
    children.push(paragraph(docx, '未检测到可导出的表结构。'))
  }
  for (const [index, struct] of structs.entries()) {
    const processed = index + 1
    report(
      'building',
      25 + 65 * (processed / total),
      `正在写入表结构：${struct.table_name}（${processed}/${total}）`,
      { total, processed, tableName: struct.table_name },
    )
    children.push(...tableSection(docx, struct, processed))
  }

  report('writing_file', 95, '正在写入 DOCX 文件...', { total, processed: total })
  const buffer = await docx.Packer.toBuffer(buildDocument(docx, children))
  // Atomic, like every other file this host writes: a half-written .docx is a file
  // Word refuses to open, and it would sit where the user expects their dictionary.
  await writeFileAtomic(target, buffer, 0o644)
  report('completed', 100, '数据字典导出完成', { total, processed: total })
  return target
}

// ------------------------------------------------------------------ the plumbing
/** An absolute path that ends in `.docx`, whatever the caller asked for. */
function docxPath(outputPath) {
  const resolved = requireAbsolute(outputPath, '输出路径')
  return /\.docx$/i.test(resolved) ? resolved : `${resolved}.docx`
}

/**
 * The progress emitter.
 *
 * Values are rounded to two decimals because the panel renders them straight into a
 * progress bar, and `38.46153846153846%` is not a percentage anyone needs.
 */
function progressReporter(context, progressToken) {
  const token = typeof progressToken === 'string' ? progressToken.trim() : ''
  const emit = typeof context?.emit === 'function' ? context.emit : null

  return (stage, progress, message, extra = {}) => {
    if (token.length === 0 || emit === null) {
      return
    }
    emit(PROGRESS_EVENT, {
      token,
      stage,
      progress: Number(Number(progress).toFixed(2)),
      message,
      table_name: extra.tableName ?? null,
      processed_tables: extra.processed ?? 0,
      total_tables: extra.total ?? 0,
    })
  }
}

/** The document, with SimSun defaults and a page footer. */
function buildDocument(docx, children) {
  const { AlignmentType, Document, Footer, PageNumber, Paragraph, TextRun } = docx
  return new Document({
    creator: 'DSH · 鲨鱼数据库',
    title: '数据库数据字典',
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE.body } },
        heading1: { run: { font: FONT, size: SIZE.title, bold: true } },
        heading2: { run: { font: FONT, size: SIZE.heading, bold: true } },
        heading3: { run: { font: FONT, size: SIZE.subheading, bold: true } },
      },
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    // PageNumber.* are field codes docx resolves at render time, so
                    // Word computes the page count itself.
                    children: ['第 ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES, ' 页'],
                    font: FONT,
                    size: SIZE.footer,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })
}

// -------------------------------------------------------------------- the content
/** Title plus the metadata block: what this file is and where it came from. */
function documentHeading(docx, { connection, database, schema, structs }) {
  const { AlignmentType, HeadingLevel, Paragraph } = docx
  const columnCount = structs.reduce(
    (sum, struct) => sum + (Array.isArray(struct.columns) ? struct.columns.length : 0),
    0,
  )

  const lines = [
    `连接名称：${text(connection?.name) || EMPTY}`,
    `数据库类型：${text(connection?.db_type) || EMPTY}`,
    `数据库：${database ?? (text(connection?.database) || EMPTY)}`,
  ]
  if (schema !== undefined) {
    lines.push(`Schema：${schema}`)
  }
  lines.push(
    `导出时间：${formatDate(new Date())}`,
    `表数量：${structs.length}`,
    `字段数量：${columnCount}`,
  )

  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [run(docx, '数据库数据字典', { size: SIZE.title, bold: true })],
    }),
    ...lines.map((line) => paragraph(docx, line)),
    paragraph(docx, ''),
  ]
}

/** One table: heading, remark, counts, and the three structure tables. */
function tableSection(docx, struct, position) {
  const { HeadingLevel, Paragraph } = docx
  const columns = Array.isArray(struct.columns) ? struct.columns : []
  const primaryKeys = Array.isArray(struct.primary_keys) ? struct.primary_keys : []
  const foreignKeys = Array.isArray(struct.foreign_keys) ? struct.foreign_keys : []
  const indexes = Array.isArray(struct.indexes) ? struct.indexes : []

  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [run(docx, `${position}. ${struct.table_name}`, { size: SIZE.heading, bold: true })],
    }),
    paragraph(docx, `表备注：${text(struct.comment) || '暂无备注'}`),
    paragraph(
      docx,
      `字段数：${columns.length}    主键数：${primaryKeys.length}    外键数：${foreignKeys.length}    索引数：${indexes.length}`,
    ),
    subheading(docx, '字段定义'),
    dataTable(
      docx,
      ['字段名', '数据类型', '允许为空', '默认值', '键', '备注'],
      columns.map((column) => [
        column.name,
        column.data_type,
        column.is_nullable === false ? '否' : '是',
        column.default_value,
        column.is_primary_key === true || primaryKeys.includes(column.name) ? 'PK' : EMPTY,
        column.column_comment,
      ]),
    ),
    subheading(docx, '外键关系'),
    foreignKeys.length === 0
      ? paragraph(docx, '当前表没有外键关系。')
      : dataTable(
          docx,
          ['约束名', '字段', '引用表', '引用字段'],
          foreignKeys.map((key) => [
            key.constraint_name,
            key.column_name,
            referencedTable(key),
            key.referenced_column,
          ]),
        ),
    subheading(docx, '索引信息'),
    indexes.length === 0
      ? paragraph(docx, '当前表没有索引信息。')
      : dataTable(
          docx,
          ['索引名', '字段列表', '唯一'],
          indexes.map((index) => [
            index.name,
            (Array.isArray(index.columns) ? index.columns : []).join(', '),
            index.is_unique === true ? '是' : '否',
          ]),
        ),
    // Word merges two tables with nothing between them into one; the closing empty
    // paragraph is also what separates this table from the next heading.
    paragraph(docx, ''),
  ]
}

// --------------------------------------------------------------------- the pieces
/** A full-width table with a bold header row. */
function dataTable(docx, headers, rows) {
  const { Table, TableRow, WidthType } = docx
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((header) => cell(docx, header, { bold: true })),
      }),
      ...rows.map((row) => new TableRow({ children: row.map((value) => cell(docx, value)) })),
    ],
  })
}

/** One cell. A TableCell must have a paragraph, which is why empty renders as `-`. */
function cell(docx, value, { bold = false } = {}) {
  const { Paragraph, TableCell, VerticalAlign } = docx
  const content = text(value)
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        children: [run(docx, content.length === 0 ? EMPTY : content, { size: SIZE.cell, bold })],
      }),
    ],
  })
}

/** A body paragraph. */
function paragraph(docx, line) {
  return new docx.Paragraph({ children: [run(docx, line)] })
}

/** The label above one of the three structure tables. */
function subheading(docx, label) {
  return new docx.Paragraph({
    heading: docx.HeadingLevel.HEADING_3,
    children: [run(docx, label, { size: SIZE.subheading, bold: true })],
  })
}

/** Every run names the font explicitly: a style default does not reach table cells. */
function run(docx, line, { size = SIZE.body, bold = false } = {}) {
  return new docx.TextRun({ text: line, font: FONT, size, bold })
}

/** `schema.table` when the foreign key crosses a schema, `table` when it does not. */
function referencedTable(key) {
  const schema = text(key?.referenced_schema)
  const table = text(key?.referenced_table)
  return schema.length > 0 && table.length > 0 ? `${schema}.${table}` : table
}

/** Anything renderable as a trimmed string; null and undefined become empty. */
function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

