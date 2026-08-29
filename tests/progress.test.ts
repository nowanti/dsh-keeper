import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Spinner, type ProgressOutput } from '../src/progress.js'

class FakeOutput implements ProgressOutput {
  isTTY = true
  value = ''

  write(value: string): void {
    this.value += value
  }
}

describe('Spinner', () => {
  it('renders and replaces a single TTY status line', () => {
    const output = new FakeOutput()
    const spinner = new Spinner(output, { enabled: true, intervalMs: 10_000 })
    spinner.start('读取 profiles')
    spinner.update('检查 web')
    spinner.stop()
    assert.match(output.value, /读取 profiles/)
    assert.match(output.value, /检查 web/)
    assert.match(output.value, /\u001B\[2K/)
  })

  it('stays silent when progress is disabled', () => {
    const output = new FakeOutput()
    const spinner = new Spinner(output, { enabled: false })
    spinner.start('不会显示')
    spinner.update('仍然不会显示')
    spinner.stop()
    assert.equal(output.value, '')
  })
})
