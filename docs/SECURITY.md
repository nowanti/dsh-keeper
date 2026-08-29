# 安全模型

## 信任边界

DSH 插件是宿主级代码。安装后可能访问工作区、文件系统、网络、Shell、SSH 和 DSH 凭据。因此“依赖能解析”不等于“可以安全自动升级”。

`dshctl` 自身必须位于 DSH 进程外部，以便在宿主损坏或无法启动时检查和回滚。

## 读取白名单

默认允许读取：

- `<profile>/package.json`；
- 已安装依赖的 `package.json`；
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

## 自动升级门槛

未来只有同时满足以下条件的候选才能自动切换：

- 来源没有改变；
- npm artifact 有精确版本与 integrity，或 Git 使用完整 commit；
- 没有新增 lifecycle install script；
- 没有权限扩大；
- profile 整体 resolution、配置和运行验证通过；
- 已创建可恢复的 generation snapshot；
- 切换后的 live probe 通过。

任何一项证据缺失都必须保持当前版本或请求用户批准，不能通过静默禁用插件来获得绿色结果。
