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
- 隔离 `--dump-config` 通过后才显示最终方案并询问一次；
- 确认后建立可恢复快照、原子切换两个 profile、复核配置并恢复原有 Web 服务；
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
- `-y` / `--yes`：跳过 `[Y/n]` 询问，直接应用已经通过隔离验证的方案。
- 非交互环境没有 `-y` 时不会应用；`--json` 默认只验证并输出机器可读结果。
- `status`：只检查本地状态和配置，不查询更新。

在交互终端中，耗时检查会显示单行旋转状态并动态更新当前 package；最终结果生成后自动清除。`--json` 或管道输出不会混入进度字符。

可通过 `DSH_HOME` 指向其他 DSH home，通过 `DSH_BIN` 和 `PNPM_BIN` 覆盖命令路径。测试写入必须使用临时 `DSH_HOME`。

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

设计和安全边界见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/SECURITY.md](docs/SECURITY.md)。
