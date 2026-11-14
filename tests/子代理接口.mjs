// 子代理接口版本适配（0.9.10）
//
// rc.1 / rc.2 用 startActivation；rc.3 换成了 startContinuable + start。
// 以前只认 startActivation，rc.3 上 bili_scan 一直报
// 「派子代理失败：Cannot read properties of undefined (reading 'id')」。
import { 选子代理接口, 造子代理参数 } from '../index.js'

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

// ⭐ 1.0.1：参数形状（rc.3 要扁平 spec，rc.1/rc.2 要包一层 request）
const 父 = { id: 'session-abc', session: { id: 'session-abc' } }
const 基 = { provider: 'spawn', label: '刷B站：测试', parent: 父, prompt: [{ type: 'text', text: 'hi' }], signal: {} }

const 扁 = 造子代理参数('activation-flat', 基)
报('rc.3 扁平：parent 在顶层', 扁.parent === 父, JSON.stringify(Object.keys(扁)))
报('rc.3 扁平：prompt 也在顶层', Array.isArray(扁.prompt) && 扁.prompt[0].text === 'hi', String(扁.prompt))
报('rc.3 扁平：没有 request 那一层', 扁.request === undefined, String(扁.request))

const 包 = 造子代理参数('activation-nested', 基)
报('rc.1/rc.2：parent 包在 request 里', 包.request && 包.request.parent === 父, JSON.stringify(Object.keys(包)))
报('rc.1/rc.2：顶层没有 parent（老版本就是这么读的）', 包.parent === undefined, String(包.parent))

const 续 = 造子代理参数('continuable', 基)
报('continuable：request.parent', 续.request && 续.request.parent === 父, JSON.stringify(Object.keys(续)))

const 起 = 造子代理参数('start', 基)
报('start：返回 (名, 请求) 两截', 起 && 起.名 === 'spawn' && 起.请求.parent === 父, JSON.stringify(Object.keys(起 || {})))

报('不认识的模式返回 null', 造子代理参数('???', 基) === null, '')

console.log('')
console.log(挂 === 0 ? '全过' : ('挂了 ' + 挂 + ' 条'))
process.exit(挂 === 0 ? 0 : 1)
