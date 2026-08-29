# 安全模型

## 信任边界

DSH 插件是宿主级代码。安装后可能访问工作区、文件系统、网络、Shell、SSH 和 DSH 凭据。因此“依赖能解析”不等于“可以安全自动升级”。

`dsh-keeper` 自身必须位于 DSH 进程外部，以便在宿主损坏或无法启动时检查和回滚。

## 读取白名单

默认允许读取：

- `<profile>/package.json`；
- 已安装依赖的 `package.json`；
- 当前 DSH 安装目录内宿主依赖的 `package.json`；
- `pnpm-lock.yaml` 的非秘密依赖信息；
- bundle 与 patch 的文件名、存在状态和 hash；
- DSH/pnpm/Git 命令的受控状态输出。

默认禁止读取或输出：

- `.credentials.yaml`；
- provider token、cookie 和环境变量值；
- sessions、storages 和 SSH key；
- 完整运行日志；
- 任意插件私有数据目录。

## 外部命令

- 不使用 shell 拼接命令；所有参数直接传给进程 API。
- stdout/stderr 有大小和超时限制。
- DSH 配置检查只保留退出状态，不回显原始输出。
- Git 只接受规范 GitHub owner/repo 和固定 ref，不把 profile 内容拼入 URL。

## 进程终止阶梯

- 常驻 DSH 先接收 SIGINT，宽限耗尽后才接收 SIGTERM。
- 如果 PID 随后仍存在，只有确认它原本声明的监听端口已经关闭，才把它视为卡在退出清理中的残留进程并使用 SIGKILL 回收。
- 端口仍在监听、端口状态无法确认或强制信号后 PID 仍存在时，停止失败并中止升级；不得为了得到绿色结果继续切换 profile。

## 自动升级门槛

只有同时满足以下条件的候选才能自动切换：

- 来源没有改变；
- npm artifact 有精确版本与 integrity，或 Git 使用完整 commit；
- 没有新增 lifecycle install script；
- 没有权限扩大；
- profile 整体 resolution、精确版本安装和配置合成通过；
- 已创建可恢复的 generation snapshot；
- 切换后的 live 配置复核通过；原本运行中的 Web profile 必须恢复进程和监听端口。

任何一项证据缺失都必须保持当前版本或请求用户批准，不能通过静默禁用插件来获得绿色结果。

## 隔离与远端失联

- staging 只复制 manifest、lock、composition、patch 和 `node_modules`；不复制 `.credentials.yaml`、session、storage 或插件私有状态。
- staging 根目录与事务目录使用用户私有权限。失败输出只保留经过 token/userinfo 脱敏的少量诊断行，不回显完整安装日志。
- 远端不可达不等于插件应被删除。完整 commit 已安装、lockfile 有相同 tarball resolution 且 pnpm cache 仍有相同 artifact 时，staging 可以复用该 artifact；最终 package 与 lock 必须恢复原 Git specifier，且版本必须与当前安装一致。
- 如果缓存也不存在，整笔 staging 失败；工具不会卸载该插件，也不会把它静默替换为本地 `file:` 来源。

当前尚未把每项插件的 UI/API/TUI 功能测试纳入自动门槛，因此输出应区分 `staged` 与完整 `verified`。事务快照用于启动失败时自动恢复，不应被描述为已证明所有插件业务功能正常。
