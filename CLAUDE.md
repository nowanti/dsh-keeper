# dshctl 项目规范

## 定位

`dshctl` 是 DeepSeek Harness 的外置生命周期工具。它替用户完成版本发现、兼容性判断、隔离验证、升级切换和失败回滚，不是 DSH 插件市场，也不重新实现 pnpm。

用户默认只需要执行：

```bash
dshctl upgrade
```

计划、快照、验证和回滚是内部事务阶段，不得要求普通用户逐步操作。只有权限扩大、来源变化、能力损失或证据不足等无法安全代替用户决定的情况才暂停。

## 第一版边界

- 当前里程碑是只读 MVP：发现 DSH 和 profiles、检查当前配置、查询更新候选、判断声明兼容性并生成升级决策。
- 在事务切换和回滚实现、测试并经过真实 profile 演练前，`upgrade` 不得修改 DSH 或 profile；必须明确显示当前为只读预检。
- 不在 DSH 进程内部运行核心引擎。DSH 无法启动时，`dshctl` 仍应能够诊断和恢复。
- 复用官方 `dsh`、pnpm 和成熟生态能力；不要实现新的包下载器、lockfile 格式或插件市场。

## 用户体验契约

- 默认命令做出保守、安全的选择，不要求用户选择策略。
- 默认不切换 prerelease 通道、不减少当前健康能力、不接受权限扩大或未知来源。
- 保持 DSH 时，目标是当前 DSH 可兼容的最高插件版本；升级 DSH 时，必须按整个 profile 求解，不能逐个插件独立宣告安全。
- 输出先给结论，再给原因和下一步。正常成功保持简洁，细节通过 `--verbose` 或 `--json` 展开。
- `--dry-run` 是专家能力，不是标准升级前置步骤。

## 安全边界

- 默认只读取 profile 的 `package.json`、`pnpm-lock.yaml`、bundle/patch 文件名和已安装包 manifest。
- 永远不读取、复制或输出 `.credentials.yaml`、provider token、session、storage、SSH key、环境变量值或完整运行日志。
- profile 内的 Git 依赖必须以完整 commit 标识；移动分支或 tag 只能报告为风险，不能自动应用。
- npm 候选必须保留版本和 integrity；来源、install script、权限或 patch 变化必须单独显示。
- 缺少兼容声明只能标记为 `unknown`，不得伪装成 `compatible`。
- 停止 DSH 使用 SIGINT/SIGTERM；不得使用 `kill -9` 作为正常流程。

## 状态语言

- `declared`：作者声明兼容。
- `resolved`：依赖解析通过。
- `staged`：隔离安装和配置合成通过。
- `verified`：关键运行路径验证通过。
- `unknown`：证据不足。
- `blocked`：存在确定冲突。

不要把 `installed`、`loaded`、`healthy` 或 `verified` 混为一谈。

## 目录约定

```text
dshctl/
├── CLAUDE.md
├── README.md
├── docs/
│   ├── DESIGN.md
│   └── SECURITY.md
├── src/
│   ├── cli.ts
│   ├── core/
│   └── adapters/
└── tests/
```

- `src/core/`：纯数据模型、决策和兼容性逻辑，不直接执行外部命令。
- `src/adapters/`：文件系统、DSH、pnpm、Git 和网络边界。
- `tests/`：使用临时目录和伪造 adapter；测试不得读取真实凭据或修改真实 profile。
- 当前事实写入 README/DESIGN；历史取舍只写 Git 历史或专门的 decision 文档。

## 开发与验证

- Node.js 24，TypeScript ESM，pnpm。
- 每次改动至少运行 `pnpm test`、`pnpm typecheck` 和 `pnpm build`。
- 涉及 CLI 行为时，用临时 fixture 验证 JSON 与人类可读输出。
- 对真实 `~/.dsh/profiles` 的检查默认只读；任何写入测试必须使用临时 `DSH_HOME`。

## Git

- 主分支为 `main`。
- 提交消息使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:` 等标准前缀。
- 不提交凭据、真实 profile 快照、完整用户路径日志、构建产物或 `node_modules`。
