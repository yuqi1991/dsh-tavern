import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function presetDropHandlers(')
const code = source.slice(start, source.indexOf('function dropZone(', start))
function harness(busy = false) {
  const dragEntry = { current: 'a#1' }, moves = [], states = [], classes = new Set()
  const handlers = new Function('dragEntry', 'busy', 'setDragging', 'movePresetEntry', code + ';return presetDropHandlers;')(dragEntry, busy, value => states.push(value), (...args) => moves.push(args))
  let prevented = 0, stopped = 0
  const event = { preventDefault() { prevented++ }, stopPropagation() { stopped++ }, dataTransfer: {}, currentTarget: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) }, contains: () => false } }
  return { handlers, event, moves, classes, states, dragEntry, intercepted: () => [prevented, stopped] }
}

test('busy and unrelated drags do not write preset data', () => {
  for (const busy of [true, false]) {
    const run = harness(busy)
    if (!busy) run.dragEntry.current = null
    run.handlers('back').onDragOver(run.event)
    run.handlers('back').onDrop(run.event)
    assert.deepEqual(run.moves, [])
    assert.deepEqual(run.intercepted(), [0, 0])
  }
})
