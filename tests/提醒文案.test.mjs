import test from 'node:test'
import assert from 'node:assert/strict'
import { 拼提醒文案 } from '../index.js'

// ⭐ 0.9.5：递进来的 @ / 回复 必须带着「要回哪一条」的 id。
//   以前只拼 谁 + BV + 内容 + 时间，agent 拿不到 rpid，只能去视频下发新评论再手动 @，
//   回不了楼中楼。上游 `_norm_feed()` 一直有这两个字段，是拼文案这一步丢的。

const 一条 = (额外 = {}) => ({
  种类: 'at',
  谁: '战栗的龙卷',
  bv: 'BV1CFnq68End',
  内容: '来玩',
  ts: 1793700000,
  楼: 322686319568,
  层: 322686319568,
  ...额外,
})

test('@ 提醒里要写出 rpid（这是回楼中楼的钥匙）', () => {
  const 文 = 拼提醒文案([一条()])
  assert.match(文, /rpid 322686319568/, '文案里必须有 rpid')
  assert.match(文, /BV1CFnq68End/)
})

test('root 跟 rpid 不一样时也写出来，一样时不重复写', () => {
  const 同 = 拼提醒文案([一条()])
  assert.equal((同.match(/root/g) || []).length <= 1, true, '相同的时候不该冒出第二个 root 字样')

  const 异 = 拼提醒文案([一条({ 楼: 900, 层: 800 })])
  assert.match(异, /rpid 900/)
  assert.match(异, /root 800/)
})

test('有 rpid 才补「怎么回楼中楼」那行提示', () => {
  const 有 = 拼提醒文案([一条()])
  assert.match(有, /bili_reply/, '有 id 时要告诉 agent 怎么用')
  const 无 = 拼提醒文案([{ 种类: 'at', 谁: '某人', bv: 'BV1xx', 内容: '嗨' }])
  assert.equal(无.includes('bili_reply'), false, '没有 id 时不该出这行')
})

test('私信那条不受影响（它本来就没有 rpid）', () => {
  const 文 = 拼提醒文案([{ 谁: '某人', 内容: '在吗', bv: 'BV1yy' }])
  assert.match(文, /· 私信｜某人：在吗/)
  assert.equal(文.includes('rpid'), false)
})

test('一条都没有时不炸，也不出空行堆', () => {
  const 文 = 拼提醒文案([])
  assert.equal(typeof 文, 'string')
  assert.equal(文.includes('\n\n\n'), false)
})
