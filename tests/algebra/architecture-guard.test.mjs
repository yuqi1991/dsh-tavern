// Static architecture guard (ADR-0009, ticket 11): plugin code does not
// rewrite the model surface outside the conversation algebra. This reads
// source text; it proves the code shape, not runtime behavior.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../../lib', import.meta.url).pathname
const sources = new Map()
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'vendor' || name === 'client-assets') continue
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.js') && name !== 'client.js') sources.set(relative(root, path), readFileSync(path, 'utf8'))
  }
})(root)

const filesMatching = pattern => [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file).sort()

test('only the algebra adapter rewrites the surface directly', () => {
  assert.deepEqual(filesMatching(/\b(?:createSessionSurfaceMutator|replaceSessionSurface)\b/), [
    'domain/conversation-algebra-host-adapter.js', 'domain/session-surface-mutations.js'
  ])
})

test('every surface replacement intent is written through a conversation transaction', () => {
  // session-events.js translates an intent into the host's append shape and
  // session-surface-mutations.js is the primitive under the algebra adapter;
  // the first guard limits who may reach it.
  // host-session-patch.js only builds a throwaway probe session for its startup self-test.
  const translators = new Set(['domain/session-events.js', 'domain/session-surface-mutations.js', 'domain/host-session-patch.js'])
  const writers = filesMatching(/op:\s*['"]replace['"]/).filter(file => !file.startsWith('domain/conversation-algebra/') && !translators.has(file))
  assert.ok(writers.length >= 5, 'expected the known intent writers, found ' + writers.join(','))
  for (const file of writers) {
    assert.match(sources.get(file), /writeSurfaceEvent\(|runTransaction\(|kind:\s*['"]surface-write['"]/, file + ' writes a replacement outside a transaction')
  }
})

test('surface selection outside the algebra is limited to background restoration', () => {
  const callers = filesMatching(/\bselectSurface\(/).filter(file => file !== 'domain/surface-restoration.js')
  assert.deepEqual(callers, ['domain/round-history.js'])
})

test('async transaction writers are never fired without an await or a catch', () => {
  // The host exits the whole process on an unhandled rejection, and these
  // writers reject on a head conflict. A statement that calls one without
  // await/return/assignment must go through runDetachedWrite.
  const writers = ['replaceAssistantReply', 'clearFailedTurnSurface', 'retireOldForegroundFrames', 'retireForegroundWithAlgebra',
    'synchronizeTemplateHistory', 'synchronizeBodyEdits', 'ensureSessionStablePrefix', 'rewindBackgroundSurface', 'writeSurfaceEvent', 'runTransaction']
  const offenders = []
  for (const [file, text] of sources) {
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      for (const name of writers) {
        if (trimmed.startsWith(name + '(') && !/^(?:async )?function\b/.test(trimmed)) offenders.push(file + ':' + (index + 1) + ' ' + name)
        if (new RegExp('^if \\(.*\\) ' + name + '\\(').test(trimmed)) offenders.push(file + ':' + (index + 1) + ' ' + name)
      }
    })
  }
  assert.deepEqual(offenders, [])
})

// Retired mechanisms (ticket 18): the host chat page is no longer masked by the
// client and the Chat no longer carries per-turn hiding tables.
const clientRoot = new URL('../../tavern-plugin/src/client', import.meta.url).pathname
const clientSources = new Map()
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.js')) clientSources.set(relative(clientRoot, path), readFileSync(path, 'utf8'))
  }
})(clientRoot)
const clientMatching = pattern => [...clientSources].filter(([, text]) => pattern.test(text)).map(([file]) => file).sort()

test('server code does not read or write the retired per-turn tables', () => {
  const retired = /\b(?:regeneratedDshTurns|suppressedDshTurns|getBackgroundSuppressedTurns|sessionStateEvidence|replaceSessionSurface)\b|Chat\.branchRegistry|chat\.branchRegistry/
  assert.deepEqual(filesMatching(retired).filter(file => file !== 'domain/session-surface-mutations.js'), [])
  assert.deepEqual(filesMatching(/\bchat\??\.branchRegistry\b/), [])
})

test('client code does not hide host chat rows by turn', () => {
  const retired = /createTurnHistoryProjection|history-viewport|regeneratedDshTurns|suppressedDshTurns|getBackgroundSuppressedTurns|data-dsh-tavern-turn-hidden|dsh-tavern-hidden-user-turn/
  assert.deepEqual(clientMatching(retired), [])
  // The only remaining reference to the old localStorage keys is the cleanup.
  const keys = clientMatching(/dsh-tavern-hidden-turns|dsh-tavern-rolled-back-turns|dsh-tavern-hidden-regen-user-turns/)
  assert.deepEqual(keys, ['main.js'])
  assert.match(clientSources.get('main.js'), /function forgetRetiredHidingKeys/)
})
