# dshkeeper

`dshkeeper` is an external lifecycle and compatibility manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Its default workflow is intentionally one command:

```bash
dshkeeper upgrade
```

It discovers installed DSH profiles, evaluates plugin candidates, asks once, validates the exact set in a credential-free isolated profile, applies it as one recoverable transaction, and restores the previous generation if any live check fails.

> Community project; not affiliated with DeepSeek. Developer preview: DSH core upgrades are reported but not yet applied automatically.

## Install

Node.js 24 or newer is required.

```bash
npm install --global dshkeeper
dshkeeper upgrade
```

For a one-off check:

```bash
npx dshkeeper status
```

## What it protects

- Keeps the current DSH release when a newer core cannot yet be switched transactionally.
- Selects only npm plugin candidates with usable DSH/host and Node compatibility evidence.
- Treats missing peer packages as isolation evidence instead of assuming they are user-managed conflicts.
- Holds local patches, permission changes, new lifecycle scripts, mutable Git refs, and evidence-poor candidates.
- Never removes a plugin merely because its remote repository is unavailable.
- Copies no credentials, sessions, storage, SSH keys, or provider secrets into staging.
- Revalidates promoted profiles and restores package manifests, lockfiles, `node_modules`, and resident services on failure.

## Commands

```bash
dshkeeper upgrade
dshkeeper upgrade -y                # skip only the question, never validation
dshkeeper upgrade --profile web
dshkeeper upgrade --plugins-only
dshkeeper upgrade --preview
dshkeeper upgrade --dry-run
dshkeeper upgrade --json
dshkeeper status
```

Interactive terminals show one updating spinner line during slow work. JSON and piped output remain free of progress characters. Phase timings appear only with `--verbose` or in JSON.

## Languages

English and Simplified Chinese are built in. Chinese systems default to `zh-CN`; other systems default to English.

```bash
dshkeeper --lang en status
dshkeeper upgrade --lang zh-CN
DSHKEEPER_LANG=zh-CN dshkeeper status
```

JSON receipts are language-neutral. Compatibility and decision explanations use stable reason codes plus structured parameters; translation happens only in human-readable rendering.

## Compatibility states

- `declared`: the candidate exposes a compatible DSH host contract.
- `unknown`: evidence is insufficient for an automatic upgrade.
- `blocked`: a DSH, Node, or required-peer contract has a confirmed conflict.

`declared` is not the same as verified. Automatic switching still requires exact package resolution, isolation installation, configuration composition, live revalidation, and service recovery.

## Platform status

The implementation targets macOS, Linux, and Windows. Every public support claim is gated by native GitHub-hosted runners; the CI matrix also creates a real DSH profile and executes `dsh --dump-config` through `dshkeeper`. See [Portability and localization](docs/PORTABILITY.md) for the current evidence and remaining boundaries.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:real-dsh
npm pack --dry-run
```

Architecture and release details:

- [Design](docs/DESIGN.md)
- [Security model](docs/SECURITY.md)
- [Portability and localization](docs/PORTABILITY.md)
- [Release process](docs/RELEASE.md)
- [DSH ecosystem positioning](docs/ECOSYSTEM.md)

## 中文说明

`dshkeeper` 是运行在 DSH 进程之外的生命周期与兼容性工具。普通用户只需执行 `dshkeeper upgrade`：系统发现候选后展示一次明确方案，用户确认才下载并隔离验证，整组通过后自动应用；任何一步失败都会恢复旧版本和原有服务。

它不是 DSH 插件，也不替代 pnpm。这样设计的原因是：当 DSH 本身或某个 profile 已经无法启动时，修复与回滚工具仍然必须可用。远端不可达只会保留当前版本并给出手动移除建议，不会触发自动卸载。

使用 `--lang zh-CN` 或 `DSHKEEPER_LANG=zh-CN` 可固定中文；中文系统会自动选择中文。完整工程边界与验证证据见上方文档链接。
