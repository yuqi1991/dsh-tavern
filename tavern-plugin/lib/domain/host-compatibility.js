import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Allowlist: listed DSH versions run; any other (or unreadable) version is blocked.
// Maintained by hand in config/dsh-compatibility.json when a new DSH release is checked.
export function classifyDshVersion(version, policy) {
  const allowed = policy.allowedDshVersions || [policy.adaptedDshVersion]
  const base = { version: version || '', allowedVersions: allowed }
  if (version && allowed.includes(version)) return { ...base, status: 'allowed', reason: '' }
  return { ...base, status: 'blocked', reason: version ? `DSH ${version} 不在允许清单` : '无法识别当前 DSH 版本' }
}

export function classifyHostVersion(version, policy) {
  const result = classifyDshVersion(version, policy)
  const message = result.status === 'allowed' ? ''
    : `${result.reason}，酒馆可能无法正常使用。允许的版本：${result.allowedVersions.join('、')}。`
  return Object.freeze({ ...result, packageName: '@deepseek-ai/dsh-session', message })
}

// Resolve from the actual host dependency, not PATH or another installed CLI.
// Called once during plugin startup; the returned immutable value is reused.
export function readHostCompatibility({ resolveHost, read = readFileSync } = {}) {
  const policy = JSON.parse(read(new URL('../../../config/dsh-compatibility.json', import.meta.url), 'utf8'))
  let version = ''
  try {
    const resolve = resolveHost || (() => {
      const plugin = createRequire(new URL('../../package.json', import.meta.url))
      return createRequire(plugin.resolve('@deepseek-ai/dsh-tools')).resolve('@deepseek-ai/dsh-session')
    })
    let dir = dirname(resolve())
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(read(join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@deepseek-ai/dsh-session') { version = String(pkg.version || ''); break }
      } catch { /* Entry points may be nested below the package root. */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* Unknown must not prevent starting the user's game. */ }
  return classifyHostVersion(version, policy)
}
