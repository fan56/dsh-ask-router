import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AskSurfaceRegistry, routeAsk } from '../lib/index.js'

function surface(name, { claim = () => true, answer, fail = false, settled } = {}) {
  const calls = { ask: 0, settled: [] }
  return {
    name,
    calls,
    claim,
    async ask(request) {
      calls.ask += 1
      if (fail) throw new Error(`${name} cannot render`)
      return typeof answer === 'function' ? answer(request) : answer
    },
    settled: (request, by) => { calls.settled.push(by); settled?.(request, by) },
  }
}

function request(overrides = {}) {
  return {
    questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
    agent: { session: { id: 's1' } },
    ...overrides,
  }
}

test('first answer wins; losers get settled with the winner name', async () => {
  const slow = surface('tui', { answer: () => new Promise(() => {}) })
  const fast = surface('feishu', { answer: () => ({ answers: [{ id: 'q1', selected: ['yes'] }] }) })
  const answer = await routeAsk([slow, fast], request())
  assert.deepEqual(answer.answers[0].selected, ['yes'])
  assert.deepEqual(slow.calls.settled, ['feishu'])
  assert.deepEqual(fast.calls.settled, [])
  assert.equal(slow.calls.ask, 1)
})

test('claim routing: only surfaces claiming the asking session are asked', async () => {
  const tui = surface('tui', { claim: req => String(req.agent.session.id) === 's1', answer: () => ({ answers: [{ id: 'q1', selected: ['yes'] }] }) })
  const phone = surface('feishu', { claim: () => false, answer: () => ({ answers: [{ id: 'q1', selected: ['no'] }] }) })
  const answer = await routeAsk([tui, phone], request())
  assert.equal(tui.calls.ask, 1)
  assert.equal(phone.calls.ask, 0) // not claiming — never asked
  assert.deepEqual(answer.answers[0].selected, ['yes'])
})

test('nobody claims: everyone is asked (visible somewhere beats failing)', async () => {
  const a = surface('a', { claim: () => false, answer: () => new Promise(() => {}) })
  const b = surface('b', { claim: () => false, answer: () => ({ answers: [{ id: 'q1', selected: ['yes'] }] }) })
  const answer = await routeAsk([a, b], request())
  assert.deepEqual(answer.answers[0].selected, ['yes'])
  assert.deepEqual(a.calls.settled, ['b'])
})

test('abort rejects and settles nothing further; surfaces self-clean via signal', async () => {
  const controller = new AbortController()
  const req = request({ signal: controller.signal })
  const s = surface('tui', { answer: () => new Promise(() => {}) })
  const promise = routeAsk([s], req)
  controller.abort()
  await assert.rejects(promise, /aborted/)
})

test('every surface failing rejects with the first error; one failure does not', async () => {
  const bad = surface('bad', { fail: true })
  const good = surface('good', { answer: () => new Promise(r => setTimeout(() => r({ answers: [] }), 5)) })
  const answer = await routeAsk([bad, good], request())
  assert.deepEqual(answer, { answers: [] }) // good still answered after bad failed
  const bad2 = surface('bad2', { fail: true })
  await assert.rejects(routeAsk([bad, bad2], request()), /cannot render/)
})

test('no surfaces at all: NO_PROVIDER-shaped rejection', async () => {
  await assert.rejects(routeAsk([], request()), /no ask surface/)
})

test('a throwing claim counts as no claim; a throwing settled is contained', async () => {
  const throwing = surface('throwing', {
    claim: () => { throw new Error('boom') },
    answer: () => ({ answers: [{ id: 'q1', selected: ['x'] }] }),
    settled: () => { throw new Error('dismiss boom') },
  })
  const steady = surface('steady', { claim: () => true, answer: () => ({ answers: [{ id: 'q1', selected: ['y'] }] }) })
  const answer = await routeAsk([throwing, steady], request())
  assert.deepEqual(answer.answers[0].selected, ['y'])
  assert.equal(throwing.calls.ask, 0)
})

test('AskSurfacesService: register/dispose/list keeps order', () => {
  const svc = new AskSurfaceRegistry()
  const a = surface('a')
  const b = surface('b')
  const disposeA = svc.register(a)
  svc.register(b)
  assert.deepEqual(svc.list().map(s => s.name), ['a', 'b'])
  disposeA()
  assert.deepEqual(svc.list().map(s => s.name), ['b'])
})
