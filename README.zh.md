# dsh-plugin-reloader

[English](README.md) | 中文

让已安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件**无需重启 `dsh web`** 即可热更新。升级插件（如 `dsh plugin add github:...`）后，新代码就地生效；只有依赖树变化才需要重启进程（配合外部 supervisor 脚本自动拉起）。

它复用了 dsh 内置 HMR 为用户代码提供的同一套重载流水线——清模块缓存、重新导入插件入口、销毁旧 fiber、挂载新 fiber、失败自动回滚——只是去掉了「排除 `node_modules`」的限制（正是这个限制让内置 HMR 不碰已安装插件）。dsh 的 vendored loader 默认就暴露内部模块缓存，无需任何特殊 flag。

## 功能

- **自动热重载** — 监听已加载的 `@deepseek-ai/*` 与 `@deepforce/*` 插件的真实包目录（解析 pnpm 符号链接）；`lib/` 或 `src/` 下文件变化时自动热重载对应插件（带防抖）。
- **`/reload <插件>` 命令** — 手动热重载一个已安装插件；不带参数时列出可重载的插件。
- **依赖变化自动重启** — 若某插件的 `package.json` 改变了 `dependencies`/`peerDependencies`，进程以退出码 `42`（可配置）退出，由 supervisor 重新拉起。
- **失败回滚** — 重新导入或挂载失败时恢复模块缓存和旧插件，会话继续运行。

## 安装

```sh
dsh plugin --profile web add github:deepforce/dsh-plugin-reloader
```

先重启一次 `dsh web` 让插件加载。要让「依赖变化自动重启」生效，请用 supervisor 启动 dsh，而不是直接启动：

```sh
# Windows (cmd)
scripts\dsh-restart.cmd web

# Windows (PowerShell)
powershell -File scripts\dsh-restart.ps1 web
```

## 用法

升级已安装插件后：

```sh
dsh plugin --profile web add github:deepforce/dsh-balance   # 升级
```

监听器发现 `lib/` 文件变化后会自动热重载——无需重启。想手动触发就在会话里敲 `/reload @deepforce/dsh-balance`；不带参数敲 `/reload` 列出候选插件。

如果升级还改变了插件的依赖树，进程会以 `42` 退出，supervisor 自动重新拉起 `dsh web`（注意：直接用 `dsh web` 启动时进程只是退出，不会自动重启，必须用 supervisor）。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `watchEnabled` | `true` | 是否监听已加载插件并在代码变化时热重载 |
| `watchRoots` | `["@deepseek-ai", "@deepforce"]` | profile 的 `node_modules` 下要考虑的 scope 目录 |
| `debounceMs` | `400` | 文件变化合并窗口（毫秒） |
| `restartExitCode` | `42` | 依赖树变化时的退出码（supervisor 据此重启） |

覆盖示例：

```yaml
# reloader.cordis.yml
- patch:
    - id: plugin-reloader
      config:
        debounceMs: 600
        restartExitCode: 50
```

## 兼容性

已在 DeepSeek Harness `0.1.0-rc.6`（web profile，Windows 11，Node 24）上验证。它依赖 loader 的内部模块缓存（`loader.internal`），vendored loader 默认暴露；若未来 dsh 移除该接口，插件会降级为 `/reload` 报告「loader internal is unavailable」。

## 安全

- 监听器只读文件，自身不执行任何东西。
- 重载失败会回滚，不会留下半挂载的插件。
- 依赖变化退出是有意为之，退出前会在日志中说明。

## 本地构建

```sh
pnpm install        # 依赖 pnpm-workspace.yaml 的 overrides 以绕过上游 npm 缺失包
pnpm run build      # tsc 输出 lib/index.js
```

## 许可证

MIT
