// Automatic fallback: deciding when a chat should move to another provider
// because this provider's monthly API credit is nearly used up. Pure functions,
// used by the main process (which decides) and the window (which warns first).

import type { FallbackSettings, Provider, SpendSummary } from './types'

export const DEFAULT_FALLBACK: FallbackSettings = { enabled: false, thresholdPct: 85, prefer: 'auto' }
/** Thresholds offered in Settings. */
export const FALLBACK_THRESHOLDS = [70, 80, 85, 90, 95]
/** A fallback needs somewhere to go. */
export const FALLBACK_MIN_PROVIDERS = 2

export type CreditState = Pick<SpendSummary, 'spentUsd' | 'liveUsd' | 'monthlyUsd'>

/** Share of this cycle's credit that is used, in percent. Null when no monthly credit is set. */
export function creditUsedPct(state: CreditState): number | null {
  if (!(state.monthlyUsd > 0)) return null
  // Multiply first: 90 of 100 should be exactly 90, not 90.00000000000001.
  return ((state.spentUsd + state.liveUsd) * 100) / state.monthlyUsd
}

export function creditLeftUsd(state: CreditState): number {
  return Math.max(0, state.monthlyUsd - state.spentUsd - state.liveUsd)
}

export function cleanFallback(value: Partial<FallbackSettings> | undefined): FallbackSettings {
  const threshold = Number(value?.thresholdPct)
  const prefer = value?.prefer
  return {
    enabled: value?.enabled === true,
    thresholdPct: Number.isFinite(threshold) ? Math.min(99, Math.max(50, Math.round(threshold))) : DEFAULT_FALLBACK.thresholdPct,
    prefer: prefer === 'claude' || prefer === 'chatgpt' || prefer === 'gemini' ? prefer : 'auto',
  }
}

export type FallbackPlan =
  /** Carry on with this provider. */
  | { kind: 'none' }
  /** This provider's credit is nearly used up and another one has credit to spare. */
  | { kind: 'switch'; to: Provider; usedPct: number }
  /** This provider's credit is nearly used up, and so is everyone else's. */
  | { kind: 'stuck'; usedPct: number }

export interface FallbackInput {
  fallback: FallbackSettings | undefined
  spend: Record<Provider, CreditState>
  /** Providers that have an API key saved. */
  connected: Provider[]
  /** Provider the chat is on now. */
  from: Provider
}

/**
 * Where should the next message go? A provider is only a target when it is
 * connected, has a monthly credit set and is itself under the threshold: the
 * point is to spend credit that would otherwise go unused, never to move the
 * bill onto a card.
 */
export function planFallback(input: FallbackInput): FallbackPlan {
  const settings = cleanFallback(input.fallback)
  if (!settings.enabled || input.connected.length < FALLBACK_MIN_PROVIDERS) return { kind: 'none' }
  const usedPct = creditUsedPct(input.spend[input.from])
  if (usedPct === null || usedPct < settings.thresholdPct) return { kind: 'none' }

  const candidates = input.connected.filter((provider) => {
    if (provider === input.from) return false
    const used = creditUsedPct(input.spend[provider])
    return used !== null && used < settings.thresholdPct
  })
  if (candidates.length === 0) return { kind: 'stuck', usedPct }
  if (settings.prefer !== 'auto' && candidates.includes(settings.prefer)) {
    return { kind: 'switch', to: settings.prefer, usedPct }
  }
  // Most dollars of credit left wins; the order of `connected` breaks a tie.
  let best = candidates[0]!
  for (const provider of candidates) {
    if (creditLeftUsd(input.spend[provider]) > creditLeftUsd(input.spend[best])) best = provider
  }
  return { kind: 'switch', to: best, usedPct }
}
