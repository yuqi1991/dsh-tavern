import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { adaptedDshVersion, allowedDshVersions, assertCompatibleDshVersion, desktopReleasesUrl, dshaReleasesUrl } from '../bin/dsh-compatibility.mjs'
import { classifyDshVersion } from '../tavern-plugin/lib/domain/host-compatibility.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const unix = await readFile(new URL('../install.sh', import.meta.url), 'utf8')

test('宿主按允许清单：清单内放行，清单外拦截；CLI 独立运行时仍精确匹配', () => {
  for (const host of ['desktop', 'android']) {
    for (const version of allowedDshVersions) assert.doesNotThrow(() => assertCompatibleDshVersion(version, host), version)
    for (const version of ['0.1.5-rc.2', '0.2.2', '99.0.0']) {
      assert.throws(() => assertCompatibleDshVersion(version, host), error => {
        assert.match(error.message, version.startsWith('0.1.') ? /已停止安装，现有酒馆、存档和宿主都没有改动[^]*要用这个版本[^]*改装稳定版/ : /不在允许清单内；已停止安装/)
        assert.ok(error.message.includes(allowedDshVersions.join('、')))
        assert.ok(error.message.includes(host === 'desktop' ? desktopReleasesUrl : dshaReleasesUrl), error.message)
        return true
      })
    }
  }
  assert.ok(allowedDshVersions.includes(adaptedDshVersion))
  assert.doesNotThrow(() => assertCompatibleDshVersion(adaptedDshVersion, 'cli'))
  for (const version of ['', '0.2.0', '99.0.0']) assert.throws(() => assertCompatibleDshVersion(version, 'cli'), /DSH_TAVERN_REINSTALL_RUNTIME/)
})

test('允许清单只认精确版本号，读不出版本也拦截', () => {
  const policy = { adaptedDshVersion: '0.2.1-rc.2', allowedDshVersions: ['0.2.1-rc.2'] }
  assert.deepEqual(['0.2.1-rc.2', '0.2.1-rc.1', '0.2.1', ''].map(v => classifyDshVersion(v, policy).status), ['allowed', 'blocked', 'blocked', 'blocked'])
})

test('安装脚本以 --check 执行清单：清单内退出码 0，清单外非 0', () => {
  const script = fileURLToPath(new URL('../bin/dsh-compatibility.mjs', import.meta.url))
  const ok = spawnSync(process.execPath, [script, '--check', 'android', 'dsh 0.2.0-rc.2'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /在允许清单内/)
  assert.notEqual(spawnSync(process.execPath, [script, '--check', 'desktop', 'dsh 0.2.2'], { encoding: 'utf8' }).status, 0)
})

test('Unix 工具准备只处理 pnpm，不提前复用或更换 DSH', { skip: process.platform === 'win32' }, () => {
  const start = unix.indexOf('# Read the downloaded release')
  const end = unix.indexOf('if [ "${INSTALL_HOST}" = "cli" ] && [ -f', start)
  assert.ok(start >= 0 && end > start)
  const block = unix.slice(start, end)
  // Run the real shell branch while replacing all installation/filesystem effects.
  const mocks = `
command() {
  case "$2" in
    dsh) test "$HAS_DSH" = 1 ;;
    pnpm) test "$HAS_PNPM" = 1 ;;
    *) return 1 ;;
  esac
}
run_install() { shift 2; "$@"; }
assert_installation_active() { :; }
dsh() { node "\${SOURCE_DIR}/bin/dsh-compatibility.mjs" --version; }
pnpm() {
  if [ "$HAS_PNPM" = 1 ]; then printf '%s\n' "$MOCK_PNPM_VERSION"; else return 127; fi
}
mkdir() { :; }
npm() { printf 'INSTALL:%s\\n' "$*"; HAS_DSH=1; HAS_PNPM=1; }
fail() { printf 'FAIL:%s\\n' "$1"; exit 1; }
`
  for (const row of [
    { host: 'cli', dsh: '0', pnpm: '0', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '0', pnpm: '1', packages: [] },
    { host: 'cli', dsh: '1', pnpm: '0', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '1', pnpm: '1', pnpmVersion: '12.3.4', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '1', pnpm: '1', packages: [] },
    { host: 'desktop', dsh: '1', pnpm: '1', packages: [] }
  ]) {
    const result = spawnSync('sh', ['-ec', mocks + block], { encoding: 'utf8', env: {
      ...process.env, SOURCE_DIR: root, RUNTIME_ROOT: '/unused-mocked-runtime',
      INSTALL_HOST: row.host, HAS_DSH: row.dsh, HAS_PNPM: row.pnpm,
      PNPM_VERSION: '11.25.0', MOCK_PNPM_VERSION: row.pnpmVersion || '11.25.0'
    } })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const installed = result.stdout.split('\n').filter(line => line.startsWith('INSTALL:'))
    assert.deepEqual(installed, row.packages.length ? ['INSTALL:install --global --prefix /unused-mocked-runtime ' + row.packages.join(' ')] : [])
  }
})

test('宿主没有补丁要改的字号代码时跳过（返回 null），不让整个安装回滚', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { patchThemeFontLimit } = await import('../bin/theme-font-limit.mjs')
  const directory = await mkdtemp(`${tmpdir()}/tavern-theme-untested-`)
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(`${directory}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-theme', version: '0.2.0' }))
  assert.equal(patchThemeFontLimit(directory), null)
})
