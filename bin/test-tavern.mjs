import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { findDshCommand, SOURCE_ROOT } from './launcher-environment.mjs'
import { resolveDshBootModule } from './plugin-dependencies.mjs'

function bootModule() {
  if (process.env.DSH_BOOT_MODULE) return path.resolve(process.env.DSH_BOOT_MODULE)
  const dsh = findDshCommand()
  return resolveDshBootModule({ dsh })
}

let boot
try {
  boot = bootModule()
} catch (error) {
  console.error(`无法运行真实 DSH 集成测试：${error.message}`)
  console.error('请先安装 DSH，或通过 DSH_BOOT_MODULE 指向 dsh-app-boot/lib/index.js。')
  process.exit(1)
}

const tests = ['tests', 'testsets/tests'].flatMap(directory =>
  readdirSync(path.join(SOURCE_ROOT, directory))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join(SOURCE_ROOT, directory, name)))
const result = spawnSync(process.execPath, ['--import', path.join(SOURCE_ROOT, 'tests/fixtures/host-session-patch-preload.mjs'), '--test', ...tests], {
  cwd: SOURCE_ROOT,
  env: { ...process.env, DSH_BOOT_MODULE: boot },
  stdio: 'inherit',
})
if (result.error) throw result.error

// The conversation-algebra tests install the Session patch themselves and assert
// the unpatched behaviour, so they run in their own process without the preload.
const algebra = readdirSync(path.join(SOURCE_ROOT, 'tests/algebra'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join(SOURCE_ROOT, 'tests/algebra', name))
const algebraResult = spawnSync(process.execPath, ['--test', ...algebra], {
  cwd: SOURCE_ROOT,
  env: { ...process.env, DSH_BOOT_MODULE: boot },
  stdio: 'inherit',
})
if (algebraResult.error) throw algebraResult.error
process.exit(result.status || algebraResult.status || 0)
