import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// The copied installation contains relative peer links that point outside the
// dev tree. Resolve only pinned host peers read-only, without changing symlinks
// or installing/upgrading packages.
const runtime = createRequire('/home/claw/workspace/dsh-tarvern/runtime/lib/package.json')
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try { return next(pathToFileURL(runtime.resolve(specifier)).href, context) }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error }
  }
  return next(specifier, context)
} })
