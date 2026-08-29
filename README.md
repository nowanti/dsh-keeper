# dshctl

`dshctl` 是 DeepSeek Harness 的外置生命周期和兼容性工具。目标是让用户通过一个命令获得一套尽可能新的、不会损失当前能力的 DSH 与插件组合：

```bash
dshctl upgrade
```

## 当前状态

当前版本是只读 MVP。它会：

- 发现 `~/.dsh/profiles` 中的 profiles；
- 读取 DSH 当前版本和 npm 推荐通道；
- 检查 profile manifest、安装版本、bundle 和 patch 关系；
- 使用 pnpm 查询 npm 更新；
- 检查 npm 候选声明的 DSH、Node 和 peer dependency 兼容性；
- 检查固定 GitHub commit 与远端 HEAD 的差异；
- 调用 DSH 的 `--dump-config` 做配置预检；
- 给出可以继续验证、必须保持或证据不足的结论。

当前版本**不会修改 DSH、package.json、lockfile、patch 或 bundle**。隔离安装、自动切换和回滚完成前，`upgrade` 只生成升级决策。

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
dshctl upgrade --json
dshctl status
```

- `upgrade`：使用保守默认策略检查整套环境。
- `--plugins-only`：明确保持当前 DSH。
- `--preview`：允许显示 prerelease 候选，但当前仍不会应用。
- `status`：只检查本地状态和配置，不查询更新。

可通过 `DSH_HOME` 指向其他 DSH home，通过 `DSH_BIN` 和 `PNPM_BIN` 覆盖命令路径。测试写入必须使用临时 `DSH_HOME`。

## 状态含义

- `declared`：候选通过作者提供的 DSH/host contract 声明。
- `unknown`：没有足够的 DSH 兼容声明，不能自动升级。
- `blocked`：DSH、Node 或必需 peer dependency 存在确定冲突。

`declared` 仍不是运行验证。后续里程碑会依次增加 `resolved`、`staged` 和 `verified` 证据。

## 开发

```bash
pnpm typecheck
pnpm test
pnpm build
```

设计和安全边界见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/SECURITY.md](docs/SECURITY.md)。
