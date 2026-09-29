import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('full Tavern apply installs and disposes actual host history adapter in isolated home',async()=>{
  const root=await mkdtemp('/home/claw/dsh-tavern-dev/algebra-startup-')
  const result=await promisify(execFile)(process.execPath,['tests/algebra/plugin-startup.mjs'],{
    cwd:new URL('../..',import.meta.url),env:{...process.env,DSH_HOME:root,DSH_TAVERN_CLI_HOME:root},timeout:30000,maxBuffer:4*1024*1024
  })
  assert.match(result.stdout,/plugin apply and real history gate installed/)
  assert.match(result.stdout,/history gate disposed/)
})
