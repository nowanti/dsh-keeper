# 平台与本地化

## 上游边界

DSH 官方仓库当前把 Linux、macOS 和 Windows 都纳入工程与发布范围：

- pull request 主门禁运行在 Ubuntu/Linux；
- runtime 发布矩阵包含 Linux x64、Linux arm64、macOS arm64 和 Windows x64；
- Windows 同时运行 Wine 阻塞门禁和原生 Windows build/native tests。

证据来自上游当前 [`ci.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/workflows/ci.yml) 和 [`pnpm-workspace.yaml`](https://github.com/deepseek-ai/deepseek-harness/blob/master/pnpm-workspace.yaml)。

这只能证明 DSH 的平台目标，不能替代 `dshkeeper` 自身的验证。

## dshkeeper 当前支持矩阵

| 平台 | 证据 | 结论 |
| --- | --- | --- |
| macOS arm64 | 真实 profiles、隔离升级、失败回滚、Web 进程恢复与 API smoke | 当前主要验证平台 |
| Linux arm64 | Debian + Node 24 容器中完整 typecheck/build/test；真实安装 DSH 0.1.1-rc.2、初始化 Web profile、执行 `status` 与 `--dump-config` E2E | 本地容器证据通过；等待公开 CI 复现后固化支持声明 |
| Windows x64 | `.cmd` 安全参数桥接、CIM 进程发现、进程树终止、detached 启停实现；模拟分支测试通过 | 实现完成，仍须原生 Windows runner 的 `.cmd` 与生命周期测试通过后才标记支持 |

Linux 当前依赖 procps 兼容的 `ps`。`lsof` 只用于尽力恢复进程工作目录，缺失时会回退到当前目录。正式标记 Linux 完整支持前，还必须在真实 DSH profiles 上验证检查、隔离安装、切换、回滚和服务恢复。

Windows 采用独立平台 adapter：

1. `dsh`、`pnpm` 的检查与安装命令先编码为 JSON，再通过环境变量交给受控 PowerShell runner；detached 服务启动使用 Windows shell 打开 npm `.cmd` shim，但只接受无 shell 元字符的 binary path、受限 profile 名和有效数字端口，并且不走 Node 的 `shell + args` 拼接路径。
2. 运行实例由 `Get-CimInstance Win32_Process` 枚举；恢复服务后则通过 `Get-NetTCPConnection` 定位真正监听目标端口的 DSH 子进程，而不是把 shell wrapper PID 当服务 PID。
3. 停止路径先尝试目标 PID，只有端口已关闭但进程树残留时才调用 `taskkill /T /F`；仍在监听时拒绝继续强制清理。
4. 原生 CI 还必须证明 `.cmd` 实参不被解释、目录切换/回滚可用、detached 服务能被发现并停止。macOS 上的 platform mock 不算完成这项验收。

## 本地化实现

当前已实现：

- 支持 `en` 与 `zh-CN`；
- 中文系统默认 `zh-CN`，其他系统默认 `en`；
- `--lang en|zh-CN` 优先于 `DSHKEEPER_LANG`，二者再优先于系统 locale；
- CLI 帮助、进度、确认、结论、错误和人工建议使用同一 locale；
- JSON receipt 不翻译，使用稳定 reason code 与结构化参数；
- 包名、版本、路径、命令和远端原始诊断保持原样，不作为翻译键。

assessment receipt 已升级到 `schemaVersion: 2`。兼容判断、保持原因、Git 远端状态和 DSH core 判断均使用稳定 `reason.*` code 与参数；CLI 帮助、spinner、确认、结论、错误、升级事务和 runtime 错误统一从同一 catalog 渲染。测试同时覆盖 locale 优先级、双语诊断和语言无关 receipt。

DSH 自身已有客户端 locale 服务和第三方语言注册能力，但 `dshkeeper` 必须在 DSH 无法启动时仍能诊断和恢复，因此不能把自己的 CLI 翻译依赖放进 DSH 运行时。它会使用独立的小型 catalog，同时沿用上游的 `zh`/`en` 双语维护原则。
