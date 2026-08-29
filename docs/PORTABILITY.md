# 平台与本地化

## 上游边界

DSH 官方仓库当前把 Linux、macOS 和 Windows 都纳入工程与发布范围：

- pull request 主门禁运行在 Ubuntu/Linux；
- runtime 发布矩阵包含 Linux x64、Linux arm64、macOS arm64 和 Windows x64；
- Windows 同时运行 Wine 阻塞门禁和原生 Windows build/native tests。

证据来自上游当前 [`ci.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/workflows/ci.yml) 和 [`pnpm-workspace.yaml`](https://github.com/deepseek-ai/deepseek-harness/blob/master/pnpm-workspace.yaml)。

这只能证明 DSH 的平台目标，不能替代 `dshctl` 自身的验证。

## dshctl 当前支持矩阵

| 平台 | 证据 | 结论 |
| --- | --- | --- |
| macOS arm64 | 真实 profiles、隔离升级、失败回滚、Web 进程恢复与 API smoke | 当前主要验证平台 |
| Linux arm64 | Debian + Node 24 容器中完整 typecheck/build/test；包含真实子进程、TCP listener 与信号测试 | 核心代码已通过，真实 DSH profile E2E 待补 |
| Windows | 仅有少量路径解析代码，没有原生执行与生命周期测试 | 当前不支持 |

Linux 当前依赖 procps 兼容的 `ps`。`lsof` 只用于尽力恢复进程工作目录，缺失时会回退到当前目录。正式标记 Linux 完整支持前，还必须在真实 DSH profiles 上验证检查、隔离安装、切换、回滚和服务恢复。

Windows 的确定缺口是：

1. `dsh`、`pnpm` 通常由 `.cmd` shim 提供，不能依赖 POSIX 式 `spawn(..., shell: false)`。
2. 运行实例发现依赖 `ps`，Windows 需要原生进程枚举或受控 PowerShell/CIM adapter。
3. SIGINT/SIGTERM 终止阶梯是 POSIX 语义，Windows 需要独立的进程树和端口安全门槛实现。
4. 必须在原生 Windows 验证目录替换、锁文件、回滚和 detached Web 恢复，不能用 macOS mock 宣称兼容。

## 本地化目标

当前人类可读输出是简体中文。这适合本地使用，但不满足公开分发条件。目标行为是：

- 支持 `en` 与 `zh-CN`；
- 中文系统默认 `zh-CN`，其他系统默认 `en`；
- `--lang en|zh-CN` 优先于 `DSHCTL_LANG`，二者再优先于系统 locale；
- CLI 帮助、进度、确认、结论、错误和人工建议使用同一 locale；
- JSON receipt 不翻译，使用稳定 reason code 与结构化参数；
- 包名、版本、路径、命令和远端原始诊断保持原样，不作为翻译键。

实现顺序是先把 compatibility、assessment、upgrade 和 runtime 的判断改为 reason code，再建立 locale catalog 和 renderer，最后增加两种语言的 CLI golden tests。只翻译 `--help` 或顶层成功文案会留下混合语言输出，不算完成英文适配。

DSH 自身已有客户端 locale 服务和第三方语言注册能力，但 `dshctl` 必须在 DSH 无法启动时仍能诊断和恢复，因此不能把自己的 CLI 翻译依赖放进 DSH 运行时。它会使用独立的小型 catalog，同时沿用上游的 `zh`/`en` 双语维护原则。
