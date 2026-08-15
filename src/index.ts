/**
 * Hot-reload installed DeepSeek Harness plugins without restarting dsh web.
 *
 * The plugin watches the loaded plugins' real package directories (resolving
 * pnpm symlinks), and on a code change re-imports the plugin entry through the
 * loader's module cache, disposes the old fibers, and mounts fresh ones — the
 * same reload pipeline dsh's built-in HMR uses for user code, minus the
 * node_modules exclusion. A `package.json` change that alters the dependency
 * tree exits with a dedicated code so an external supervisor restarts the
 * process (code alone cannot cover a dependency swap). A `/reload` command
 * triggers the same path manually.
 *
 * @module @deepforce/dsh-plugin-reloader
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: merges ctx.loader and Fiber.entry; Loader / ModuleLoader types.
import type { Loader, ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-reloader'

/** Services this plugin requires before it loads. */
export const inject = ['commands']

const DEFAULT_RESTART_EXIT_CODE = 42

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml.
 */
export interface Config {
  /** Watch loaded plugins and hot-reload them on change (default true). */
  watchEnabled?: boolean
  /** Scoped directories under the profile's node_modules to consider (default ['@deepseek-ai', '@deepforce']). */
  watchRoots?: string[]
  /** Change coalescing window in milliseconds (default 400). */
  debounceMs?: number
  /** Polling interval in milliseconds for change detection (default 2000). */
  pollIntervalMs?: number
  /** Exit code signalling the supervisor to restart (dependency-tree changes). */
  restartExitCode?: number
}

export const Config: z<Config> = z.object({
  watchEnabled: z.boolean().default(true),
  watchRoots: z.array(z.string()).default(['@deepseek-ai', '@deepforce']),
  debounceMs: z.number().step(1).min(50).default(400),
  pollIntervalMs: z.number().step(1).min(200).default(2000),
  restartExitCode: z.number().step(1).min(0).max(255).default(DEFAULT_RESTART_EXIT_CODE),
})

function resolveConfig(config: Config) {
  return {
    watchEnabled: config.watchEnabled ?? true,
    watchRoots: config.watchRoots ?? ['@deepseek-ai', '@deepforce'],
    debounceMs: config.debounceMs ?? 400,
    pollIntervalMs: config.pollIntervalMs ?? 2000,
    restartExitCode: config.restartExitCode ?? DEFAULT_RESTART_EXIT_CODE,
  }
}

/** Render a thrown value without trusting its string coercion. */
function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve a plugin specifier to its entry file URL through the internal loader. */
async function resolveUrl(
  internal: ModuleLoader,
  specifier: string,
  parentURL: string,
): Promise<string> {
  if (internal.version === 'v1') {
    const result = await internal.resolve(specifier, parentURL, {})
    return result.url
  }
  const result = internal.resolveSync(parentURL, { specifier, attributes: {} })
  return result.url
}

/** Walk up from a module file to the package root that owns its package.json. */
function findPackageRoot(entryPath: string): string | undefined {
  let dir = dirname(entryPath)
  while (true) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Collect every loaded module URL that lives inside one package root. */
async function collectPackageModules(
  internal: ModuleLoader,
  entryUrl: string,
  packageRoot: string,
): Promise<Set<string>> {
  const urls = new Set<string>()
  // Use the LoadCache's own get (returns the ModuleJob; on Node 24 the map
  // value is a { [type]: ModuleJob } wrapper that Map.prototype.get would
  // return instead).
  const job = internal.loadCache.get(entryUrl)
  if (job === undefined) return urls
  const seen = new Set<string>()
  const stack = [job]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current.url) || !current.url.startsWith('file:')) continue
    seen.add(current.url)
    const filepath = fileURLToPath(current.url)
    if (!filepath.startsWith(packageRoot)) continue
    urls.add(current.url)
    stack.push(...(await current.linked))
  }
  return urls
}

/** Backup-and-clear the ESM loadCache and CJS require.cache for the given URLs. */
function clearCaches(internal: ModuleLoader, urls: Set<string>): () => void {
  const require = createRequire(import.meta.url)
  const esmBackup = new Map<string, unknown>()
  const cjsBackup = new Map<string, NodeModule>()
  for (const url of urls) {
    const job = internal.loadCache.get(url)
    if (job !== undefined) {
      esmBackup.set(url, job)
      Map.prototype.delete.call(internal.loadCache, url)
    }
    try {
      const filepath = fileURLToPath(url)
      if (require.cache[filepath]) {
        cjsBackup.set(filepath, require.cache[filepath])
        delete require.cache[filepath]
      }
    } catch {
      // Non-file URL (node: builtin); nothing to clear.
    }
  }
  return () => {
    for (const [url, job] of esmBackup) Map.prototype.set.call(internal.loadCache, url, job)
    for (const [filepath, mod] of cjsBackup) require.cache[filepath] = mod
  }
}

/** Hot-reload one loaded plugin: clear caches, re-import, rebuild fibers, rollback on failure. */
export async function reloadPlugin(ctx: Context, pluginName: string): Promise<{ ok: boolean; message: string }> {
  const trace = (step: string, detail?: string): void => {
    // warn, not info: the default dsh log level filters info lines, and these
    // step diagnostics are exactly what a failed reload needs to show.
    ctx.logger.warn('[plugin-reloader] reload "%s": %s%s', pluginName, step, detail === undefined ? '' : ` (${detail})`)
  }

  const loader = ctx.get('loader')
  if (loader === undefined || loader.internal === undefined) {
    trace('loader internal unavailable')
    return { ok: false, message: 'loader internal is unavailable' }
  }
  const internal = loader.internal

  const entry = [...loader.entries()].find((candidate) => candidate.options.name === pluginName)
  if (entry === undefined) {
    trace('no loader entry')
    return { ok: false, message: `no loader entry named "${pluginName}"` }
  }
  const baseUrl = entry.parent.tree.ctx.baseUrl
  if (baseUrl === undefined) {
    trace('no base URL')
    return { ok: false, message: `entry "${pluginName}" has no base URL` }
  }

  let entryUrl: string
  try {
    entryUrl = await resolveUrl(internal, pluginName, baseUrl)
    trace('resolved entry', entryUrl)
  } catch (error) {
    trace('resolve failed', renderError(error))
    return { ok: false, message: `cannot resolve "${pluginName}": ${renderError(error)}` }
  }

  // pnpm installs plugins behind symlinks; Node's ESM loadCache is keyed by
  // the real path, so resolve the link before consulting it.
  let realEntryUrl: string
  try {
    realEntryUrl = pathToFileURL(await realpath(fileURLToPath(entryUrl))).href
    trace('real entry', realEntryUrl)
  } catch (error) {
    trace('realpath failed', renderError(error))
    return { ok: false, message: `cannot resolve the real path of "${pluginName}": ${renderError(error)}` }
  }

  const job = internal.loadCache.get(realEntryUrl)
  if (job === undefined || job.module === undefined) {
    trace('not in module cache', realEntryUrl)
    // Diagnostic: enumerate any cache keys that mention this plugin. Use the
    // package basename ("dsh-balance") — cache URL keys keep the scoped form
    // "@deepforce/dsh-balance", so an @-stripped fragment would never match.
    const fragment = pluginName.slice(pluginName.indexOf('/') + 1)
    const similar: string[] = []
    for (const key of internal.loadCache.keys()) {
      const text = String(key)
      if (text.includes(fragment)) similar.push(text)
    }
    trace('similar cache keys', similar.length > 0 ? similar.join(' | ') : '(none)')
    return {
      ok: false,
      message: `"${pluginName}" is not in the module cache (${realEntryUrl}); `
        + `similar cache keys: ${similar.length > 0 ? similar.join(' | ') : '(none)'}`,
    }
  }
  const plugin = loader.unwrapExports(job.module.getNamespace())
  if (plugin === undefined) {
    trace('unwrap failed')
    return { ok: false, message: `cannot unwrap exports of "${pluginName}"` }
  }

  const packageRoot = findPackageRoot(fileURLToPath(realEntryUrl))
  if (packageRoot === undefined) {
    trace('no package root')
    return { ok: false, message: `cannot find the package root of "${pluginName}"` }
  }

  const urls = await collectPackageModules(internal, realEntryUrl, packageRoot)
  trace('collecting modules', `${urls.size} urls`)
  const rollback = clearCaches(internal, urls)

  let fresh: Plugin | undefined
  try {
    trace('re-importing')
    fresh = loader.unwrapExports(await loader.import(realEntryUrl, () => []))
    trace('re-imported')
  } catch (error) {
    trace('re-import failed', renderError(error))
    rollback()
    return { ok: false, message: `re-import of "${pluginName}" failed: ${renderError(error)}` }
  }
  if (fresh === undefined) {
    trace('re-import produced no plugin')
    rollback()
    return { ok: false, message: `re-import of "${pluginName}" produced no plugin` }
  }

  const runtime = ctx.registry.get(plugin)
  if (runtime === undefined) {
    trace('no live runtime')
    rollback()
    return { ok: false, message: `"${pluginName}" has no live fiber` }
  }
  // Snapshot the fibers BEFORE disposing: disposal removes them from the
  // runtime list asynchronously, and each rebuilt fiber needs its own config.
  const fibers = [...runtime.fibers]
  trace('fibers', String(fibers.length))
  if (fibers.length === 0) {
    trace('no live fiber')
    rollback()
    return { ok: false, message: `"${pluginName}" has no live fiber` }
  }

  const mount = (target: Plugin, outer: () => string[]): void => {
    for (const oldFiber of fibers) {
      const fiber = oldFiber.parent.registry.plugin(target, oldFiber._config, outer)
      fiber.entry = oldFiber.entry
      if (fiber.entry) fiber.entry.fiber = fiber
    }
  }

  try {
    trace('disposing old fibers')
    ctx.registry.delete(plugin)
    trace('mounting fresh plugin')
    mount(fresh, () => [])
    trace('done')
    return { ok: true, message: `reloaded "${pluginName}" (${urls.size} modules)` }
  } catch (error) {
    // Roll back: restore caches and re-mount the previous plugin.
    trace('mount failed, rolling back', renderError(error))
    rollback()
    try {
      ctx.registry.delete(fresh)
      mount(plugin, () => [])
    } catch {
      // The rollback mount itself failed; the old fiber is gone.
    }
    return { ok: false, message: `reload of "${pluginName}" failed and rolled back: ${renderError(error)}` }
  }
}

/** Snapshot of each watched plugin's dependency map, for change detection. */
const dependencySnapshots = new Map<string, string>()

/** Read a plugin's resolved dependency map (dependencies + peerDependencies). */
function readDependencyMap(packageRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    return JSON.stringify({ ...manifest.dependencies, ...manifest.peerDependencies })
  } catch {
    return ''
  }
}

/** One watched scope directory and the packages under it. */
export interface WatchScope {
  dir: string
  packages: string[]
}

/** Live watch diagnostics, readable from the `/watch-status` command. */
export interface WatchState {
  started: boolean
  modulesDir?: string
  scopes: WatchScope[]
  /** Whether every chokidar watcher reached its ready state. */
  watcherReady: boolean
  /** First watcher error, if any. */
  watcherError?: string
  /** Total filesystem events observed by the watchers. */
  events: number
  /** The most recent event as "kind path". */
  lastEvent?: string
  /** Successful hot reloads triggered by the watcher. */
  reloads: number
  error?: string
}

/** Result of starting the watcher: the disposer plus live diagnostics. */
export interface WatchHandle {
  dispose: () => Promise<void>
  state: WatchState
}

/**
 * Watch the loaded plugins by polling their entry and package.json files.
 * Code changes hot-reload the owning plugin; a dependency-map change exits
 * with the restart code so an external supervisor can relaunch the process.
 *
 * Polling (stat mtime+size) replaces chokidar: in a long-lived dsh web process
 * the chokidar watcher on the scope directory never reached ready on Windows
 * (its initial scan hung), so file-change events never fired. Polling is also
 * immune to pnpm's whole-directory replacement, since the stat simply sees the
 * new files on the next tick. Plugin upgrades are low-frequency, so a 2-second
 * stat of a handful of files is negligible.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @returns the disposer plus a live {@link WatchState} diagnostics object.
 */
export async function startWatch(ctx: Context, config: Config): Promise<WatchHandle> {
  const loader = ctx.get('loader')
  const resolved = resolveConfig(config)
  const state: WatchState = { started: false, scopes: [], watcherReady: false, events: 0, reloads: 0 }
  if (loader === undefined) {
    state.error = 'loader is unavailable'
    return { dispose: async () => {}, state }
  }

  const pending = new Map<string, NodeJS.Timeout>()
  const queueReload = (pluginName: string): void => {
    const existing = pending.get(pluginName)
    if (existing) clearTimeout(existing)
    pending.set(pluginName, setTimeout(() => {
      pending.delete(pluginName)
      void reloadPlugin(ctx, pluginName).then((result) => {
        if (result.ok) state.reloads += 1
        ctx.logger.warn('[plugin-reloader] %s', result.message)
      })
    }, resolved.debounceMs))
  }

  // Group the loaded plugins by scope, skipping this plugin itself.
  const byScope = new Map<string, Set<string>>()
  for (const entry of [...loader.entries()]) {
    const pluginName = entry.options.name
    if (!pluginName.startsWith('@') || pluginName === name) continue
    const slash = pluginName.indexOf('/')
    const scope = pluginName.slice(0, slash)
    const pkg = pluginName.slice(slash + 1)
    if (pkg === '' || !resolved.watchRoots.includes(scope)) continue
    const pkgs = byScope.get(scope) ?? new Set<string>()
    pkgs.add(pkg)
    byScope.set(scope, pkgs)
  }

  const first = [...loader.entries()][0]
  const baseUrl = ctx.baseUrl ?? first?.parent.tree.ctx.baseUrl
  if (baseUrl === undefined) {
    state.error = 'no base URL'
    return { dispose: async () => {}, state }
  }
  const modulesDir = resolve(fileURLToPath(new URL(baseUrl)), 'node_modules')
  state.modulesDir = modulesDir
  if (byScope.size === 0) {
    state.error = `no plugins matched watchRoots ${JSON.stringify(resolved.watchRoots)}`
    return { dispose: async () => {}, state }
  }

  /** One polled target: the plugin's entry file and its package.json. */
  interface PollTarget {
    pluginName: string
    entry: string
    pkgJson: string
    entrySig?: string
    pkgSig?: string
  }
  const targets: PollTarget[] = []
  for (const [scope, pkgs] of byScope) {
    const scopeDir = resolve(modulesDir, scope)
    if (!existsSync(scopeDir)) {
      state.error = `scope dir missing: ${scopeDir}`
      continue
    }
    state.scopes.push({ dir: scopeDir, packages: [...pkgs] })
    for (const pkg of pkgs) {
      const pluginName = `${scope}/${pkg}`
      const dir = resolve(scopeDir, pkg)
      const pkgJson = resolve(dir, 'package.json')
      let entry = resolve(dir, 'lib/index.js')
      try {
        const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as { main?: string }
        if (typeof manifest.main === 'string' && manifest.main !== '') {
          entry = resolve(dir, manifest.main)
        }
      } catch {
        // Unreadable manifest; fall back to the default entry.
      }
      targets.push({ pluginName, entry, pkgJson })
      dependencySnapshots.set(pluginName, readDependencyMap(dir))
    }
  }

  /** One poll pass: record signatures, detect changes, act. */
  const tick = (): void => {
    for (const target of targets) {
      try {
        const entryStat = statSync(target.entry)
        const entrySig = `${entryStat.mtimeMs}:${entryStat.size}`
        if (target.entrySig !== undefined && target.entrySig !== entrySig) {
          state.events += 1
          state.lastEvent = `change ${target.entry}`
          queueReload(target.pluginName)
        }
        target.entrySig = entrySig
      } catch {
        // Entry temporarily invisible (mid-replacement); drop the signature so
        // the new file registers as a change on a later tick.
        target.entrySig = undefined
      }
      try {
        const pkgStat = statSync(target.pkgJson)
        const pkgSig = `${pkgStat.mtimeMs}:${pkgStat.size}`
        if (target.pkgSig !== undefined && target.pkgSig !== pkgSig) {
          const next = readDependencyMap(dirname(target.pkgJson))
          const previous = dependencySnapshots.get(target.pluginName)
          dependencySnapshots.set(target.pluginName, next)
          if (previous !== undefined && previous !== next) {
            ctx.logger.warn(
              `[plugin-reloader] "${target.pluginName}" changed its dependency tree; `
              + `exiting ${resolved.restartExitCode} for the supervisor to restart`,
            )
            process.exit(resolved.restartExitCode)
          }
          state.events += 1
          state.lastEvent = `change ${target.pkgJson}`
          queueReload(target.pluginName)
        }
        target.pkgSig = pkgSig
      } catch {
        target.pkgSig = undefined
      }
    }
  }

  tick() // Establish baseline signatures without acting.
  const timer = setInterval(tick, resolved.pollIntervalMs)
  state.started = targets.length > 0
  state.watcherReady = true
  return {
    dispose: async () => {
      clearInterval(timer)
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    },
    state,
  }
}

/**
 * Register `/reload` and the watcher on the composed context.
 * @param ctx - context carrying the command registry.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const watchState: WatchState = { started: false, scopes: [], watcherReady: false, events: 0, reloads: 0 }

  if (resolved.watchEnabled) {
    ctx.effect(() => {
      let dispose: (() => Promise<void>) | undefined
      void startWatch(ctx, config).then(
        (handle) => {
          watchState.started = handle.state.started
          watchState.modulesDir = handle.state.modulesDir
          watchState.scopes = handle.state.scopes
          watchState.error = handle.state.error
          dispose = handle.dispose
        },
        (error: unknown) => {
          watchState.error = renderError(error)
        },
      )
      return () => { void dispose?.() }
    }, 'plugin-reloader: watch')
  } else {
    watchState.error = 'watchEnabled is false'
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'reload',
      description: 'Hot-reload an installed plugin (no restart)',
      // Required: a command must declare `input` for an argued line to be
      // adjudicated as a command (matchEnter returns miss otherwise, and the
      // line falls to the default sink as an ordinary message).
      input: { hint: '<plugin-name>' },
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        const target = invocation.rawInput.trim()
        const loader = ctx.get('loader')
        if (target === '') {
          const names = loader === undefined
            ? []
            : [...loader.entries()].map((entry) => entry.options.name).filter((n) => n.startsWith('@'))
          return {
            kind: 'success',
            text: `usage: /reload <plugin>\nloaded plugins:\n  ${names.join('\n  ')}`,
          }
        }
        const result = await reloadPlugin(ctx, target)
        return result.ok
          ? { kind: 'success', text: result.message }
          : { kind: 'error', text: result.message }
      },
    })
    yield ctx.commands.register({
      name: 'watch-status',
      description: 'Show plugin-reloader watch status',
      handler: (): CommandResult => ({
        kind: 'success',
        text: JSON.stringify({
          started: watchState.started,
          modulesDir: watchState.modulesDir,
          scopes: watchState.scopes,
          watcherReady: watchState.watcherReady,
          watcherError: watchState.watcherError,
          events: watchState.events,
          lastEvent: watchState.lastEvent,
          reloads: watchState.reloads,
          error: watchState.error,
        }, null, 2),
      }),
    })
  }, 'plugin-reloader: commands')
}
