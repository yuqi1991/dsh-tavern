import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pluginManifest = JSON.parse(await readFile(new URL('../tavern-plugin/package.json', import.meta.url), 'utf8'))
const launcherSource = await readFile(new URL('../bin/profile-installation.mjs', import.meta.url), 'utf8')
const installerSource = await readFile(new URL('../bin/plugin-dependencies.mjs', import.meta.url), 'utf8')
const pluginSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const backgroundSource = await readFile(new URL('../tavern-plugin/lib/background-agent-sessions.js', import.meta.url), 'utf8')

test('Tavern requires the adapted host release line (0.2.x) and reuses host packages', () => {
  assert.equal(pluginManifest.dependencies['@deepseek-ai/dsh-tools'], '>=0.2.0-rc.1 <0.3.0')
  assert.equal(pluginManifest.dependencies['@deepseek-ai/dsh-subagent'], '>=0.2.0-rc.1 <0.3.0')
  assert.equal(pluginManifest.dependencies['@deepseek-ai/dsh-typert-protocol'], '>=0.2.0-rc.1 <0.3.0')
  assert.match(pluginSource, /from '@deepseek-ai\/dsh-tools'/)
  assert.match(backgroundSource, /from '@deepseek-ai\/dsh-subagent'/)
  assert.match(launcherSource, /import \{[^}]*\binstallPluginDependencies\b[^}]*\} from '.\/plugin-dependencies.mjs'/)
  assert.match(installerSource, /resolveHostDependencies\(hostOptions\)/)
  assert.match(installerSource, /run\('pnpm', \['install', '--lockfile=false'\], \{ cwd: pluginDirectory \}\)/)
  assert.doesNotMatch(launcherSource, /'install'[\s\S]{0,40}'--ignore-workspace'/)
})
