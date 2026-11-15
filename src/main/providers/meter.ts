// Live cost meter for one chat turn.
//
// A turn can be several API requests (tool loops). Requests that have finished
// are priced from the token counts the provider reported. The request that is
// still streaming is priced from what is known so far: exact input tokens when
// the provider sends them up front, otherwise an estimate from text length.

import type { Usage } from '@shared/types'
import { addRequest, emptyUsage, estimateTokens, type RequestExtras, type TokenCounts } from '@shared/pricing'

const EMIT_EVERY_MS = 120

export class LiveMeter {
  private confirmed: Usage
  private current: { model: string; tokens: TokenCounts; outputChars: number; exactInput: boolean } | null = null
  private lastEmit = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    model: string,
    private readonly emit: (usage: Usage) => void,
  ) {
    this.confirmed = emptyUsage(model)
  }

  /** A request went out. Pass exact input counts if known, or an estimate. */
  requestStarted(model: string, input: Omit<TokenCounts, 'outputTokens'>, exactInput: boolean): void {
    this.current = { model, tokens: { ...input, outputTokens: 0 }, outputChars: 0, exactInput }
    this.schedule(true)
  }

  /** The provider reported exact input counts for the request in flight. */
  inputKnown(model: string, input: Omit<TokenCounts, 'outputTokens'>): void {
    if (!this.current) {
      this.requestStarted(model, input, true)
      return
    }
    this.current.model = model
    this.current.tokens = { ...input, outputTokens: this.current.tokens.outputTokens }
    this.current.exactInput = true
    this.schedule(true)
  }

  /** Text, reasoning or tool input arrived on the stream. */
  outputChars(count: number): void {
    if (!this.current || count <= 0) return
    this.current.outputChars += count
    this.schedule(false)
  }

  /** The request finished and the provider reported what it billed. */
  requestFinished(model: string, tokens: TokenCounts, extras: RequestExtras = {}): void {
    this.confirmed = addRequest(this.confirmed, model, tokens, extras)
    this.current = null
    this.schedule(true)
  }

  /** Adds a flat fee that is not tied to tokens (for example a sandbox session). */
  addFee(feesUsd: number): void {
    this.confirmed = addRequest(
      this.confirmed,
      this.confirmed.model,
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { feesUsd },
    )
    this.schedule(true)
  }

  snapshot(): Usage {
    if (!this.current) return { ...this.confirmed, estimated: false }
    const tokens: TokenCounts = {
      ...this.current.tokens,
      outputTokens: Math.max(this.current.tokens.outputTokens, estimateTokens(this.current.outputChars)),
    }
    return { ...addRequest(this.confirmed, this.current.model, tokens), estimated: true }
  }

  /** Final figure for the turn. `interrupted` keeps the estimate flag when the stream was cut short. */
  finish(interrupted: boolean): Usage {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const usage = this.snapshot()
    if (interrupted && this.current) {
      // The provider never confirmed this request, so keep what we estimated.
      this.confirmed = { ...usage, estimated: true }
      this.current = null
      return this.confirmed
    }
    return usage
  }

  private schedule(now: boolean): void {
    const fire = (): void => {
      this.timer = null
      this.lastEmit = Date.now()
      this.emit(this.snapshot())
    }
    if (now) {
      if (this.timer) clearTimeout(this.timer)
      fire()
      return
    }
    if (this.timer) return
    const wait = Math.max(0, EMIT_EVERY_MS - (Date.now() - this.lastEmit))
    this.timer = setTimeout(fire, wait)
  }
}
