/** Notification checkpoints and scheduling, independent of DSH and Bilibili. */
export async function readAtReplies(call, { strict = false, log = () => {} } = {}) {
  const items = []
  for (const toolName of ['bili_received_at_and_likes', 'bili_received_replies']) {
    try {
      const raw = await call(toolName, {})
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (strict && (!result || result.ok === false || result.error)) {
        throw new Error(result?.error || 'notification query failed')
      }
      const list = result && Array.isArray(result.items) ? result.items : []
      for (const item of list) if (item && item.bvid) items.push(item)
    } catch (error) {
      if (strict) throw error
      log('收件箱：' + toolName + ' 失败 ' + (error?.message ?? error))
    }
  }
  return items
}

export async function readWatchUnread(call) {
  const raw = await call('bili_unread_messages', {}, { timeoutMs: 30_000 })
  const counts = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!counts || counts.error || counts.ok === false) {
    throw new Error('提醒：未读数读不到 ' + (counts?.error ?? ''))
  }
  return counts
}

/**
 * ⭐ 0.9.4（用户报的「私信一直读不到」）：从私信会话列表里挑出**真的有未读**的那几个。
 * 最多挑 3 个 —— 再多就一次读太多条内容了。
 */
export function pickUnreadSessions(sessions) {
  const 们 = Array.isArray(sessions) ? sessions : []
  return 们.filter((x) => Number(x && x.unread) > 0).slice(0, 3)
}

/**
 * ⭐ 0.9.4：私信这一路到底要不要跑。
 *
 * ⚠ **不能只看消息中心的未读汇总**：`bili_unread_messages` 里的 `chat` 在有的号上
 *   **永远是 0**（用户实测：私信列表 unread=1、汇总 chat=0），于是「有未读吗」永远答没有，
 *   定时器一次都不跑。而 `bili_dm_sessions` 返回的每个会话自带 `unread`，那个是准的。
 *
 * 口径：
 *   · 会话列表读到了（数组，哪怕是空数组）→ **以列表为准**（列表里没人有未读就是没有）；
 *   · 列表读不到（null / undefined）→ 退回看汇总的 chat，聊胜于无。
 */
export function 私信有新(数, 会话们) {
  if (Array.isArray(会话们)) {
    const 有新 = pickUnreadSessions(会话们)
    return { 有新, 有私信: 有新.length > 0, 来源: '列表' }
  }
  const chat = Number((数 && 数.chat) || 0)
  return { 有新: [], 有私信: chat > 0, 来源: '汇总' }
}

export async function deliverWatchBatch({ privateMessages, mentions, deliver, acknowledge }) {
  const batch = [...privateMessages, ...mentions].slice(0, 6)
  if (!batch.length || await deliver(batch) === false) return
  const sent = new Set(batch)
  await acknowledge(privateMessages.filter((x) => sent.has(x)), mentions.filter((x) => sent.has(x)))
}

export function createWatchTick({ refresh, enabled, intervalMs, run, onError, now = Date.now }) {
  let busy = false
  let nextAt = 0
  return async () => {
    try {
      refresh()
      if (!enabled() || busy || now() < nextAt) return
      nextAt = now() + intervalMs()
      busy = true
      try {
        await run()
      } catch (error) {
        nextAt = now() + intervalMs() * 3
        onError(error)
      } finally {
        busy = false
      }
    } catch (error) {
      onError(error)
    }
  }
}
