import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

// Host adapters only: apply(), HTTP dispatch, storage, and projections stay real.
// Call from an isolated child process with its own DSH_HOME.
export async function createPluginHost(additionalServices = []) {
  globalThis.fetch = async () => new Response('/* test asset */', { headers: { 'content-type': 'text/css' } })
  const { apply } = await import('../../tavern-plugin/lib/index.js')
  const routes = new Map(), events = new Set(), disposers = []
  const services = new Map([
    ['settings', { describe: () => [] }], ['llm', {}],
    ['tokenMeter', { _foldEvent() {} }], ['skills', { registerProvider() {} }],
    ['agentPresets', { resolvedRoots: [] }], ['agents', new Map()], ['sessions', new Map()],
    ['webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }]
  ])
  for (const [name, service] of additionalServices) services.set(name, service)
  const dispose = async () => { for (const callback of disposers.reverse()) await callback() }
  try {
    await apply({
      get: name => services.get(name),
      inject(names, callback) { if (names.every(name => services.has(name))) return callback(this) },
      llm: services.get('llm'),
      effect(callback) { const stop = callback(); if (typeof stop === 'function') disposers.push(stop) },
      on: name => events.add(name),
      provide: (name, value) => services.set(name, value)
    })
    await new Promise(resolve => setImmediate(resolve))
  } catch (error) { await dispose(); throw error }
  return {
    services, events, dispose,
    async rpc(method, args = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(args))])
      Object.assign(req, { method: 'POST', url: '/api/dsh-tavern/' + method, headers: {} })
      let status, body
      await routes.get('/api/dsh-tavern')(req, { writeHead(code) { status = code }, end(value) { body = value } })
      assert.equal(status, 200)
      const result = JSON.parse(body)
      assert.equal(result.ok, true, result.error)
      return result
    }
  }
}
