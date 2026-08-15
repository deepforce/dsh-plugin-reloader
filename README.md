# dsh-plugin-reloader

English | [中文](README.zh.md)

Hot-reload installed [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins **without restarting `dsh web`**. After you upgrade a plugin (e.g. `dsh plugin add
github:...`), the new code takes effect in place; only a dependency-tree change restarts the
process (through an external supervisor script).

It reuses the same reload pipeline dsh's built-in HMR uses for user code — clear the module
caches, re-import the plugin entry, dispose the old fibers, mount fresh ones, roll back on
failure — minus the `node_modules` exclusion that keeps the built-in HMR away from installed
plugins. The loader's internal module cache is reachable through dsh's vendored loader
without any special flag.

## Features

- **Auto hot-reload** — watches the real package directories (pnpm symlinks resolved) of the
  loaded `@deepseek-ai/*` and `@deepforce/*` plugins; a change under `lib/` or `src/`
  hot-reloads that plugin (debounced).
- **`/reload <plugin>` command** — manually hot-reload one installed plugin; with no
  argument it lists the loadable plugins.
- **Dependency-change restart** — if a plugin's `package.json` changes its
  `dependencies`/`peerDependencies`, the process exits with code `42` (configurable) so a
  supervisor relaunches it.
- **Rollback on failure** — a failed re-import or mount restores the module caches and the
  previous plugin; the session keeps running.

## Install

```sh
dsh plugin --profile web add github:deepforce/dsh-plugin-reloader
```

Restart `dsh web` once so the plugin loads. For the dependency-change restart to be useful,
start dsh through the supervisor instead of directly:

```sh
# Windows (cmd)
scripts\dsh-restart.cmd web

# Windows (PowerShell)
powershell -File scripts\dsh-restart.ps1 web
```

## Usage

After upgrading an installed plugin:

```sh
dsh plugin --profile web add github:deepforce/dsh-balance   # upgrade
```

The watcher notices the changed `lib/` files and hot-reloads it — no restart. To force it
manually, type `/reload @deepforce/dsh-balance` in a session, or `/reload` with no argument
to list candidates.

If the upgrade also changed the plugin's dependency tree, the process exits `42` and the
supervisor relaunches `dsh web` automatically (a supervisor is required — a plain `dsh web`
just exits).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `watchEnabled` | `true` | Watch loaded plugins and hot-reload on code changes |
| `watchRoots` | `["@deepseek-ai", "@deepforce"]` | Scoped directories under the profile's `node_modules` to consider |
| `debounceMs` | `400` | File-change coalescing window |
| `restartExitCode` | `42` | Exit code used when a dependency tree changed (supervisor restarts on it) |

Example overlay:

```yaml
# reloader.cordis.yml
- patch:
    - id: plugin-reloader
      config:
        debounceMs: 600
        restartExitCode: 50
```

## Compatibility

Tested against DeepSeek Harness `0.1.0-rc.6` (web profile, Windows 11, Node 24). It depends
on the loader's internal module cache (`loader.internal`), which the vendored loader exposes
by default; if a future dsh removes that surface, the plugin degrades to `/reload` reporting
"loader internal is unavailable".

## Security

- The watcher only reads files; it never executes anything itself.
- A reload failure rolls back instead of leaving a half-mounted plugin.
- The dependency-change exit is intentional and announced in the log before exiting.

## Building locally

```sh
pnpm install        # uses pnpm-workspace.yaml overrides for upstream npm gaps
pnpm run build      # tsc emits lib/index.js
```

## License

MIT
