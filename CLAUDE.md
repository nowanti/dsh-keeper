# dshkeeper 项目规范

## 定位

`dshkeeper` 是 DeepSeek Harness 的外置生命周期工具。它替用户完成版本发现、兼容性判断、隔离验证、升级切换和失败回滚，不是 DSH 插件市场，也不重新实现 pnpm。

用户默认只需要执行：

```bash
dshkeeper upgrade
```

计划、快照、验证和回滚是内部事务阶段，不得要求普通用户逐步操作。只有权限扩大、来源变化、能力损失或证据不足等无法安全代替用户决定的情况才暂停。

## 当前里程碑边界

- `upgrade` 先发现并展示精确的待验证候选；用户确认后，才在无凭据隔离 profile 中完成安装与配置合成，全部通过后自动应用。确认不会取消或跳过任何验证。
- 交互终端默认以 `[Y/n]` 一次确认整笔推荐更新；`--yes` 仅用于显式非交互授权，`--dry-run` 永不修改现有 profile。
- 写入前必须建立事务记录和可恢复快照。多个 profile 作为一笔事务切换；任一步失败必须恢复已经切换的 profile。
- 远端不可达只代表证据未知，不得据此卸载、删除或改写现有依赖；可以显示精确的手动移除命令。
- 不在 DSH 进程内部运行核心引擎。DSH 无法启动时，`dshkeeper` 仍应能够诊断和恢复。
- 复用官方 `dsh`、pnpm 和成熟生态能力；不要实现新的包下载器、lockfile 格式或插件市场。

## 平台与语言契约

- 目标平台与 DSH 一致：macOS、Linux、Windows。只有在对应原生平台完成构建、测试和进程生命周期验证后，才能宣称支持。
- macOS、Linux、Windows 的公共支持声明必须由 GitHub Actions 原生 runner 共同门禁；单元测试中的 platform mock 只能证明分支逻辑，不能替代原生 `.cmd`、进程和文件事务测试。
- 面向公开用户的目标语言是英文和简体中文。非中文系统默认英文，中文系统默认简体中文，并允许 `--lang` 和 `DSHKEEPER_LANG` 显式覆盖。
- JSON receipt 必须以稳定 reason code 和参数表达语义，不输出依赖当前 locale 的判断文本；人类可读渲染再按 locale 翻译。
- 在 reason code 与 locale catalog 落地前，不得通过零散条件分支继续扩散新的中文文案。

## 发布与生态契约

- `dshkeeper` 是独立 CLI，不声明 `dsh.bundle`，也不使用只面向插件仓库的 `dsh-plugin` Topic；它必须在 DSH 启动失败时仍可工作。
- npm 包与 GitHub 仓库同名 `dshkeeper`。安装入口是 `npm install -g dshkeeper`，临时入口是 `npx dshkeeper`。
- pull request 和 main push 必须在 macOS、Linux、Windows 原生 runner 上完成 typecheck、build、unit/integration tests、CLI 双语 smoke 与 package dry-run；真实 DSH profile E2E 单独门禁。
- npm 发布只由 `v<package-version>` tag 触发。工作流必须先验证 tag 与 `package.json` 一致、重跑测试并打包，再使用 npm Trusted Publishing/OIDC 和 provenance 发布；仓库不得保存长期 `NPM_TOKEN`。
- 发布前的外部动作分成两步：本仓库可完整准备工作流和文档；首次创建公开 GitHub 仓库、配置 npm Trusted Publisher、占用包名和提交官方生态入口，需要明确记录执行结果。

## 用户体验契约

- 默认命令做出保守、安全的选择，不要求用户选择策略。
- 默认不切换 prerelease 通道、不减少当前健康能力、不接受权限扩大或未知来源。
- 保持 DSH 时，目标是当前 DSH 可兼容的最高插件版本；升级 DSH 时，必须按整个 profile 求解，不能逐个插件独立宣告安全。
- 输出先给结论，再给原因和下一步。正常成功保持简洁，细节通过 `--verbose` 或 `--json` 展开。
- 超过瞬时完成时间的交互检查必须持续显示当前阶段；动态状态只写 TTY stderr，不污染 JSON 或管道输出。
- 内部安全说明和阶段耗时不进入默认成功输出；耗时只通过 `--verbose` 和 `--json` 提供诊断。
- `--dry-run` 是专家能力，不是标准升级前置步骤。
- 默认确认发生在候选发现之后、下载和隔离验证之前；确认授权的是“验证这组精确候选，并在整组通过后应用”。验证只能否决已展示方案，不能扩大或替换候选，失败不得切换现有 profile。

## 安全边界

- 默认只读取 profile 的 `package.json`、`pnpm-lock.yaml`、bundle/patch 文件名和已安装包 manifest。
- 永远不读取、复制或输出 `.credentials.yaml`、provider token、session、storage、SSH key、环境变量值或完整运行日志。
- profile 内的 Git 依赖必须以完整 commit 标识；移动分支或 tag 只能报告为风险，不能自动应用。
- npm 候选必须保留版本和 integrity；来源、install script、权限或 patch 变化必须单独显示。
- 缺少兼容声明只能标记为 `unknown`，不得伪装成 `compatible`。
- 停止 DSH 正常路径使用 SIGINT/SIGTERM。只有两次宽限都耗尽、原监听端口已经关闭、PID 却仍卡在退出清理时，才允许用 SIGKILL 回收这个不再提供服务的残留进程；端口仍在监听时不得强杀。
- 升级前已经不健康的常驻 profile 不得被伪报为升级验证通过；应阻止自动切换并给出修复方向。

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
dshkeeper/
├── CLAUDE.md
├── README.md
├── .github/
│   ├── workflows/
│   └── dependabot.yml
├── docs/
│   ├── DESIGN.md
│   ├── ECOSYSTEM.md
│   ├── PORTABILITY.md
│   ├── RELEASE.md
│   └── SECURITY.md
├── scripts/
│   └── test-real-dsh.mjs
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
