import assert from 'node:assert/strict'
import test from 'node:test'
import { createStubDom } from './dom-stub.mjs'

test('mutation stub observes replacing identical nonempty text but not an empty no-op', () => {
  const dom = createStubDom()
  const badge = dom.document.createElement('span')
  dom.body.append(badge)
  const batches = []
  const observer = new dom.globals.MutationObserver((records) => batches.push(records))
  observer.observe(dom.body, { childList: true, subtree: true })
  badge.textContent = ''
  assert.equal(dom.flushMutations(), 0)
  badge.textContent = '2'
  assert.equal(dom.flushMutations(), 1)
  badge.textContent = '2'
  assert.equal(dom.flushMutations(), 1)
  assert.equal(batches.length, 2)
  assert.equal(batches[1][0].target, badge)
  observer.disconnect()
  badge.textContent = '3'
  assert.equal(dom.flushMutations(), 0)
})

test('mutation stub detects callbacks that keep rewriting their observed subtree', () => {
  const dom = createStubDom()
  const badge = dom.document.createElement('span')
  dom.body.append(badge)
  const observer = new dom.globals.MutationObserver(() => { badge.textContent = '2' })
  observer.observe(dom.body, { childList: true, subtree: true })
  badge.textContent = '2'
  assert.throws(() => dom.flushMutations(5), /did not settle after 5 rounds/)
  observer.disconnect()
})
