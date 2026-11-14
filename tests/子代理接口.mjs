// 子代理接口版本适配（0.9.10）
//
// rc.1 / rc.2 用 startActivation；rc.3 换成了 startContinuable + start。
// 以前只认 startActivation，rc.3 上 bili_scan 一直报
// 「派子代理失败：Cannot read properties of undefined (reading 'id')」。
import { 选子代理接口 } from '../index.js'

let 挂 = 0
const 报 = (标, 过, 细) => {
  if (!过) 挂++
  console.log((过 ? 'PASS  ' : 'FAIL  ') + 标 + (细 ? '  :: ' + 细 : ''))
}

报('rc.3：认 startContinuable',
  选子代理接口({ startContinuable() {}, start() {} }) === 'continuable',
  选子代理接口({ startContinuable() {}, start() {} }))

报('rc.1 / rc.2：认 startActivation',
  选子代理接口({ startActivation() {} }) === 'activation',
  选子代理接口({ startActivation() {} }))

报('只有 start 也能用', 选子代理接口({ start() {} }) === 'start', 选子代理接口({ start() {} }))

报('什么都没有 → none（调用方走兜底）', 选子代理接口({}) === 'none', 选子代理接口({}))
报('服务是 undefined 也不炸', 选子代理接口(undefined) === 'none', 选子代理接口(undefined))

报('同时有 continuable 和 activation 时优先新的',
  选子代理接口({ startContinuable() {}, startActivation() {} }) === 'continuable',
  选子代理接口({ startContinuable() {}, startActivation() {} }))

console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
