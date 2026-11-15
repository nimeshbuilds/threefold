// Price table and cost maths. Pure functions, used by the main process for the
// ledger and by the renderer for the live meter.
//
// Prices are USD per one million tokens, copied from the providers' public
// pricing pages on the date below. Update this file when prices change.

import type { Provider, Usage } from './types'

export const PRICING_AS_OF = '2026-11-14'

export interface Rates {
  input: number
  output: number
  cacheRead: number
  /** Cache write rate. Providers that do not bill writes separately use the input rate. */
  cacheWrite: number
}

export interface ModelInfo {
  id: string
  provider: Provider
  label: string
  blurb: string
  rates: Rates
  /** Price changes the provider has already announced. `from` is a UTC date, YYYY-MM-DD. */
  scheduled?: Array<{ from: string; rates: Rates }>
  /** Higher rates that apply once the whole prompt passes `threshold` tokens. */
  longContext?: { threshold: number; rates: Rates }
  /** Prompt size above which the provider charges more, but the rate is not in this table. */
  longContextUnknownAbove?: number
  /** Claude only: the model accepts the server-side `fallbacks` parameter. */
  fallbacks?: boolean
  /** Used by a feature (deep research, image generation), not offered in the model picker. */
  internal?: boolean
  /** Image models: USD per 1M image output tokens, billed apart from text output. */
  imageOutput?: number
}

const claude = (
  id: string,
  label: string,
  blurb: string,
  rates: Rates,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({ id, provider: 'claude', label, blurb, rates, ...extra })

const gpt = (id: string, label: string, blurb: string, input: number, cached: number, output: number): ModelInfo => ({
  id,
  provider: 'chatgpt',
  label,
  blurb,
  rates: { input, output, cacheRead: cached, cacheWrite: input },
  longContextUnknownAbove: 272_000,
})

/** Gemini bills implicit cache hits at the "context caching" rate and has no separate write rate. */
const geminiRates = (input: number, cached: number, output: number): Rates => ({
  input,
  output,
  cacheRead: cached,
  cacheWrite: input,
})

const gemini = (
  id: string,
  label: string,
  blurb: string,
  rates: Rates,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({ id, provider: 'gemini', label, blurb, rates, ...extra })

export const MODELS: ModelInfo[] = [
  claude(
    'claude-opus-5-5',
    'Claude Opus 5.5',
    'Best for most work',
    { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    { fallbacks: true },
  ),
  claude(
    'claude-sonnet-5-5',
    'Claude Sonnet 5.5',
    'Fast and capable',
    { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    { fallbacks: true },
  ),
  claude(
    'claude-haiku-5-5',
    'Claude Haiku 5.5',
    'Quickest and cheapest',
    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    { longContext: { threshold: 100_000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } } },
  ),
  claude(
    'claude-fable-5-2',
    'Claude Fable 5.2',
    'Most capable, highest price',
    { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
    { fallbacks: true },
  ),
  gpt('gpt-6.1-sol', 'GPT-6.1 Sol', 'Best for most work', 2, 0.1, 10),
  gpt('gpt-6.1-terra', 'GPT-6.1 Terra', 'Fast and capable', 1, 0.05, 5),
  gpt('gpt-6-luna', 'GPT-6 Luna', 'Quickest and cheapest', 0.1, 0.01, 0.5),
  gpt('gpt-6-astra', 'GPT-6 Astra', 'Most capable, highest price', 10, 1, 50),
  gpt('gpt-6-sol', 'GPT-6 Sol', 'Previous Sol', 2, 0.2, 10),
  gpt('gpt-5.6-sol', 'GPT-5.6 Sol', 'Older generation', 4, 0.4, 20),
  gpt('gpt-5.6-terra', 'GPT-5.6 Terra', 'Older generation', 2, 0.2, 12),
  gpt('gpt-5.6-luna', 'GPT-5.6 Luna', 'Older generation', 0.2, 0.02, 1.2),
  gpt('gpt-5.5', 'GPT-5.5', 'Older generation', 5, 0.5, 30),
  gpt('gpt-5.4', 'GPT-5.4', 'Older generation', 2.5, 0.25, 15),
  gpt('gpt-5.4-mini', 'GPT-5.4 mini', 'Older generation', 0.75, 0.075, 4.5),
  gpt('gpt-5.4-nano', 'GPT-5.4 nano', 'Older generation', 0.2, 0.02, 1.25),
  gemini('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'Best for most work', geminiRates(1.5, 0.075, 7.5)),
  gemini(
    'gemini-4-argon',
    'Gemini 4 Argon',
    'Efficient frontier model',
    // Introductory price; Google's page lists the doubled rate from 1 December 2026.
    geminiRates(2, 0.1, 10),
    { scheduled: [{ from: '2026-12-01', rates: geminiRates(4, 0.2, 20) }] },
  ),
  gemini(
    'gemini-4-carbon',
    'Gemini 4 Carbon',
    'Most capable',
    geminiRates(2, 0.1, 10),
    { scheduled: [{ from: '2026-12-01', rates: geminiRates(4, 0.2, 20) }] },
  ),
  gemini(
    'gemini-3.8-flash',
    'Gemini 3.8 Flash',
    'Fast and capable',
    geminiRates(0.75, 0.075, 3.75),
    { scheduled: [{ from: '2027-01-01', rates: geminiRates(1.5, 0.15, 7.5) }] },
  ),
  gemini('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'Quickest and cheapest', geminiRates(0.3, 0.03, 2.5)),
  // Google bills its Deep Research agent at "standard Gemini list rates" without naming the model.
  // Its own cost estimates match the Gemini 4 Carbon rates, so those are used and the result is marked as an estimate.
  gemini('deep-research-preview-04-2026', 'Gemini Deep Research', 'Research agent', geminiRates(2, 0.1, 10), {
    internal: true,
    scheduled: [{ from: '2026-12-01', rates: geminiRates(4, 0.2, 20) }],
  }),
  gemini('gemini-nano-banana-2.1', 'Nano Banana 2.1', 'Image generation', geminiRates(1.5, 1.5, 7.5), {
    internal: true,
    imageOutput: 30,
  }),
  gemini(
    'gemini-3.1-pro-preview',
    'Gemini 3.1 Pro',
    'Older generation',
    geminiRates(2, 0.2, 12),
    { longContext: { threshold: 200_000, rates: geminiRates(4, 0.4, 18) } },
  ),
]

export const DEFAULT_MODEL: Record<Provider, string> = {
  claude: 'claude-opus-5-5',
  chatgpt: 'gpt-6.1-sol',
  gemini: 'gemini-4-hydrogen',
}

/** Gemini's deep research runs on an agent, not on the chat model. */
export const GEMINI_RESEARCH_AGENT = 'deep-research-preview-04-2026'
/** Gemini's image model. */
export const GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1'

/** Cheapest model per provider, used for small background jobs such as naming a chat. */
export const UTILITY_MODEL: Record<Provider, string> = {
  claude: 'claude-haiku-5-5',
  chatgpt: 'gpt-6-luna',
  gemini: 'gemini-3.5-flash-lite',
}

/** Flat fees charged per tool call, in USD. */
export const TOOL_FEES = {
  /** Price of one web search. Anthropic and OpenAI list $10 per 1,000; Google lists $14 per 1,000. */
  webSearch: { claude: 0.01, chatgpt: 0.01, gemini: 0.014 } satisfies Record<Provider, number>,
  /** Google includes this many searches a month before the fee applies. */
  geminiFreeSearchesPerMonth: 5000,
  /** OpenAI code interpreter: $0.03 per 1 GB container session (20 minutes). */
  openaiContainerSession: 0.03,
  openaiContainerMinutes: 20,
}

export function findModel(id: string): ModelInfo | undefined {
  const exact = MODELS.find((m) => m.id === id)
  if (exact) return exact
  // Providers sometimes return a dated snapshot id ("gpt-6.1-sol-2026-09-30").
  return MODELS.filter((m) => id.startsWith(m.id + '-')).sort((a, b) => b.id.length - a.id.length)[0]
}

export function modelLabel(id: string): string {
  return findModel(id)?.label ?? id
}

/** The base rates in force at `now`, taking announced price changes into account. */
export function currentRates(model: ModelInfo, now = Date.now()): Rates {
  let rates = model.rates
  for (const change of [...(model.scheduled ?? [])].sort((a, b) => a.from.localeCompare(b.from))) {
    if (now >= Date.parse(`${change.from}T00:00:00Z`)) rates = change.rates
  }
  return rates
}

export interface TokenCounts {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Cost in USD of one request's tokens on one model. Returns null when the model is not priced. */
export function tokenCost(modelId: string, t: TokenCounts, now = Date.now()): number | null {
  const model = findModel(modelId)
  if (!model) return null
  const promptTokens = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
  const rates =
    model.longContext && promptTokens > model.longContext.threshold
      ? model.longContext.rates
      : currentRates(model, now)
  return (
    (t.inputTokens * rates.input +
      t.cacheReadTokens * rates.cacheRead +
      t.cacheWriteTokens * rates.cacheWrite +
      t.outputTokens * rates.output) /
    1_000_000
  )
}

/** Cost of one image-model request: text tokens at the text rates, image tokens at the image rate. */
export function imageCost(
  modelId: string,
  tokens: { inputTokens: number; textOutputTokens: number; imageOutputTokens: number },
  now = Date.now(),
): number | null {
  const model = findModel(modelId)
  if (!model || model.imageOutput === undefined) return null
  const rates = currentRates(model, now)
  return (
    (tokens.inputTokens * rates.input +
      tokens.textOutputTokens * rates.output +
      tokens.imageOutputTokens * model.imageOutput) /
    1_000_000
  )
}

export function emptyUsage(model: string): Usage {
  return {
    model,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    webSearches: 0,
    feesUsd: 0,
    costUsd: 0,
    priced: findModel(model) !== undefined,
    estimated: true,
  }
}

export interface RequestExtras {
  webSearches?: number
  /** How many of those searches fall inside a free allowance. */
  freeWebSearches?: number
  feesUsd?: number
}

/**
 * Adds one request to a running turn total. `model` may differ from the turn's
 * model when the provider fell back to another model for this request.
 */
export function addRequest(usage: Usage, model: string, tokens: TokenCounts, extras: RequestExtras = {}): Usage {
  const cost = tokenCost(model, tokens)
  const webSearches = extras.webSearches ?? 0
  const billable = Math.max(0, webSearches - (extras.freeWebSearches ?? 0))
  const provider = findModel(model)?.provider ?? findModel(usage.model)?.provider
  const searchFee = provider ? TOOL_FEES.webSearch[provider] : TOOL_FEES.webSearch.claude
  const fees = (extras.feesUsd ?? 0) + billable * searchFee
  return {
    ...usage,
    inputTokens: usage.inputTokens + tokens.inputTokens,
    cacheReadTokens: usage.cacheReadTokens + tokens.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens + tokens.cacheWriteTokens,
    outputTokens: usage.outputTokens + tokens.outputTokens,
    webSearches: usage.webSearches + webSearches,
    feesUsd: usage.feesUsd + fees,
    costUsd: usage.costUsd + (cost ?? 0) + fees,
    priced: usage.priced && cost !== null,
  }
}

/** Rough token count for text that has not been billed yet. Only used for live estimates. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.6)
}

/** True when the prompt was large enough that the provider's (unknown to us) long-context rate applies. */
export function understated(usage: Usage): boolean {
  const model = findModel(usage.model)
  if (!model?.longContextUnknownAbove) return false
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > model.longContextUnknownAbove
}

export function formatUsd(value: number, opts: { estimated?: boolean } = {}): string {
  const prefix = opts.estimated ? '≈ ' : ''
  if (value === 0) return `${prefix}$0.00`
  if (value < 0.01) return `${prefix}$${value.toFixed(4)}`
  if (value < 1) return `${prefix}$${value.toFixed(3)}`
  return `${prefix}$${value.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Start and end (exclusive) of the billing cycle that contains `now`, given the renewal day. */
export function billingCycle(now: number, renewalDay: number): { start: number; end: number } {
  const day = Math.min(Math.max(Math.round(renewalDay) || 1, 1), 28)
  const d = new Date(now)
  let start = new Date(d.getFullYear(), d.getMonth(), day)
  if (start.getTime() > now) start = new Date(d.getFullYear(), d.getMonth() - 1, day)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, day)
  return { start: start.getTime(), end: end.getTime() }
}
