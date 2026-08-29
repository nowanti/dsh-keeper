export interface ProgressOutput {
  isTTY?: boolean
  write(value: string): unknown
}

export interface SpinnerOptions {
  enabled?: boolean
  intervalMs?: number
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export class Spinner {
  readonly #output: ProgressOutput
  readonly #enabled: boolean
  readonly #intervalMs: number
  #message = ''
  #frame = 0
  #timer: NodeJS.Timeout | null = null

  constructor(output: ProgressOutput = process.stderr, options: SpinnerOptions = {}) {
    this.#output = output
    this.#enabled = options.enabled === true
      ? output.isTTY === true
      : options.enabled !== false && output.isTTY === true && process.env.TERM !== 'dumb'
    this.#intervalMs = options.intervalMs ?? 80
  }

  start(message: string): void {
    if (!this.#enabled || this.#timer !== null) return
    this.#message = message
    this.#render()
    this.#timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length
      this.#render()
    }, this.#intervalMs)
    this.#timer.unref()
  }

  update(message: string): void {
    if (!this.#enabled) return
    if (this.#timer === null) {
      this.start(message)
      return
    }
    this.#message = message
    this.#render()
  }

  stop(): void {
    if (!this.#enabled) return
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#output.write('\r\u001B[2K')
  }

  #render(): void {
    const frame = FRAMES[this.#frame] ?? FRAMES[0]
    this.#output.write(`\r\u001B[2K${frame} ${this.#message}`)
  }
}
