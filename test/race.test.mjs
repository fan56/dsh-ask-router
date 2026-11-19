// prepend + race behavior (design 2026-11-19-ask-prepend-race-design.md §3.2-3.4,
// §11 checklist 1-7 as far as the router's surface model allows). The router
// has no lark/card dependency, so each branch is driven with fake surfaces.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { apply, raceAsk } from '../lib/index.js'

const ANSWER = (tag) => ({ answers: [{ id: 'q1', selected: [tag] }] })
const tick = () => new Promise((r) => setImmediate(r))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function surface(name, { claim = () => true, ask, settled } = {}) {
  const calls = { ask: 0, settled: [] }
  return {
    name,
    calls,
    claim,
    async ask(request) {
      calls.ask += 1
      return ask ? ask(request) : ANSWER(name)
    },
    settled: (request, by) => { calls.settled.push(by); settled?.(request, by) },
  }
}

function request(overrides = {}) {
  return {
    questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }] }],
    agent: { session: { id: 's1' } },
    ...overrides,
  }
}

// ---------------------------------------------------------------- R-A --

test('surface wins: answer returned, next() once, late downstream result/rejection swallowed', async () => {
  const fast = surface('feishu')
  const down = deferred()
  let nextCalls = 0
  const promise = raceAsk([fast], request(), () => { nextCalls += 1; return down.promise })
  assert.deepEqual(await promise, ANSWER('feishu'))
  assert.equal(nextCalls, 1, 'downstream delegated to exactly once')
  // Both late outcomes must be absorbed by the one-way gate / rejection handler.
  down.resolve(ANSWER('gui'))
  down.reject(new Error('late downstream failure'))
  await tick()
})

// ---------------------------------------------------------- R-B / #4/#5 --

test('downstream wins: every surface settled, late surface answer ignored (zombie card)', async () => {
  const surf = deferred()
  const s = surface('feishu', { ask: () => surf.promise })
  const down = deferred()
  const promise = raceAsk([s], request(), () => down.promise)
  down.resolve(ANSWER('gui'))
  assert.deepEqual(await promise, ANSWER('gui'))
  assert.deepEqual(s.calls.settled, ['downstream answerer'], 'in-flight surface dismissed on downstream win')
  surf.resolve(ANSWER('feishu')) // user answers the now-stale card
  await tick()
  assert.deepEqual(s.calls.settled, ['downstream answerer'], 'no second settle from the zombie answer')
})

test('downstream wins with two surfaces: each settled once as downstream; zombie answers cannot re-settle', async () => {
  const surfA = deferred()
  const surfB = deferred()
  const a = surface('A', { ask: () => surfA.promise })
  const b = surface('B', { ask: () => surfB.promise })
  const down = deferred()
  const promise = raceAsk([a, b], request(), () => down.promise)
  down.resolve(ANSWER('gui'))
  assert.deepEqual(await promise, ANSWER('gui'))
  // The downstream win mass-dismisses every surface exactly once.
  assert.deepEqual(a.calls.settled, ['downstream answerer'])
  assert.deepEqual(b.calls.settled, ['downstream answerer'])
  // Zombie answers arrive later; routeAsk must not re-settle the other surface.
  surfA.resolve(ANSWER('A-zombie'))
  surfB.resolve(ANSWER('B-zombie'))
  await tick()
  assert.deepEqual(a.calls.settled, ['downstream answerer'], 'A settled exactly once, winner is downstream')
  assert.deepEqual(b.calls.settled, ['downstream answerer'], 'B settled exactly once, no "B<-A" duplicate')
})

// ------------------------------------------------------------ R-D / #1 --

test('surface non-abort rejection falls back to downstream (immediate NO_CHAT)', async () => {
  const bad = surface('feishu', {
    ask: () => { throw new UserQuestionError('no chat', 'NO_CHAT') },
  })
  const down = deferred()
  const promise = raceAsk([bad], request(), () => down.promise)
  await tick() // surface branch rejects while downstream is still pending
  down.resolve(ANSWER('gui'))
  assert.deepEqual(await promise, ANSWER('gui'))
})

test('surface non-abort rejection falls back to downstream (delayed CARD_SEND_FAILED)', async () => {
  const surf = deferred()
  const bad = surface('feishu', { ask: () => surf.promise })
  const down = deferred()
  const promise = raceAsk([bad], request(), () => down.promise)
  setTimeout(() => surf.reject(new UserQuestionError('send failed', 'CARD_SEND_FAILED')), 2)
  setTimeout(() => down.resolve(ANSWER('gui')), 8)
  assert.deepEqual(await promise, ANSWER('gui'))
})

// ------------------------------------------------------------ R-C / #2 --

test('both reject, no abort: surface error code wins', async () => {
  const surfErr = new UserQuestionError('no chat', 'NO_CHAT')
  const downErr = new UserQuestionError('gui went away', 'DOWNSTREAM_GONE')
  const bad = surface('feishu', { ask: () => Promise.reject(surfErr) })
  let nextCalls = 0
  const promise = raceAsk([bad], request(), () => {
    nextCalls += 1
    return Promise.reject(downErr)
  })
  await assert.rejects(promise, (error) => error === surfErr)
  assert.equal(nextCalls, 1)
})

test('both reject with signal aborted: ASK_ABORTED propagated, not swallowed', async () => {
  const controller = new AbortController()
  const surf = deferred()
  const s = surface('feishu', { ask: () => surf.promise })
  const down = deferred()
  const promise = raceAsk([s], request({ signal: controller.signal }), () => down.promise)
  await tick() // let routeAsk attach its abort listener
  down.reject(new UserQuestionError('gui aborted', 'ASK_ABORTED'))
  controller.abort() // routeAsk rejects with ASK_ABORTED
  await assert.rejects(promise, (error) => error instanceof UserQuestionError && error.code === 'ASK_ABORTED')
})

// ------------------------------------------------------------- R-E / #3 --

test('unload mid-race: downstream still settles after the listener is disposed', async () => {
  let listener
  let dispose
  let disposed = 0
  const ctx = {
    provide(key, value) { if (key === 'askSurfaces') this.surfaces = value },
    on(event, fn) { listener = fn; dispose = () => { disposed += 1 }; return dispose },
    effect(callback) { callback() },
  }
  apply(ctx)
  const surf = deferred()
  ctx.surfaces.register({ name: 'feishu', claim: () => true, ask: () => surf.promise, settled: () => {} })
  const down = deferred()
  const promise = listener(request(), () => down.promise)
  dispose() // plugin scope ends while the race is in flight
  assert.equal(disposed, 1)
  down.resolve(ANSWER('gui'))
  assert.deepEqual(await promise, ANSWER('gui'), 'race is independent of the listener lifecycle')
})

// --------------------------------------------------------- §3.4.3 / #6 --

test('synchronous throw from next() becomes a rejection; surface still answers, next once', async () => {
  const s = surface('feishu')
  let nextCalls = 0
  const answer = await raceAsk([s], request(), () => {
    nextCalls += 1
    throw new Error('sync downstream boom')
  })
  assert.deepEqual(answer, ANSWER('feishu'))
  assert.equal(nextCalls, 1)
})

// ------------------------------------------------------------- #7 prepend --

test('cordis sanity: { prepend: true } runs ahead of an earlier listener', async () => {
  const ctx = new Context()
  const order = []
  ctx.on('user-questions/request', () => { order.push('tail'); return Promise.resolve(ANSWER('tail')) })
  ctx.on('user-questions/request', () => { order.push('head'); return Promise.resolve(ANSWER('head')) }, { prepend: true })
  const answer = await ctx.waterfall('user-questions/request', request(), async () => ANSWER('none'))
  assert.deepEqual(order, ['head'])
  assert.deepEqual(answer, ANSWER('head'))
})

test('real cordis: apply() listener beats a first-registered consuming bridge (GUI-opened session)', async () => {
  const ctx = new Context()
  // A bridge registered first that claims and consumes without next(). If the
  // router were tail-registered this would answer 'gui' and no surface asked.
  ctx.on('user-questions/request', () => new Promise((r) => setTimeout(() => r(ANSWER('gui')), 10)))
  apply(ctx) // prepends our answerer
  const s = surface('feishu')
  ctx.get('askSurfaces').register(s)
  const answer = await ctx.waterfall('user-questions/request', request(), async () => ANSWER('none'))
  assert.deepEqual(answer, ANSWER('feishu'), 'prepended router surface wins over the consuming bridge')
  assert.equal(s.calls.ask, 1)
})
