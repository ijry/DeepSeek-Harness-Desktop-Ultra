/**
 * 章节切分是整条导入链上唯一「猜」的一步：txt 里没有结构，只有一行行字。
 * 这里把会咬人的形状都钉住 —— 标题行与正文的区别、没有任何标题的文件、
 * 以及偏移量必须能无损切回原文。
 *
 * @module dsh-plugin-longread/test/chapters
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isHeadingLine,
  normalizeText,
  paragraphsOf,
  sectionize,
  splitChapters,
} from '../src/shared/chapters.js'

test('normalizeText 统一换行、去掉 BOM 与零宽字符、并把连续空行压成一个', () => {
  const raw = '\ufeff第一章\r\n\r\n\r\n正\u200b文 一\r\n  \n第二章\n'
  assert.equal(normalizeText(raw), '第一章\n\n正文 一\n\n第二章')
})

test('标题行认得出 第N章 / 楔子 / Chapter N 三种，长行与带句读的行一概不算', () => {
  assert.ok(isHeadingLine('第一章 雪夜抄经'))
  assert.ok(isHeadingLine('第 12 回 铁牛镇'))
  assert.ok(isHeadingLine('第九章补不足'), '不带空格的标题也要认')
  assert.ok(isHeadingLine('卷三'))
  assert.ok(isHeadingLine('楔子'))
  assert.ok(isHeadingLine('序言：写在前面'))
  assert.ok(isHeadingLine('Chapter 3'))
  assert.ok(isHeadingLine('CHAPTER IV'))
  // 正文里出现的「第三章」不能把一段话切开。
  assert.equal(isHeadingLine('第三章讲的是九处至阴，他读了三遍。'), false)
  assert.equal(isHeadingLine('第三章讲的是九处至阴，他读了三遍'.repeat(2)), false, '超过 40 字的行不是标题')
  assert.equal(isHeadingLine(''), false)
  assert.equal(isHeadingLine('   '), false)
})

test('splitChapters 的偏移量能无损切回原文，且前言够长才单独成章', () => {
  const text = normalizeText([
    '这是一段够长的前言，长到超过八十个字符，所以它应该被单独当成卷首一章保留下来，'
    + '而不是被当成噪音直接丢掉，否则读者会丢掉开头。前言里通常写的是作者的话、'
    + '版本说明，或者一段引子，都是正文的一部分。',
    '第一章 雪夜',
    '正文甲。',
    '第二章 药铺',
    '正文乙。',
  ].join('\n\n'))
  const chapters = splitChapters(text)
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['卷首', '第一章 雪夜', '第二章 药铺'])
  assert.equal(chapters[0].start, 0)
  assert.equal(chapters[chapters.length - 1].end, text.length)
  for (let i = 1; i < chapters.length; i++) {
    assert.equal(chapters[i].start, chapters[i - 1].end, '章与章之间不许有空隙')
  }
  assert.ok(text.slice(chapters[1].start, chapters[1].end).startsWith('第一章 雪夜'))
})

test('短前言被当噪音丢掉', () => {
  const text = normalizeText('免责声明\n\n第一章 甲\n\n正文。')
  assert.deepEqual(splitChapters(text).map((chapter) => chapter.title), ['第一章 甲'])
})

test('一个标题都没有的文件按字数切成节，仍然覆盖全文', () => {
  const body = normalizeText(Array.from({ length: 60 }, (_unused, i) => `第${i}段。`.repeat(30)).join('\n\n'))
  const sections = sectionize(body)
  assert.ok(sections.length > 1, '几万字不该只切出一节')
  assert.equal(sections[0].start, 0)
  assert.equal(sections[sections.length - 1].end, body.length)
  assert.equal(sections[0].title, '第 1 节')
  assert.equal(splitChapters(body).length, sections.length, '没有标题时 splitChapters 就是 sectionize')
})

test('空文本切不出章', () => {
  assert.deepEqual(splitChapters('   \n\n  '), [])
})

test('paragraphsOf 丢掉标题行、缩进与空行，段落顺序不变', () => {
  const chapter = '第一章 雪夜\n\n\u3000\u3000甲段第一行\n甲段第二行\n\n乙段\n\n\n丙段  '
  assert.deepEqual(paragraphsOf(chapter), ['甲段第一行甲段第二行', '乙段', '丙段'])
  assert.equal(paragraphsOf(chapter, { dropHeading: false })[0], '第一章 雪夜')
})
