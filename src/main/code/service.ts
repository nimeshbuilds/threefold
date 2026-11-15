// Code tab sessions: one project folder, one agent, a transcript, and a
// permission prompt whenever the agent wants to change something.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  CodeEvent,
  CodeItem,
  CodeSession,
  PermissionDecision,
  PermissionRequest,
  Provider,
  SpendSummary,
} from '@shared/types'
import type { Secrets } from '../secrets'
import type { Store } from '../store'
import { DEMO } from '../chat'
import { runClaudeAgent } from './claudeAgent'
import { runOpenAIAgent } from './openaiAgent'

export interface AgentContext {
  apiKey: string
  session: CodeSession
  prompt: string
  signal: AbortSignal
  emit: {
    /** Adds an item to the transcript, or replaces the one with the same id. */
    item(item: CodeItem): void
    delta(itemId: string, kind: 'text' | 'thinking', delta: string): void
    cost(costUsd: number, estimated: boolean): void
  }
  /** Asks the user before a tool runs. Resolves true when allowed. */
  ask(tool: string, summary: string, detail: string): Promise<boolean>
}

export interface AgentResult {
  costUsd: number
  inputTokens: number
  outputTokens: number
  error?: string
  estimated: boolean
}

export class CodeService {
  private running = new Map<string, AbortController>()
  private pending = new Map<
    string,
    { sessionId: string; request: PermissionRequest; resolve: (decision: PermissionDecision) => void }
  >()
  private active = new Map<string, CodeSession>()

  constructor(
    private readonly store: Store,
    private readonly secrets: Secrets,
    private readonly send: (event: CodeEvent) => void,
    private readonly sendSpend: (summary: Record<Provider, SpendSummary>) => void,
  ) {}

  create(provider: Provider, cwd: string): CodeSession {
    const now = Date.now()
    const session: CodeSession = {
      id: randomUUID(),
      provider,
      title: path.basename(cwd) || 'Project',
      cwd,
      model: this.store.getSettings().defaultModel[provider],
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      items: [],
      autoAllow: [],
    }
    this.store.saveCodeSession(session)
    return session
  }

  /** The session as it is right now, including work in progress that is not on disk yet. */
  get(sessionId: string): CodeSession | null {
    const session = this.active.get(sessionId) ?? this.store.getCodeSession(sessionId)
    if (!session) return null
    const waiting = [...this.pending.values()].find((p) => p.sessionId === sessionId)
    return { ...session, running: this.running.has(sessionId), pendingPermission: waiting?.request }
  }

  stop(sessionId: string): void {
    this.running.get(sessionId)?.abort()
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        pending.resolve('deny')
        this.pending.delete(requestId)
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  respond(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    pending.resolve(decision)
  }

  start(sessionId: string, prompt: string, model?: string): { ok: boolean; error?: string } {
    const session = this.store.getCodeSession(sessionId)
    if (!session) return { ok: false, error: 'That session no longer exists.' }
    if (this.running.has(sessionId)) return { ok: false, error: 'The agent is still working.' }
    if (!prompt.trim()) return { ok: false, error: 'Describe what you want done first.' }
    if (DEMO) return { ok: false, error: 'The Code tab needs a real API key; it is not available in demo mode.' }
    const apiKey = this.secrets.get(session.provider)
    if (!apiKey) {
      return {
        ok: false,
        error: `Add your ${session.provider === 'claude' ? 'Anthropic' : 'OpenAI'} API key in Settings first.`,
      }
    }
    if (model) session.model = model

    const controller = new AbortController()
    this.running.set(sessionId, controller)
    this.active.set(sessionId, session)
    void this.run(session, prompt.trim(), apiKey, controller).finally(() => {
      this.running.delete(sessionId)
      this.active.delete(sessionId)
    })
    return { ok: true }
  }

  private async run(session: CodeSession, prompt: string, apiKey: string, controller: AbortController): Promise<void> {
    const liveKey = `code:${session.id}:${Date.now()}`
    const upsert = (item: CodeItem): void => {
      const index = session.items.findIndex((existing) => existing.id === item.id)
      if (index === -1) session.items.push(item)
      else session.items[index] = item
      this.send({ type: 'item', sessionId: session.id, item })
    }

    if (session.items.length === 0) session.title = prompt.slice(0, 60)
    upsert({ id: randomUUID(), type: 'user', text: prompt })
    session.updatedAt = Date.now()
    this.store.saveCodeSession(session)

    const context: AgentContext = {
      apiKey,
      session,
      prompt,
      signal: controller.signal,
      emit: {
        item: upsert,
        delta: (itemId, kind, delta) => {
          const item = session.items.find((existing) => existing.id === itemId)
          if (item && (item.type === 'text' || item.type === 'thinking')) item.text += delta
          this.send({ type: 'delta', sessionId: session.id, itemId, kind, delta })
        },
        cost: (costUsd, estimated) => {
          this.store.setLive(liveKey, session.provider, costUsd)
          this.send({ type: 'usage', sessionId: session.id, costUsd: session.costUsd + costUsd, estimated })
          this.sendSpend(this.store.spendSummary())
        },
      },
      ask: async (tool, summary, detail) => {
        if (controller.signal.aborted) return false
        if (session.autoAllow.includes(tool)) return true
        const request: PermissionRequest = { requestId: randomUUID(), sessionId: session.id, tool, summary, detail }
        const decision = await new Promise<PermissionDecision>((resolve) => {
          this.pending.set(request.requestId, { sessionId: session.id, request, resolve })
          this.send({ type: 'permission', sessionId: session.id, request })
        })
        if (decision === 'allow-always') session.autoAllow.push(tool)
        return decision !== 'deny'
      },
    }

    let result: AgentResult
    try {
      result = session.provider === 'claude' ? await runClaudeAgent(context) : await runOpenAIAgent(context)
    } catch (error) {
      result = {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimated: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    // Anything still marked as running was interrupted.
    for (const item of session.items) {
      if (item.type === 'tool' && item.status === 'running') item.status = 'error'
    }
    if (result.error) {
      upsert({
        id: randomUUID(),
        type: 'notice',
        text: result.error,
        tone: result.error === 'Stopped.' ? 'info' : 'error',
      })
    }
    session.costUsd += result.costUsd
    session.updatedAt = Date.now()
    this.store.clearLive(liveKey)
    this.store.recordSpend({
      ts: Date.now(),
      provider: session.provider,
      model: session.model,
      costUsd: result.costUsd,
      kind: 'code',
      ref: session.id,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })
    const meta = this.store.saveCodeSession(session)
    this.send({ type: 'usage', sessionId: session.id, costUsd: session.costUsd, estimated: result.estimated })
    this.send({ type: 'done', sessionId: session.id, meta })
    this.sendSpend(this.store.spendSummary())
  }
}
