import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'

const fixtureDirectory = process.env.DSH_TAVERN_GOLDEN_SESSIONS || '/tmp/session-backup'

// Independent transcription of the host's ordered surface projection. Keeping
// this in the test prevents the implementation under test from supplying its
// own oracle and covers the patched assistant replacement encoding in these logs.
function hostSurfaceProjection(events) {
  const nodes = []
  for (const event of events) {
    if (!['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue
    if (event.surfaceOp === 'append' || event.surfaceOp === undefined) {
      nodes.push(event.seq)
      continue
    }
    const start = event.surfaceOp.startSeq ?? event.surfaceOp.start
    const end = event.surfaceOp.endSeq ?? event.surfaceOp.end
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(end)
    assert.ok(startIndex >= 0 && endIndex >= startIndex, `host replacement range at seq ${event.seq}`)
    nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
  }
  return nodes
}

test('golden replay equals host surface projection for read-only zstd sessions', { skip: !existsSync(fixtureDirectory) }, () => {
  const files = readdirSync(fixtureDirectory).filter(name => name.endsWith('.zstd')).sort()
  assert.ok(files.length > 0, 'golden session directory is empty')
  for (const name of files) {
    const raw = execFileSync('zstdcat', [fixtureDirectory + '/' + name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const lines = raw.trim().split('\n').map(line => JSON.parse(line))
    const events = lines[0]?.type === 'session' ? lines.slice(1) : lines
    const expected = hostSurfaceProjection(events)
    const actual = computeFold(events)
    assert.deepEqual(actual.surfaceNodes, expected, name)
    assert.ok(actual.rows.every(row => expected.includes(row.seq)), name + ': visible rows must be host surface nodes')
  }
})
