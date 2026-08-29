import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnostic } from '../src/core/diagnostics.js'
import { resolveLocale, translate, translateDiagnostic } from '../src/i18n.js'

test('explicit locale overrides environment and system locale', () => {
  assert.equal(resolveLocale({
    explicit: 'en-US',
    env: { DSH_KEEPER_LANG: 'zh-CN', LANG: 'zh_CN.UTF-8' },
    platform: 'linux',
    intlLocale: 'zh-CN',
  }), 'en')
})

test('DSH_KEEPER_LANG overrides the operating-system locale', () => {
  assert.equal(resolveLocale({
    env: { DSH_KEEPER_LANG: 'zh-Hans', LANG: 'en_US.UTF-8' },
    platform: 'linux',
    intlLocale: 'en-US',
  }), 'zh-CN')
})

test('unsupported locales fall back to English', () => {
  assert.equal(resolveLocale({ env: { LANG: 'fr_FR.UTF-8' }, platform: 'linux', intlLocale: 'fr-FR' }), 'en')
})

test('diagnostic codes render in both supported locales without changing the receipt', () => {
  const item = diagnostic('reason.dshMismatch', { required: '>=1.0.0', current: '0.9.0' })
  assert.match(translateDiagnostic('en', item), /requires DSH >=1\.0\.0/)
  assert.match(translateDiagnostic('zh-CN', item), /需要 DSH >=1\.0\.0/)
  assert.deepEqual(item, { code: 'reason.dshMismatch', params: { required: '>=1.0.0', current: '0.9.0' } })
  assert.match(translate('en', 'cli.usage', { version: 'test' }), /Usage:/)
  assert.match(translate('zh-CN', 'cli.usage', { version: 'test' }), /用法:/)
})
