# 发布

## 发布模型

`dsh-keeper` 以同名公开 GitHub 仓库和 npm 包发布。普通安装入口是：

```bash
npm install --global dsh-keeper
```

每个正式版本只有一个来源：`v<package.json version>` Git tag。tag 触发 `.github/workflows/release.yml`，依次完成：

1. 验证 tag 与包版本一致；
2. typecheck、build、全部测试；
3. 在真实 DSH profile 上执行状态与 `--dump-config` E2E；
4. 生成唯一 npm tarball；
5. 为 tarball 建立 GitHub artifact attestation；
6. 通过 npm Trusted Publishing/OIDC 发布并生成 npm provenance；
7. 创建同名 GitHub Release 并附带同一 tarball。

release runner 不缓存依赖，不保存长期写 token。npm Trusted Publishing 要求 npm CLI 11.5.1 或更高，因此工作流会显式更新 npm。

## 首次发布的引导限制

npm 只有在包已经存在后才能为它配置 Trusted Publisher。因此首次发布必须完成一次引导：

1. 创建公开仓库 `nowanti/dsh-keeper` 并让 CI 全绿；
2. npm 账号启用 2FA，并确认 `dsh-keeper` 名称仍可用；
3. 在 npm 网站创建短期 granular token：Packages and scopes 设为 `Read and write` + `All Packages`，开启 `Bypass 2FA`。首版发布前包尚不存在，无法把 token 限定为该包；因此有效期应尽可能短，只放进 GitHub `npm` environment 的 `NPM_TOKEN` secret；
4. 推送首个版本 tag，让 GitHub-hosted release job 完成登记；
5. 立即在 npm 包设置中配置 Trusted Publisher：
   - owner: `nowanti`
   - repository: `dsh-keeper`
   - workflow: `release.yml`
   - environment: `npm`
   - allowed action: publish
6. 删除 npm token 和 GitHub `NPM_TOKEN` secret，之后只保留 OIDC，并在包的 Publishing access 中禁用 token 发布。

首次引导不应在本地电脑直接发布：那样无法把首版构建可靠地绑定到公开仓库和 GitHub-hosted workflow。

## 日常发布

```bash
pnpm check
pnpm test:real-dsh
npm pack --dry-run
git tag v0.3.0
git push origin v0.3.0
```

不要在本地执行正式 `npm publish`。tag 推送后以 GitHub Actions、npm provenance 和 GitHub Release 三处结果共同验收。相同 name/version 一旦发布不能复用，因此失败后应修复并增加版本号。

## 发布前检查

- 三平台 CI 与真实 DSH E2E 全绿；
- `npm pack --dry-run` 不含源码测试、临时数据、凭据或 `node_modules`；
- README 的支持矩阵与当前原生证据一致；
- `package.json` repository URL 与实际公开仓库大小写完全一致；
- 没有未处理的 breaking receipt schema 变更；
- release note 明确区分 DSH core、npm 插件与 Git 插件的自动化边界。
