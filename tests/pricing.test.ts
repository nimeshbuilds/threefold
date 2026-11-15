import { describe, expect, it } from 'vitest'
import {
  TOOL_FEES,
  addRequest,
  billingCycle,
  emptyUsage,
  findModel,
  formatUsd,
  tokenCost,
  understated,
} from '@shared/pricing'

const M = 1_000_000

describe('tokenCost', () => {
  it('prices Claude Opus 5.5 input, output and cache separately', () => {
    const cost = tokenCost('claude-opus-5-5', {
      inputTokens: M,
      cacheReadTokens: M,
      cacheWriteTokens: M,
      outputTokens: M,
    })
    // $4 input + $0.20 cache read + $5 cache write + $20 output
    expect(cost).toBeCloseTo(29.2, 6)
  })

  it('switches Claude Haiku 5.5 to its long-context rates above 100K prompt tokens', () => {
    const small = tokenCost('claude-haiku-5-5', { inputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    const large = tokenCost('claude-haiku-5-5', { inputTokens: 100_001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    expect(small).toBeCloseTo(0.01, 6)
    expect(large).toBeCloseTo((100_001 * 0.5) / M, 8)
  })

  it('counts cached prompt tokens toward the long-context threshold', () => {
    const cost = tokenCost('claude-haiku-5-5', { inputTokens: 10, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 0 })
    expect(cost).toBeCloseTo((10 * 0.5 + 100_000 * 0.05) / M, 10)
  })

  it('prices a GPT model with cached input', () => {
    const cost = tokenCost('gpt-6.1-sol', { inputTokens: M, cacheReadTokens: M, cacheWriteTokens: 0, outputTokens: M })
    expect(cost).toBeCloseTo(2 + 0.1 + 10, 6)
  })

  it('returns null for a model that is not in the table', () => {
    expect(tokenCost('some-future-model', { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })).toBeNull()
  })
})

describe('findModel', () => {
  it('matches a dated snapshot id to its base model', () => {
    expect(findModel('gpt-6.1-sol-2026-09-30')?.id).toBe('gpt-6.1-sol')
  })

  it('does not confuse a model with a longer sibling name', () => {
    expect(findModel('gpt-5.4-mini')?.id).toBe('gpt-5.4-mini')
    expect(findModel('gpt-5.4')?.id).toBe('gpt-5.4')
  })
})

describe('addRequest', () => {
  it('accumulates requests and adds the web search fee', () => {
    let usage = emptyUsage('claude-sonnet-5-5')
    usage = addRequest(usage, 'claude-sonnet-5-5', { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }, { webSearches: 2 })
    usage = addRequest(usage, 'claude-sonnet-5-5', { inputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 })
    expect(usage.inputTokens).toBe(3000)
    expect(usage.outputTokens).toBe(600)
    expect(usage.webSearches).toBe(2)
    const tokens = (3000 * 2 + 600 * 10) / M
    expect(usage.costUsd).toBeCloseTo(tokens + 2 * TOOL_FEES.webSearch, 9)
  })

  it('prices a fallback request on the model that actually ran', () => {
    let usage = emptyUsage('claude-fable-5-2')
    usage = addRequest(usage, 'claude-opus-5-5', { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    expect(usage.costUsd).toBeCloseTo(4, 6)
  })

  it('marks the turn as unpriced when a model is unknown, without inventing a cost', () => {
    const usage = addRequest(emptyUsage('mystery'), 'mystery', { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 })
    expect(usage.priced).toBe(false)
    expect(usage.costUsd).toBe(0)
  })
})

describe('understated', () => {
  it('flags GPT prompts past the long-context threshold, where the table has no rate', () => {
    const usage = addRequest(emptyUsage('gpt-6.1-sol'), 'gpt-6.1-sol', { inputTokens: 300_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })
    expect(understated(usage)).toBe(true)
  })

  it('does not flag ordinary prompts', () => {
    const usage = addRequest(emptyUsage('gpt-6.1-sol'), 'gpt-6.1-sol', { inputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })
    expect(understated(usage)).toBe(false)
  })
})

describe('billingCycle', () => {
  it('starts on the renewal day of this month when that day has passed', () => {
    const now = new Date(2026, 10, 14, 12).getTime()
    const cycle = billingCycle(now, 7)
    expect(new Date(cycle.start)).toEqual(new Date(2026, 10, 7))
    expect(new Date(cycle.end)).toEqual(new Date(2026, 11, 7))
  })

  it('starts last month when the renewal day is still ahead', () => {
    const now = new Date(2026, 10, 14, 12).getTime()
    const cycle = billingCycle(now, 20)
    expect(new Date(cycle.start)).toEqual(new Date(2026, 9, 20))
    expect(new Date(cycle.end)).toEqual(new Date(2026, 10, 20))
  })

  it('rolls over the year boundary', () => {
    const now = new Date(2027, 0, 3).getTime()
    const cycle = billingCycle(now, 15)
    expect(new Date(cycle.start)).toEqual(new Date(2026, 11, 15))
    expect(new Date(cycle.end)).toEqual(new Date(2027, 0, 15))
  })

  it('clamps an out-of-range renewal day', () => {
    const now = new Date(2026, 1, 20).getTime()
    expect(new Date(billingCycle(now, 31).start).getDate()).toBe(28)
  })
})

describe('formatUsd', () => {
  it('shows more digits for small amounts', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.00042)).toBe('$0.0004')
    expect(formatUsd(0.0421)).toBe('$0.042')
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  it('marks estimates', () => {
    expect(formatUsd(0.5, { estimated: true })).toBe('≈ $0.500')
  })
})
