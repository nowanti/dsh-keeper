# DSH 生态定位

## 结论

`dshkeeper` 应作为独立 CLI 进入生态，不应伪装成 DSH 插件。

官方对插件仓库的明确发现机制是 GitHub Topic [`dsh-plugin`](https://github.com/deepseek-ai/deepseek-harness#-plugins)。插件会被 DSH profile 加载，通常声明 `dsh.bundle` 并参与配置合成；`dshkeeper` 的职责恰好要求它在 DSH 或 profile 无法启动时仍能诊断、回滚。因此给本仓库打 `dsh-plugin` Topic、增加空壳 bundle，都会制造错误安装预期并削弱恢复边界。

## 命名决策

没有沿用 `dshctl`。截至 2026-08-29，GitHub 已存在两个相邻项目：

- [`Qidianyan/dshctl`](https://github.com/Qidianyan/dshctl)：通过 DSH Web Host HTTP/WebSocket API 管理会话和模型的终端遥控器；
- [`Seudama/DSHCtl`](https://github.com/Seudama/DSHCtl)：Windows Qt 服务启动与托盘控制器。

`dshup` 也已经被 [`zhangjiabo522/dshup`](https://github.com/zhangjiabo522/dshup) 用作 Windows DSH 桌面客户端。继续复用这些名字会让“遥控 DSH”“启动 DSH”和“安全升级 DSH”三个目标混在同一搜索结果中。

最终名称 `dshkeeper` 表达的是守住一套可恢复、兼容的 DSH generation，而不是替代 pnpm 或只执行一次版本加一。调研时 npm 名称可用，GitHub 没有同名仓库；正式创建和发布前仍须再次检查，因为名称状态可能变化。

## 发现路径

发布后使用四层入口：

1. npm：包名与二进制都为 `dshkeeper`，关键词包含 `deepseek-harness`、`dsh`、`plugin-manager`、`compatibility`；
2. GitHub：Topics 使用 `deepseek-harness`、`dsh`、`cli`、`plugin-management`、`package-manager`，明确不使用 `dsh-plugin`；
3. DSH 上游：先发 Discussion 说明问题、事务安全边界和三平台证据；若维护者认可，再提交一个只增加外部工具入口的 README/docs PR；
4. 插件作者：提供稳定 JSON reason code 文档，让插件 CI 能检查自身 manifest 是否足以被自动升级，而不是要求作者依赖 `dshkeeper` 运行时。

## 上游提交门槛

向官方生态登记之前必须满足：

- npm 包可公开安装，并带 provenance；
- 公开仓库三平台 CI 全绿；
- 至少一个真实 DSH profile 的状态、隔离与失败恢复路径有可复现实证；
- README 明确标注社区项目和当前不自动升级 DSH core；
- 不把“作者声明兼容”表述成“功能已完整验证”。

上游入口的目标是让需要“安全升级与回滚”的用户发现工具，不是借用插件 Topic 获得曝光。
