/**
 * 判重表的「看过的视频」那一节 —— 谁来写、写什么。
 *
 * ⚠ 2026-11-02：以前**没有任何人写**这一节。
 *   宿主只负责建表（`index.js` 里那个 seenFile），提示词只交代了「读它做判重」和「发完评论记评论记录」，
 *   结果「## 看过的视频」从建出来那天起就是空的 —— 判重表等于没用，每轮都从零开始挑。
 *
 * ⭐ 0.9.7：这里只记**「刷出来了（推给她了）的那几条」**，而且只记一档。
 *   - 记：报告里真给出来的视频（`### BVxxx`），不管她点没点开 —— "刷过"是指"已经刷到她眼前"。
 *   - 不记：大肥鱼搜出来、读了字幕、比对过但**没挑中**的那些。
 *     ⚠ 这一点很要紧：那几条里可能就有好东西，只是这一轮没选中；
 *     要是把它们也记成"刷过"，下一轮就再也不会出现了 —— 那就把可选范围越刷越小。
 *   - 行格式：`- BV1xxxxxxxxx 2026-11-02`（就这两样，不写状态，免得又生出"挑过/看过"这种歧义）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const 视频节标题 = '## 看过的视频'

/** 解析出 [{bv, 日期}]（按行顺序；老行、新行都认） */
export function 解析条目(文) {
  const 出 = []
  for (const 行 of String(文 || '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s*(BV[0-9A-Za-z]{10})\s*(\d{4}-\d\d-\d\d)?/.exec(行)
    if (!m) continue
    出.push({ bv: m[1], 日期: m[2] || '' })
  }
  return 出
}

/** 兼容老调用：只要 BV 列表 */
export function 解析看过的(文) {
  return 解析条目(文).map((x) => x.bv)
}

function 读表(表路) {
  try {
    return existsSync(表路) ? readFileSync(表路, 'utf8') : ''
  } catch {
    return ''
  }
}

/** 把这一节整体重写成 条目们 的文本（别的节原样不动） */
function 写回(表路, 原文, 条目们) {
  const 行们 = (原文 || '').split(/\r?\n/)
  let 起 = 行们.findIndex((l) => l.trim() === 视频节标题)
  if (起 < 0) {
    行们.push('', 视频节标题)
    起 = 行们.length - 1
  }
  let 止 = 行们.length
  for (let i = 起 + 1; i < 行们.length; i++) {
    if (/^##\s/.test(行们[i])) { 止 = i; break }
  }
  const 新行 = 条目们.map((x) => '- ' + x.bv + (x.日期 ? ' ' + x.日期 : ''))
  const 新 = [...行们.slice(0, 起 + 1), ...(新行.length ? ['', ...新行, ''] : ['']), ...行们.slice(止)]
  writeFileSync(表路, 新.join('\n'), 'utf8')
}

/**
 * 把这一轮**刷出来**的视频记进表。已经在表里的不重复写（也不改日期）。
 * @returns {string[]} 这次真新记进去的
 */
export function 记刷过的(表路, bvs, 日期) {
  const 要写 = []
  for (const x of (Array.isArray(bvs) ? bvs : [])) {
    const bv = String(x || '')
    if (/^BV[0-9A-Za-z]{10}$/.test(bv) && !要写.includes(bv)) 要写.push(bv)
  }
  if (!要写.length) return []
  const 天 = String(日期 || new Date().toISOString().slice(0, 10))
  const 原文 = 读表(表路)
  const 条目们 = 解析条目(原文)
  const 已有 = new Set(条目们.map((x) => x.bv))
  const 新 = []
  for (const bv of 要写) {
    if (已有.has(bv)) continue
    条目们.push({ bv, 日期: 天 })
    已有.add(bv)
    新.push(bv)
  }
  if (新.length) 写回(表路, 原文, 条目们)
  return 新
}

/** 这个 BV 是不是刷过了（刷过就不再刷） */
export function 刷过了(表路, bv) {
  return 解析条目(读表(表路)).some((x) => x.bv === bv)
}
