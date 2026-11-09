import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 记刷过的, 解析条目, 刷过了, 最近看过的 } from '../lib/seen.mjs'

// 0.9.7：判重表只记「真刷出来（写进报告）的」那几条，一档，不写状态。
//   搜出来读过字幕但没挑中的**不记** —— 那些下一轮还该有机会。

const 表头 = [
  '# 刷B站 · 判重表',
  '',
  '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
  '',
  '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
  '| --- | --- | --- | --- | --- |',
  '',
  '## 看过的视频',
  '',
].join('\n')

function 建表(内容 = 表头) {
  const 夹 = mkdtempSync(join(tmpdir(), 'seen-'))
  const 路 = join(夹, 'seen.md')
  writeFileSync(路, 内容, 'utf8')
  return 路
}

test('刷出来的记一条（BV + 日期，不写状态）', () => {
  const 路 = 建表()
  assert.deepEqual(记刷过的(路, ['BV19Jx46eEkg'], '2026-11-02'), ['BV19Jx46eEkg'])
  const 文 = readFileSync(路, 'utf8')
  assert.match(文, /- BV19Jx46eEkg 2026-11-02/)
  assert.equal(/挑过|看过/.test(文.split('## 看过的视频')[1]), false, '不该有状态字样')
  assert.match(文, /\| --- \| --- \| --- \| --- \| --- \|/, '评论记录那张表不能被弄坏')
})

test('同一支不会记第二遍（日期也不改）', () => {
  const 路 = 建表()
  记刷过的(路, ['BV19Jx46eEkg'], '2026-10-01')
  assert.deepEqual(记刷过的(路, ['BV19Jx46eEkg'], '2026-11-02'), [])
  const 文 = readFileSync(路, 'utf8')
  assert.equal((文.match(/BV19Jx46eEkg/g) || []).length, 1)
  assert.match(文, /2026-10-01/, '原来的日期不该被改')
})

test('刷过了 = 永远跳过（没有 14 天窗口）', () => {
  const 路 = 建表()
  assert.equal(刷过了(路, 'BV19Jx46eEkg'), false)
  记刷过的(路, ['BV19Jx46eEkg'], '2026-01-01')
  assert.equal(刷过了(路, 'BV19Jx46eEkg'), true)
})

test('没挑中的不记：表里只有我给的那几支', () => {
  const 路 = 建表()
  // 这一轮搜出来 5 支，只有 1 支写进了报告 → 只记这 1 支
  记刷过的(路, ['BV19Jx46eEkg'], '2026-11-02')
  const 文 = readFileSync(路, 'utf8')
  assert.equal((文.match(/^- BV/gm) || []).length, 1)
})

test('不窜节：写在「看过的视频」里，后面的节原样保留', () => {
  const 路 = 建表(表头 + '\n## 别的节\n\n随便写点\n')
  记刷过的(路, ['BV19Jx46eEkg'], '2026-11-02')
  const 文 = readFileSync(路, 'utf8')
  assert.ok(文.indexOf('BV19Jx46eEkg') < 文.indexOf('## 别的节'))
  assert.match(文, /## 别的节\n\n随便写点/)
})

test('老行（以前带状态字样的）也能读，且照样算刷过', () => {
  const 路 = 建表(表头 + '- BVold0000000 2026-11-01 挑过\n- BVold1111111 2026-11-01 看过\n')
  assert.deepEqual(解析条目(readFileSync(路, 'utf8')).map((x) => x.bv), ['BVold0000000', 'BVold1111111'])
  assert.equal(刷过了(路, 'BVold0000000'), true)
  assert.equal(刷过了(路, 'BVold1111111'), true)
})

test('非法 BV 不写；重复的只记一次', () => {
  const 路 = 建表()
  assert.deepEqual(记刷过的(路, ['随便', '', null, 'BV123'], '2026-11-02'), [])
  assert.deepEqual(记刷过的(路, ['BV19Jx46eEkg', 'BV19Jx46eEkg'], '2026-11-02'), ['BV19Jx46eEkg'])
  assert.equal((readFileSync(路, 'utf8').match(/^- BV/gm) || []).length, 1)
})

// 0.9.9：判重表**被读**了 —— 最近刷过的要能塞进提示词，告诉子代理别再挑。
test('最近看过的：取文件顺序最后 N 条（追加顺序 = 刷的顺序）', () => {
  const 路 = 建表(表头 + '- BVaaa0000001 2026-11-01\n- BVbbb0000002 2026-11-02\n- BVccc0000003 2026-11-03\n')
  assert.deepEqual(最近看过的(路, 2), ['BVbbb0000002', 'BVccc0000003'])
  assert.deepEqual(最近看过的(路, 99), ['BVaaa0000001', 'BVbbb0000002', 'BVccc0000003'])
  assert.deepEqual(最近看过的(路, 0), [])
  assert.deepEqual(最近看过的(路, -1), [])
})

test('最近看过的：表不存在 / 空表不炸，返回空数组', () => {
  const 夹 = mkdtempSync(join(tmpdir(), 'seen-'))
  assert.deepEqual(最近看过的(join(夹, 'nope.md'), 10), [])
  assert.deepEqual(最近看过的(建表(), 10), [])
})

test('最近看过的：只认「## 看过的视频」里的，评论记录表里的 BV 不算', () => {
  const 带评论 = 表头.replace(
    '| --- | --- | --- | --- | --- |',
    '| --- | --- | --- | --- | --- |\n| BVzzz0000009 | 123 |  | 2026-11-02 10:00 | 随口一句 |',
  )
  const 路 = 建表(带评论 + '- BVaaa0000001 2026-11-01\n')
  assert.deepEqual(最近看过的(路, 10), ['BVaaa0000001'])
})
