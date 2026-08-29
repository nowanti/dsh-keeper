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

当前只实现前三步中的只读部分：

- 读取 profiles 和已安装 manifest；
- 通过 pnpm 获取 npm 版本信息；
- 通过 `dsh.engines.dsh`、Node engines 和 peer dependencies 判断声明兼容性；
- peer 解析遵循 DSH 运行时可见顺序：插件/profile 已安装版本优先，DSH 安装目录作为宿主 fallback；当前层未解析到 peer 只留下 staging 证据，不伪装成确定冲突；
- 对 GitHub 固定 commit 只比较远端 HEAD。因为尚未隔离安装该 commit，结果只能是 `unknown`；
- 调用 `dsh --profile <name> --dump-config`，但不输出命令原始 stderr，防止日志内容泄漏。
- 交互终端用单行 spinner 报告当前阶段；机器输出保持纯 JSON。

`upgrade` 当前返回 `read-only` receipt，不会执行 package mutation。

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

src
  assess.ts             orchestration with adapter caches
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

1. 复制 manifest、lock、patch 和 bundle 到无凭据临时 profile。
2. 使用精确版本和 integrity 执行 pnpm resolution，禁用未经批准的 install scripts。
3. 在隔离端口完成 `dump-config`、Web API/UI 和 TUI smoke。
4. 写入带 hash 的事务 receipt 和 generation snapshot。
5. 原子切换 profile；失败时恢复字节一致的上一 generation。
6. 吸收旧 Bash `dshctl` 的进程生命周期能力并移除旧入口。
