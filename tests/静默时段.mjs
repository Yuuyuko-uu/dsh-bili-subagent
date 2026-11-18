// 0.10.0 的回归：静默时段。
//
// 用户的原话（大意）：想在 23:00 到第二天 12:00 之间一句都别刷 —— 那段时间推过来的
// 推荐没人看，可轮次照样被用掉，第二天醒来额度已经空了。
//
// 两条要紧的：
//   ① **跨零点**要能表达（23:00 → 12:00），这是最常见的写法
//   ② **填错不能把一整天变成静默** —— 起止一样、格式不对、没开，一律当「不静默」
//
// 跑法：node tests/静默时段.mjs
import assert from 'node:assert/strict'
import { 在静默时段 } from '../index.js'

let 段 = 0
function 测(名, 做) {
  try { 做(); 段 += 1; console.log('PASS  ' + 名) }
  catch (e) { console.log('FAIL  ' + 名 + '  :: ' + ((e && e.message) || e)); process.exitCode = 1 }
}

const 点 = (h, m) => { const d = new Date(2026, 10, 18, h, m, 0, 0); return d }
const 跨零点 = { on: true, from: '23:00', to: '12:00' }

测('跨零点：23:00 整就开始静默', () => {
  assert.equal(在静默时段(点(22, 59), 跨零点), false)
  assert.equal(在静默时段(点(23, 0), 跨零点), true)
})

测('跨零点：过了零点还在静默', () => {
  assert.equal(在静默时段(点(0, 0), 跨零点), true)
  assert.equal(在静默时段(点(3, 30), 跨零点), true)
})

测('跨零点：12:00 整恢复', () => {
  assert.equal(在静默时段(点(11, 59), 跨零点), true)
  assert.equal(在静默时段(点(12, 0), 跨零点), false)
  assert.equal(在静默时段(点(20, 0), 跨零点), false)
})

测('不跨零点也照常：09:00–11:00', () => {
  const 设 = { on: true, from: '09:00', to: '11:00' }
  assert.equal(在静默时段(点(8, 59), 设), false)
  assert.equal(在静默时段(点(9, 0), 设), true)
  assert.equal(在静默时段(点(10, 59), 设), true)
  assert.equal(在静默时段(点(11, 0), 设), false)
  assert.equal(在静默时段(点(23, 0), 设), false)
})

测('没开就不静默', () => {
  assert.equal(在静默时段(点(3, 0), { ...跨零点, on: false }), false)
})

测('起止一样：当不静默（不然一整天都别跑了）', () => {
  assert.equal(在静默时段(点(3, 0), { on: true, from: '23:00', to: '23:00' }), false)
})

测('时间写坏了：当不静默，不炸也不锁死', () => {
  for (const 坏 of ['', '25:00', 'ab', '11', null, undefined]) {
    assert.equal(在静默时段(点(3, 0), { on: true, from: 坏, to: '12:00' }), false)
    assert.equal(在静默时段(点(3, 0), { on: true, from: '23:00', to: 坏 }), false)
  }
})

测('边界都算「含头不含尾」：正好在起点算静默，正好在终点算恢复', () => {
  assert.equal(在静默时段(点(23, 0), 跨零点), true)
  assert.equal(在静默时段(点(12, 0), 跨零点), false)
})

console.log('')
console.log('通过 ' + 段 + ' 项')
