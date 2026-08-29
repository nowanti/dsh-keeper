#!/usr/bin/env node

import { assessEnvironment, type AssessmentOptions } from './assess.js'
import { Spinner } from './progress.js'
import { renderHuman } from './render.js'

const VERSION = '0.1.0'

interface CliOptions {
  command: 'status' | 'upgrade'
  profile?: string
  pluginsOnly: boolean
  preview: boolean
  json: boolean
  verbose: boolean
}
function usage(): string {
  return `dshctl ${VERSION}

用法:
  dshctl upgrade [选项]
  dshctl status [选项]

命令:
  upgrade              检查 DSH 与插件更新；当前版本只读，不执行切换
  status               检查本地 DSH、profiles 和配置

选项:
  -P, --profile NAME   只检查一个 profile
  --plugins-only       保持当前 DSH，只检查插件
  --preview            包含 prerelease 插件候选
  --dry-run            兼容未来事务模式；当前 upgrade 本来就是只读
  --json               输出机器可读 receipt
  -v, --verbose        显示更多保持原因
  -h, --help           显示帮助
  --version            显示版本`
}

function parseArgs(args: readonly string[]): CliOptions | 'help' | 'version' {
  if (args.length === 0) return 'help'
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return 'help'
  if (args[0] === '--version' || args[0] === '-V') return 'version'
  const command = args[0]
  if (command !== 'status' && command !== 'upgrade') throw new Error(`未知命令: ${command}`)

  let profile: string | undefined
  let pluginsOnly = false
  let preview = false
  let json = false
  let verbose = false
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return 'help'
    if (arg === '-P' || arg === '--profile') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} 缺少 profile 名`)
      profile = value
      index += 1
    } else if (arg?.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--plugins-only') pluginsOnly = true
    else if (arg === '--preview') preview = true
    else if (arg === '--json') json = true
    else if (arg === '-v' || arg === '--verbose') verbose = true
    else if (arg === '--dry-run' || arg === '--all') {
      // Accepted for a stable command surface; both are no-ops in the read-only MVP.
    } else throw new Error(`未知选项: ${arg ?? ''}`)
  }
  if (profile !== undefined && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error(`无效 profile 名: ${profile}`)
  return {
    command,
    ...(profile === undefined ? {} : { profile }),
    pluginsOnly,
    preview,
    json,
    verbose,
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions | 'help' | 'version'
  try {
    options = parseArgs(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`错误: ${message}\n\n${usage()}`)
    return 2
  }
  if (options === 'help') {
    console.log(usage())
    return 0
  }
  if (options === 'version') {
    console.log(VERSION)
    return 0
  }

  const spinner = new Spinner(process.stderr, options.json ? { enabled: false } : {})
  const assessmentOptions: AssessmentOptions = {
    command: options.command,
    pluginsOnly: options.pluginsOnly,
    preview: options.preview,
    onProgress: message => spinner.update(message),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  }
  spinner.start('正在准备检查')
  try {
    const receipt = await assessEnvironment(assessmentOptions)
    spinner.stop()
    console.log(options.json ? JSON.stringify(receipt, null, 2) : renderHuman(receipt, { verbose: options.verbose }))
    return receipt.summary.blocked > 0 ? 1 : 0
  } catch (error) {
    spinner.stop()
    const message = error instanceof Error ? error.message : String(error)
    console.error(`错误: ${message}`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main()
}
