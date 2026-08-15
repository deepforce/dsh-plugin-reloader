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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "plugin-reloader";
/** Services this plugin requires before it loads. */
export declare const inject: string[];
/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml.
 */
export interface Config {
    /** Watch loaded plugins and hot-reload them on change (default true). */
    watchEnabled?: boolean;
    /** Scoped directories under the profile's node_modules to consider (default ['@deepseek-ai', '@deepforce']). */
    watchRoots?: string[];
    /** Change coalescing window in milliseconds (default 400). */
    debounceMs?: number;
    /** Exit code signalling the supervisor to restart (dependency-tree changes). */
    restartExitCode?: number;
}
export declare const Config: z<Config>;
/** Hot-reload one loaded plugin: clear caches, re-import, rebuild fibers, rollback on failure. */
export declare function reloadPlugin(ctx: Context, pluginName: string): Promise<{
    ok: boolean;
    message: string;
}>;
/**
 * Watch the loaded plugins' real package directories. Code changes hot-reload
 * the owning plugin; a dependency-map change exits with the restart code so an
 * external supervisor can relaunch the process.
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @returns an async disposer closing every watcher.
 */
export declare function startWatch(ctx: Context, config: Config): Promise<() => Promise<void>>;
/**
 * Register `/reload` and the watcher on the composed context.
 * @param ctx - context carrying the command registry.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): void;
