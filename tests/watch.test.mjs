import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverWatchBatch, readWatchUnread, createWatchTick } from '../lib/watch.mjs'

const items = (count, kind) => Array.from({ length: count }, (_, i) => ({ id: `${kind}:${i}` }))

test('seven private messages: acknowledge six, then deliver the remaining one', async () => {
  const pending = items(7, 'dm')
  const seen = new Set()
  const batches = []
  const poll = () => deliverWatchBatch({
    privateMessages: pending.filter((x) => !seen.has(x)), mentions: [],
    deliver: async (batch) => { batches.push(batch); return true },
    acknowledge: (dm, at) => { assert.equal(at.length, 0); dm.forEach((x) => seen.add(x)) },
  })
  await poll()
  assert.equal(seen.size, 6)
  assert.ok(!seen.has(pending[6]))
  await poll()
  assert.deepEqual(batches.map((x) => x.length), [6, 1])
  assert.equal(seen.size, 7)
})

test('mixed private messages and mentions acknowledge only the delivered subset', async () => {
  const dm = items(4, 'dm'), at = items(3, 'at')
  let sent, acknowledged
  await deliverWatchBatch({ privateMessages: dm, mentions: at,
    deliver: async (batch) => { sent = batch; return true },
    acknowledge: (...args) => { acknowledged = args },
  })
  assert.deepEqual(sent, [...dm, ...at.slice(0, 2)])
  assert.deepEqual(acknowledged, [dm, at.slice(0, 2)])
})

test('missing target or rejected delivery never acknowledges a message', async () => {
  for (const deliver of [async () => false, async () => { throw Error('delivery failed') }]) {
    let acknowledged = false
    const attempt = deliverWatchBatch({ privateMessages: items(1, 'dm'), mentions: [], deliver,
      acknowledge: () => { acknowledged = true },
    })
    await attempt.catch(() => {})
    assert.equal(acknowledged, false)
  }
})

for (const failure of ['transport', 'api', 'invalid-json']) {
  test(`${failure} failure backs off three intervals before retrying`, async () => {
    let clock = 1000, calls = 0, errors = 0
    const tick = createWatchTick({ refresh() {}, enabled: () => true,
      intervalMs: () => 120_000, now: () => clock,
      run: () => readWatchUnread(async () => {
        calls++
        if (failure === 'transport') throw Error('offline')
        return failure === 'api' ? { error: 'rate limited' } : '{'
      }),
      onError: () => { errors++ },
    })
    await tick()
    clock += 120_000
    await tick()
    assert.equal(calls, 1)
    clock += 239_999
    await tick()
    assert.equal(calls, 1)
    clock++
    await tick()
    assert.equal(calls, 2)
    assert.equal(errors, 2)
  })
}

test('disabled or overlapping ticks do not run; successful poll keeps normal interval', async () => {
  let clock = 1000, enabled = false, calls = 0, release
  const tick = createWatchTick({ refresh() {}, enabled: () => enabled,
    intervalMs: () => 100, now: () => clock,
    run: () => { calls++; return new Promise((resolve) => { release = resolve }) },
    onError: (error) => { throw error },
  })
  await tick()
  assert.equal(calls, 0)
  enabled = true
  const first = tick()
  clock += 100
  await tick()
  assert.equal(calls, 1)
  release()
  await first
  const second = tick()
  assert.equal(calls, 2)
  release()
  await second
})
