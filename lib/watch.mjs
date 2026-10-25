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
