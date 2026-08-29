# dshctl

`dshctl` 是 DeepSeek Harness 的外置生命周期和兼容性工具。目标是让用户通过一个命令获得一套尽可能新的、不会损失当前能力的 DSH 与插件组合：

```bash
dshctl upgrade
```

## 当前状态

当前版本可以完成插件升级事务。它会：

- 发现 `~/.dsh/profiles` 中的 profiles；
- 读取 DSH 当前版本和 npm 推荐通道；
- 检查 profile manifest、安装版本、bundle 和 patch 关系；
- 使用 pnpm 查询 npm 更新；
- 检查 npm 候选声明的 DSH、Node 和 peer dependency 兼容性；
- 按插件自身、profile、DSH 安装目录的顺序解析宿主提供的 peer；
- 检查固定 GitHub commit 与远端 HEAD 的差异；
- 调用 DSH 的 `--dump-config` 做配置预检；
- 把推荐包及依赖预缓存到 pnpm store；
- 复制不含凭据、session 和 storage 的隔离 profile，真实执行增量安装；
- 对远端不可达但已固定 commit 的 Git 插件复用本地缓存，保持原来源与版本；
- 发现精确候选后先展示待验证方案并询问一次；
- 确认后完成下载、隔离安装和 `--dump-config` 验证，整组通过才建立可恢复快照、原子切换两个 profile、复核配置并恢复原有 Web 服务；
- 任一步失败时自动恢复旧 package、lockfile、`node_modules` 和已停止的服务。

当前 DSH 核心版本如果已有更新，仍只报告而不自动切换；本里程碑自动应用的是通过整套 profile staging 的 npm 插件更新。Git HEAD 更新、patch 变化、权限扩大、新 lifecycle script 和证据不足的候选均保持当前版本。

## 使用

```bash
pnpm install
pnpm build
node dist/src/cli.js upgrade
```

常用选项：

```bash
dshctl upgrade --plugins-only
dshctl upgrade --profile web
dshctl upgrade --preview
dshctl upgrade --dry-run
dshctl upgrade -y
dshctl upgrade --json
dshctl status
```

- `upgrade`：使用保守默认策略检查整套环境。
- `--plugins-only`：明确保持当前 DSH。
- `--preview`：显式允许考虑 prerelease 插件候选。
- `--dry-run`：完成下载、隔离安装和配置验证，但不询问、不应用。
- `-y` / `--yes`：只跳过 `[Y/n]` 询问；下载、隔离安装、配置验证、切换后复核和失败回滚仍全部执行。
- 非交互环境没有 `-y` 时不会应用；`--json` 默认只验证并输出机器可读结果。
- `status`：只检查本地状态和配置，不查询更新。

在交互终端中，耗时检查会显示单行旋转状态并动态更新当前 package；最终结果生成后自动清除。`--json` 或管道输出不会混入进度字符。
`--verbose` 会显示候选发现、隔离验证、应用与恢复三个阶段的耗时；JSON 输出使用毫秒数。默认成功输出不展示这些内部诊断。

可通过 `DSH_HOME` 指向其他 DSH home，通过 `DSH_BIN` 和 `PNPM_BIN` 覆盖命令路径。测试写入必须使用临时 `DSH_HOME`。

## 平台与语言状态

| 平台 | 当前状态 |
| --- | --- |
| macOS | 已用真实 DSH profiles 验证检查、隔离升级、回滚和 Web 恢复 |
| Linux | Node 24 Debian arm64 容器测试通过；真实 DSH profile E2E 尚未完成 |
| Windows | 尚不支持；仍需 `.cmd` 命令启动、Windows 进程发现和终止实现 |

DSH 上游本身同时建设 Linux、macOS 和 Windows：Linux 是主 CI 路径，发布矩阵包含 Linux x64/arm64、macOS arm64 和 Windows x64，Windows 另有 Wine 阻塞门禁与原生 Windows 测试。`dshctl` 不会因为上游支持某平台就自动宣称自身兼容；详细边界见 [平台与本地化](docs/PORTABILITY.md)。

当前人类可读输出仍是简体中文，因此还不具备面向全球用户发布的语言条件。英文适配将以稳定 reason code 与本地化 renderer 实现，JSON 不携带随语言变化的判断文本。

## 状态含义

- `declared`：候选通过作者提供的 DSH/host contract 声明。
- `unknown`：没有足够的 DSH 兼容声明，不能自动升级。
- `blocked`：DSH、Node 或必需 peer dependency 存在确定冲突。

`declared` 仍不是运行验证。自动切换还要求 pnpm resolution、精确安装版本和隔离配置合成全部通过；切换后再次验证实际 profile，并为原本常驻的 Web profile 恢复进程与监听端口。完整 UI/TUI 功能 smoke 仍是后续增强项。

远端不可达不会触发自动卸载。例如：

```text
dsh-model-fix：远端不可达，已安装版本会继续保留。
确认不再需要时手动移除：dsh plugin --profile web remove dsh-model-fix
```

## 开发

```bash
pnpm typecheck
pnpm test
pnpm build
```

设计和安全边界见 [docs/DESIGN.md](docs/DESIGN.md)、[docs/SECURITY.md](docs/SECURITY.md) 与 [docs/PORTABILITY.md](docs/PORTABILITY.md)。
