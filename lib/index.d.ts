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
 * triggers the same path manually. Official `@deepseek-ai` plugins and plugins
 * that provide services other plugins depend on are not reloadable by default
 * (override with `allowOfficial` / `allowServiceProviders`); skipped attempts
 * are counted in the watch diagnostics.
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
    /** Polling interval in milliseconds for change detection (default 2000). */
    pollIntervalMs?: number;
    /** Exit code signalling the supervisor to restart (dependency-tree changes). */
    restartExitCode?: number;
    /** Allow hot-reloading official @deepseek-ai plugins (default false). */
    allowOfficial?: boolean;
    /** Allow hot-reloading plugins that provide services other plugins depend on (default false). */
    allowServiceProviders?: boolean;
}
export declare const Config: z<Config>;
/** Fully resolved config with every default applied. */
export interface ResolvedConfig {
    watchEnabled: boolean;
    watchRoots: string[];
    debounceMs: number;
    pollIntervalMs: number;
    restartExitCode: number;
    allowOfficial: boolean;
    allowServiceProviders: boolean;
}
/** Whether hot-reloading a plugin is allowed under the resolved config. */
export interface ReloadVerdict {
    allowed: boolean;
    /** Why the plugin is not reloadable, when allowed is false. */
    reason?: string;
    /** Short tag for list output ("official", "service", "self"). */
    marker?: string;
}
/** Hot-reload one loaded plugin: clear caches, re-import, rebuild fibers, rollback on failure. */
export declare function reloadPlugin(ctx: Context, pluginName: string, config?: Config): Promise<{
    ok: boolean;
    message: string;
    skipped?: boolean;
}>;
/** One watched scope directory and the packages under it. */
export interface WatchScope {
    dir: string;
    packages: string[];
}
/** Live watch diagnostics, readable from the `/watch-status` command. */
export interface WatchState {
    started: boolean;
    modulesDir?: string;
    scopes: WatchScope[];
    /** Whether every chokidar watcher reached its ready state. */
    watcherReady: boolean;
    /** First watcher error, if any. */
    watcherError?: string;
    /** Total filesystem events observed by the watchers. */
    events: number;
    /** The most recent event as "kind path". */
    lastEvent?: string;
    /** Successful hot reloads triggered by the watcher. */
    reloads: number;
    /** Reload attempts skipped because the plugin is not reloadable. */
    skipped: number;
    /** Most recent skip as "plugin: reason". */
    lastSkip?: string;
    error?: string;
}
/** Result of starting the watcher: the disposer plus live diagnostics. */
export interface WatchHandle {
    dispose: () => Promise<void>;
    state: WatchState;
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
export declare function startWatch(ctx: Context, config: Config): Promise<WatchHandle>;
/**
 * Register `/reload` and the watcher on the composed context.
 * @param ctx - context carrying the command registry.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): void;
