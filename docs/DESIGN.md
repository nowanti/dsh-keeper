# dshctl 设计

## 用户目标

用户不需要管理升级计划。标准交互只有：

```bash
dshctl upgrade
```

系统在内部完成发现、求解、快照、隔离验证、切换和回滚。只有系统无法在不损失能力或扩大权限的前提下做决定时，才要求用户介入。

## 默认决策

`upgrade` 默认采用以下不可交换的优先级：

1. 不引入硬兼容冲突。
2. 不减少当前已健康的能力。
3. 不切换 prerelease 通道。
4. 不自动接受来源、权限或 install script 扩大。
5. 尽量减少发生变化的插件数量和现有 patch。
6. 在上述条件内选择较新的版本。

如果推荐 DSH 无法保持全部当前能力，默认保持 DSH，只升级当前版本能够支持的插件。`--plugins-only` 用于用户明确要求冻结 DSH，不是正常流程的必选策略。

## 内部流水线

```text
discover
  -> resolve candidates
  -> evaluate declared contracts
  -> stage an isolated profile
  -> verify config and runtime
  -> create immutable transaction receipt
  -> promote
  -> verify live profile
  -> rollback on failure
```

这些阶段不会映射成用户必须依次执行的命令。`--dry-run` 和 JSON receipt 只面向审计与开发。

## 当前实现

当前实现覆盖插件候选从发现到事务切换：

- 读取 profiles 和已安装 manifest；
- 通过 pnpm 获取 npm 版本信息；
- 通过 `dsh.engines.dsh`、Node engines 和 peer dependencies 判断声明兼容性；
- peer 解析遵循 DSH 运行时可见顺序：插件/profile 已安装版本优先，DSH 安装目录作为宿主 fallback；当前层未解析到 peer 只留下 staging 证据，不伪装成确定冲突；
- 对 GitHub 固定 commit 只比较远端 HEAD。因为尚未隔离安装该 commit，结果只能是 `unknown`；
- 调用 `dsh --profile <name> --dump-config`，但不输出命令原始 stderr，防止日志内容泄漏。
- 交互终端用单行 spinner 报告当前阶段；机器输出保持纯 JSON。
- 将候选 npm artifacts 预取到 pnpm store，再对当前 `node_modules` 做文件系统隔离副本和增量安装。
- lockfile 已记录同一 commit tarball 的固定 Git 依赖在 staging 内复用 pnpm cache，避免每个 profile 重复访问远端；安装后恢复原 Git specifier 并验证已安装版本未变，live profile 不发生来源迁移。
- 隔离安装和配置合成全部通过后才展示一次 `[Y/n]`；`-y/--yes` 是明确的非交互授权。
- 写入前保存事务 journal 和旧 package、lockfile、`node_modules`；切换失败按相反顺序恢复。
- 原本运行中的 Web profile 使用 SIGINT/SIGTERM 停止，切换后恢复相同 profile/端口并检查 TCP listener。交互式 TUI 运行中时拒绝自动切换。

DSH 核心本体自动切换、隔离 Web UI/API smoke、TUI 启动 smoke 和显式 `rollback` 命令尚未实现。当前成功语义是插件依赖 `staged`，以及常驻 Web 进程/端口恢复；不是对每项插件功能的完整 `verified`。

## 架构

```text
src/core
  types.ts             evidence and receipt model
  compatibility.ts     pure manifest contract evaluation
  selection.ts         version and default-policy selection

src/adapters
  profiles.ts          allow-listed profile reads
  process.ts           shell-free bounded process execution
  dsh.ts               DSH version/config probes
  pnpm.ts              registry metadata through pnpm
  git.ts               exact GitHub ref parsing and HEAD lookup
  runtime.ts           DSH process discovery, graceful stop and restart

src
  assess.ts             orchestration with adapter caches
  upgrade.ts            credential-free staging and atomic transaction
  render.ts             concise and JSON output
  cli.ts                command and option parsing
```

核心逻辑不得直接读取文件或启动命令，便于使用 fixture 证明决策行为。所有外部命令都使用参数数组启动，不经过 shell。

## 兼容证据

候选包的身份是：

```text
(source, version-or-commit, integrity, patch-hash)
```

仅有包名和版本不足以表达 Git 来源或本地 patch。

声明兼容的依据包括：

- `dsh.engines.dsh`；
- 与 DSH host 相关的 peer dependencies；
- Node engine；
- 必需 peer dependency 在当前 profile 中可满足。

没有 host contract 时标记为 `unknown`。外部兼容索引将来可以补充旧插件证据，但不能覆盖本地 staging 和 smoke 结果。

## 后续里程碑

1. 在隔离端口完成 Web API/UI 和 TUI smoke，把 `staged` 提升为关键路径 `verified`。
2. 增加显式 `rollback` 与进程崩溃后的 journal 自动恢复。
3. 将 DSH 核心本体纳入同一个版本求解与 generation 事务。
4. 用跨平台 reflink 与复用 assessment cache 继续压缩等待时间。
5. 吸收旧 Bash `dshctl` 的其余服务命令并移除旧入口。
