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
import { watch } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-reloader';
/** Services this plugin requires before it loads. */
export const inject = ['commands'];
const DEFAULT_RESTART_EXIT_CODE = 42;
export const Config = z.object({
    watchEnabled: z.boolean().default(true),
    watchRoots: z.array(z.string()).default(['@deepseek-ai', '@deepforce']),
    debounceMs: z.number().step(1).min(50).default(400),
    restartExitCode: z.number().step(1).min(0).max(255).default(DEFAULT_RESTART_EXIT_CODE),
});
function resolveConfig(config) {
    return {
        watchEnabled: config.watchEnabled ?? true,
        watchRoots: config.watchRoots ?? ['@deepseek-ai', '@deepforce'],
        debounceMs: config.debounceMs ?? 400,
        restartExitCode: config.restartExitCode ?? DEFAULT_RESTART_EXIT_CODE,
    };
}
/** Render a thrown value without trusting its string coercion. */
function renderError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Resolve a plugin specifier to its entry file URL through the internal loader. */
async function resolveUrl(internal, specifier, parentURL) {
    if (internal.version === 'v1') {
        const result = await internal.resolve(specifier, parentURL, {});
        return result.url;
    }
    const result = internal.resolveSync(parentURL, { specifier, attributes: {} });
    return result.url;
}
/** Walk up from a module file to the package root that owns its package.json. */
function findPackageRoot(entryPath) {
    let dir = dirname(entryPath);
    while (true) {
        if (existsSync(resolve(dir, 'package.json')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/** Collect every loaded module URL that lives inside one package root. */
async function collectPackageModules(internal, entryUrl, packageRoot) {
    const urls = new Set();
    // Use the LoadCache's own get (returns the ModuleJob; on Node 24 the map
    // value is a { [type]: ModuleJob } wrapper that Map.prototype.get would
    // return instead).
    const job = internal.loadCache.get(entryUrl);
    if (job === undefined)
        return urls;
    const seen = new Set();
    const stack = [job];
    while (stack.length > 0) {
        const current = stack.pop();
        if (seen.has(current.url) || !current.url.startsWith('file:'))
            continue;
        seen.add(current.url);
        const filepath = fileURLToPath(current.url);
        if (!filepath.startsWith(packageRoot))
            continue;
        urls.add(current.url);
        stack.push(...(await current.linked));
    }
    return urls;
}
/** Backup-and-clear the ESM loadCache and CJS require.cache for the given URLs. */
function clearCaches(internal, urls) {
    const require = createRequire(import.meta.url);
    const esmBackup = new Map();
    const cjsBackup = new Map();
    for (const url of urls) {
        const job = internal.loadCache.get(url);
        if (job !== undefined) {
            esmBackup.set(url, job);
            Map.prototype.delete.call(internal.loadCache, url);
        }
        try {
            const filepath = fileURLToPath(url);
            if (require.cache[filepath]) {
                cjsBackup.set(filepath, require.cache[filepath]);
                delete require.cache[filepath];
            }
        }
        catch {
            // Non-file URL (node: builtin); nothing to clear.
        }
    }
    return () => {
        for (const [url, job] of esmBackup)
            Map.prototype.set.call(internal.loadCache, url, job);
        for (const [filepath, mod] of cjsBackup)
            require.cache[filepath] = mod;
    };
}
/** Hot-reload one loaded plugin: clear caches, re-import, rebuild fibers, rollback on failure. */
export async function reloadPlugin(ctx, pluginName) {
    const trace = (step, detail) => {
        // warn, not info: the default dsh log level filters info lines, and these
        // step diagnostics are exactly what a failed reload needs to show.
        ctx.logger.warn('[plugin-reloader] reload "%s": %s%s', pluginName, step, detail === undefined ? '' : ` (${detail})`);
    };
    const loader = ctx.get('loader');
    if (loader === undefined || loader.internal === undefined) {
        trace('loader internal unavailable');
        return { ok: false, message: 'loader internal is unavailable' };
    }
    const internal = loader.internal;
    const entry = [...loader.entries()].find((candidate) => candidate.options.name === pluginName);
    if (entry === undefined) {
        trace('no loader entry');
        return { ok: false, message: `no loader entry named "${pluginName}"` };
    }
    const baseUrl = entry.parent.tree.ctx.baseUrl;
    if (baseUrl === undefined) {
        trace('no base URL');
        return { ok: false, message: `entry "${pluginName}" has no base URL` };
    }
    let entryUrl;
    try {
        entryUrl = await resolveUrl(internal, pluginName, baseUrl);
        trace('resolved entry', entryUrl);
    }
    catch (error) {
        trace('resolve failed', renderError(error));
        return { ok: false, message: `cannot resolve "${pluginName}": ${renderError(error)}` };
    }
    // pnpm installs plugins behind symlinks; Node's ESM loadCache is keyed by
    // the real path, so resolve the link before consulting it.
    let realEntryUrl;
    try {
        realEntryUrl = pathToFileURL(await realpath(fileURLToPath(entryUrl))).href;
        trace('real entry', realEntryUrl);
    }
    catch (error) {
        trace('realpath failed', renderError(error));
        return { ok: false, message: `cannot resolve the real path of "${pluginName}": ${renderError(error)}` };
    }
    const job = internal.loadCache.get(realEntryUrl);
    if (job === undefined || job.module === undefined) {
        trace('not in module cache', realEntryUrl);
        // Diagnostic: enumerate any cache keys that mention this plugin. Use the
        // package basename ("dsh-balance") — cache URL keys keep the scoped form
        // "@deepforce/dsh-balance", so an @-stripped fragment would never match.
        const fragment = pluginName.slice(pluginName.indexOf('/') + 1);
        const similar = [];
        for (const key of internal.loadCache.keys()) {
            const text = String(key);
            if (text.includes(fragment))
                similar.push(text);
        }
        trace('similar cache keys', similar.length > 0 ? similar.join(' | ') : '(none)');
        return {
            ok: false,
            message: `"${pluginName}" is not in the module cache (${realEntryUrl}); `
                + `similar cache keys: ${similar.length > 0 ? similar.join(' | ') : '(none)'}`,
        };
    }
    const plugin = loader.unwrapExports(job.module.getNamespace());
    if (plugin === undefined) {
        trace('unwrap failed');
        return { ok: false, message: `cannot unwrap exports of "${pluginName}"` };
    }
    const packageRoot = findPackageRoot(fileURLToPath(realEntryUrl));
    if (packageRoot === undefined) {
        trace('no package root');
        return { ok: false, message: `cannot find the package root of "${pluginName}"` };
    }
    const urls = await collectPackageModules(internal, realEntryUrl, packageRoot);
    trace('collecting modules', `${urls.size} urls`);
    const rollback = clearCaches(internal, urls);
    let fresh;
    try {
        trace('re-importing');
        fresh = loader.unwrapExports(await loader.import(realEntryUrl, () => []));
        trace('re-imported');
    }
    catch (error) {
        trace('re-import failed', renderError(error));
        rollback();
        return { ok: false, message: `re-import of "${pluginName}" failed: ${renderError(error)}` };
    }
    if (fresh === undefined) {
        trace('re-import produced no plugin');
        rollback();
        return { ok: false, message: `re-import of "${pluginName}" produced no plugin` };
    }
    const runtime = ctx.registry.get(plugin);
    if (runtime === undefined) {
        trace('no live runtime');
        rollback();
        return { ok: false, message: `"${pluginName}" has no live fiber` };
    }
    // Snapshot the fibers BEFORE disposing: disposal removes them from the
    // runtime list asynchronously, and each rebuilt fiber needs its own config.
    const fibers = [...runtime.fibers];
    trace('fibers', String(fibers.length));
    if (fibers.length === 0) {
        trace('no live fiber');
        rollback();
        return { ok: false, message: `"${pluginName}" has no live fiber` };
    }
    const mount = (target, outer) => {
        for (const oldFiber of fibers) {
            const fiber = oldFiber.parent.registry.plugin(target, oldFiber._config, outer);
            fiber.entry = oldFiber.entry;
            if (fiber.entry)
                fiber.entry.fiber = fiber;
        }
    };
    try {
        trace('disposing old fibers');
        ctx.registry.delete(plugin);
        trace('mounting fresh plugin');
        mount(fresh, () => []);
        trace('done');
        return { ok: true, message: `reloaded "${pluginName}" (${urls.size} modules)` };
    }
    catch (error) {
        // Roll back: restore caches and re-mount the previous plugin.
        trace('mount failed, rolling back', renderError(error));
        rollback();
        try {
            ctx.registry.delete(fresh);
            mount(plugin, () => []);
        }
        catch {
            // The rollback mount itself failed; the old fiber is gone.
        }
        return { ok: false, message: `reload of "${pluginName}" failed and rolled back: ${renderError(error)}` };
    }
}
/** Snapshot of each watched plugin's dependency map, for change detection. */
const dependencySnapshots = new Map();
/** Read a plugin's resolved dependency map (dependencies + peerDependencies). */
function readDependencyMap(packageRoot) {
    try {
        const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
        return JSON.stringify({ ...manifest.dependencies, ...manifest.peerDependencies });
    }
    catch {
        return '';
    }
}
/**
 * Watch the loaded plugins' real package directories. Code changes hot-reload
 * the owning plugin; a dependency-map change exits with the restart code so an
 * external supervisor can relaunch the process.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @returns an async disposer closing every watcher.
 */
export async function startWatch(ctx, config) {
    const loader = ctx.get('loader');
    const resolved = resolveConfig(config);
    if (loader === undefined || loader.internal === undefined) {
        throw new Error('loader internal is unavailable; watching disabled');
    }
    const internal = loader.internal;
    const watchers = [];
    const pending = new Map();
    const queueReload = (pluginName) => {
        const existing = pending.get(pluginName);
        if (existing)
            clearTimeout(existing);
        pending.set(pluginName, setTimeout(() => {
            pending.delete(pluginName);
            void reloadPlugin(ctx, pluginName).then((result) => {
                if (result.ok) {
                    ctx.logger.info('[plugin-reloader] %s', result.message);
                }
                else {
                    ctx.logger.warn('[plugin-reloader] %s', result.message);
                }
            });
        }, resolved.debounceMs));
    };
    for (const entry of [...loader.entries()]) {
        const pluginName = entry.options.name;
        const scope = pluginName.slice(0, pluginName.indexOf('/') + 1);
        if (scope === '' || !resolved.watchRoots.includes(scope))
            continue;
        if (!pluginName.startsWith('@'))
            continue;
        const baseUrl = entry.parent.tree.ctx.baseUrl;
        if (baseUrl === undefined)
            continue;
        let entryUrl;
        try {
            entryUrl = await resolveUrl(internal, pluginName, baseUrl);
        }
        catch {
            continue;
        }
        const packageRoot = findPackageRoot(fileURLToPath(entryUrl));
        if (packageRoot === undefined)
            continue;
        const real = await realpath(packageRoot);
        dependencySnapshots.set(pluginName, readDependencyMap(real));
        const watcher = watch(real, {
            ignoreInitial: true,
            depth: 4,
            ignored: (path) => path.includes(`${resolve(real, 'node_modules')}`),
            awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        });
        watcher.on('all', (_event, path) => {
            const rel = relative(real, path);
            if (rel.startsWith('..') || rel.includes('node_modules'))
                return;
            if (rel === 'package.json') {
                const next = readDependencyMap(real);
                const previous = dependencySnapshots.get(pluginName);
                dependencySnapshots.set(pluginName, next);
                if (previous !== undefined && previous !== next) {
                    ctx.logger.warn(`[plugin-reloader] "${pluginName}" changed its dependency tree; exiting ${resolved.restartExitCode} for the supervisor to restart`);
                    process.exit(resolved.restartExitCode);
                }
                return;
            }
            // Code change: hot-reload the owning plugin.
            if (/^lib[\\/]/.test(rel) || /^src[\\/]/.test(rel))
                queueReload(pluginName);
        });
        watchers.push(watcher);
    }
    return async () => {
        for (const watcher of watchers)
            await watcher.close();
        for (const timer of pending.values())
            clearTimeout(timer);
        pending.clear();
    };
}
/**
 * Register `/reload` and the watcher on the composed context.
 * @param ctx - context carrying the command registry.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    if (resolved.watchEnabled) {
        ctx.effect(() => {
            let stop;
            void startWatch(ctx, config).then((cleanup) => { stop = cleanup; }, (error) => {
                ctx.logger.warn('[plugin-reloader] watching disabled: %s', renderError(error));
            });
            return () => { void stop?.(); };
        }, 'plugin-reloader: watch');
    }
    ctx.effect(function* () {
        yield ctx.commands.register({
            name: 'reload',
            description: 'Hot-reload an installed plugin (no restart)',
            // Required: a command must declare `input` for an argued line to be
            // adjudicated as a command (matchEnter returns miss otherwise, and the
            // line falls to the default sink as an ordinary message).
            input: { hint: '<plugin-name>' },
            handler: async (invocation) => {
                const target = invocation.rawInput.trim();
                const loader = ctx.get('loader');
                if (target === '') {
                    const names = loader === undefined
                        ? []
                        : [...loader.entries()].map((entry) => entry.options.name).filter((n) => n.startsWith('@'));
                    return {
                        kind: 'success',
                        text: `usage: /reload <plugin>\nloaded plugins:\n  ${names.join('\n  ')}`,
                    };
                }
                const result = await reloadPlugin(ctx, target);
                return result.ok
                    ? { kind: 'success', text: result.message }
                    : { kind: 'error', text: result.message };
            },
        });
    }, 'plugin-reloader: commands');
}
