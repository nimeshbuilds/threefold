// Code tab sessions: one project folder, one agent, a transcript, and a
// permission prompt whenever the agent wants to change something.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isCliProvider } from '@shared/types'
import type {
  CliProvider,
  CliSetup,
  CodeEvent,
  CodeItem,
  CodeSession,
  PermissionDecision,
  PermissionRequest,
  Provider,
  SpendSummary,
} from '@shared/types'
import { formatTokens, formatUsd, modelLabel } from '@shared/pricing'
import type { Secrets } from '../secrets'
import type { Store } from '../store'
import { DEMO, keyHelp } from '../chat'
import { runClaudeAgent } from './claudeAgent'
import { claudePermissionMode, runClaudeCli } from './claudeCli'
import { CLI, type CliManager } from './cli'
import { EXPIRED_TEXT, type CliRun, type CliRunResult } from './cliRun'
import { CODEX_SANDBOX_NOTE, runCodexCli } from './codexCli'
import { runGeminiAgent } from './geminiAgent'
import { runOpenAIAgent } from './openaiAgent'
import type { PermissionBridge } from './permissionBridge'

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
  /** The turn could not use the plan because the CLI needs installing or signing in to. */
  setup?: CliSetup
}

const AGENTS: Record<Provider, (ctx: AgentContext) => Promise<AgentResult>> = {
  claude: runClaudeAgent,
  chatgpt: runOpenAIAgent,
  gemini: runGeminiAgent,
}

/** What a subscription is called in each mode. */
export const PLAN_NAME: Record<CliProvider, string> = { claude: 'Claude plan', chatgpt: 'ChatGPT plan' }
/** How long the plan is left alone after its limit is reached, when the tool does not say when it resets. */
const LIMIT_PAUSE_MS = 30 * 60_000
/** The tool says the session it was asked to continue is not there. */
const SESSION_GONE = /no conversation found|session[^.]*not found|thread[^.]*not found|no rollout found/i

function clock(time: number): string {
  const when = new Date(time)
  const today = new Date().toDateString() === when.toDateString()
  const at = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return today ? at : `${when.toLocaleDateString([], { weekday: 'short' })} ${at}`
}

/** The tools a session on the official CLIs needs. */
export interface CliTools {
  cli: CliManager
  bridge: PermissionBridge
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
    private readonly secrets: Pick<Secrets, 'get'>,
    private readonly send: (event: CodeEvent) => void,
    private readonly sendSpend: (summary: Record<Provider, SpendSummary>) => void,
    private readonly tools?: CliTools,
  ) {}

  private keyFor(provider: Provider): string | null {
    return DEMO ? 'demo' : this.secrets.get(provider)
  }

  create(provider: Provider, cwd: string): CodeSession {
    const now = Date.now()
    // With "use my subscription" on, a new session runs through the official CLI for good.
    const viaCli = Boolean(this.tools) && isCliProvider(provider) && this.store.getSettings().subscription[provider]
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
      ...(viaCli ? { engine: 'cli' as const } : {}),
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

  /** True while a coding session is running. */
  busy(): boolean {
    return this.running.size > 0
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

  start(sessionId: string, prompt: string, model?: string, again = false): { ok: boolean; error?: string } {
    const session = this.store.getCodeSession(sessionId)
    if (!session) return { ok: false, error: 'That session no longer exists.' }
    if (this.running.has(sessionId)) return { ok: false, error: 'The agent is still working.' }
    if (!prompt.trim()) return { ok: false, error: 'Describe what you want done first.' }
    const viaCli = session.engine === 'cli' && isCliProvider(session.provider) && Boolean(this.tools)
    if (DEMO && !viaCli) return { ok: false, error: 'The Code tab needs a real API key; it is not available in demo mode.' }
    const apiKey = this.keyFor(session.provider)
    // A session on the CLI can run on the plan alone; the API key is only its fallback.
    if (!apiKey && !viaCli) return { ok: false, error: keyHelp(session.provider) }
    if (model) session.model = model

    const controller = new AbortController()
    this.running.set(sessionId, controller)
    this.active.set(sessionId, session)
    void this.run(session, prompt.trim(), apiKey, controller, again).finally(() => {
      this.running.delete(sessionId)
      this.active.delete(sessionId)
    })
    return { ok: true }
  }

  private async run(
    session: CodeSession,
    prompt: string,
    apiKey: string | null,
    controller: AbortController,
    again = false,
  ): Promise<void> {
    const liveKey = `code:${session.id}:${Date.now()}`
    const upsert = (item: CodeItem): void => {
      const index = session.items.findIndex((existing) => existing.id === item.id)
      if (index === -1) session.items.push(item)
      else session.items[index] = item
      this.send({ type: 'item', sessionId: session.id, item })
    }

    if (session.items.length === 0) session.title = prompt.slice(0, 60)
    // A prompt sent again after the turn never got going is already on screen.
    const last = [...session.items].reverse().find((item) => item.type === 'user')
    const shown = again && last?.type === 'user' && last.text === prompt
    if (shown) {
      // The notices that explained why it stopped have done their job.
      const from = session.items.lastIndexOf(last)
      session.items = session.items.filter((item, index) => index <= from || item.type !== 'notice' || !item.setup)
    } else {
      upsert({ id: randomUUID(), type: 'user', text: prompt })
    }
    session.updatedAt = Date.now()
    this.store.saveCodeSession(session)

    const context: AgentContext = {
      apiKey: apiKey ?? '',
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
      result =
        session.engine === 'cli' && isCliProvider(session.provider) && this.tools
          ? await this.runOnCli(context, session.provider, apiKey, this.tools)
          : await AGENTS[session.provider](context)
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
        ...(result.setup ? { setup: result.setup } : {}),
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

  /**
   * One turn of a session that runs on an official CLI. The user's plan is
   * tried first; when the plan's limit is reached (or nobody is signed in) the
   * same CLI carries on in the same session with the API key, and the user is
   * told. Only the API part is returned as cost: a plan run is not billed per token.
   */
  private async runOnCli(context: AgentContext, provider: CliProvider, apiKey: string | null, tools: CliTools): Promise<AgentResult> {
    const { cli, bridge } = tools
    const { session } = context
    const spec = CLI[provider]
    const plan = PLAN_NAME[provider]
    const nothing = (error: string, setup?: CliSetup): AgentResult => ({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      error,
      setup,
    })
    const note = (text: string, setup?: CliSetup): void =>
      context.emit.item({ id: randomUUID(), type: 'notice', text, tone: 'info', ...(setup ? { setup } : {}) })

    const file = await cli.find(provider)
    if (!file) return nothing(`${spec.name} is not installed on this computer.`, { provider, need: 'install' })

    const usePlan = this.store.getSettings().subscription[provider]
    const pausedUntil = cli.limitedUntil(provider)
    if (!(usePlan && !pausedUntil) && !apiKey) {
      return nothing(
        usePlan
          ? `Your ${plan}’s limit is reached until ${clock(pausedUntil!)} and there is no API key to carry on with. ${keyHelp(provider)}`
          : keyHelp(provider),
      )
    }
    if (usePlan && pausedUntil) note(`Your ${plan}’s limit is reached until ${clock(pausedUntil)}. Using your API key until then.`)
    if (provider === 'chatgpt' && !session.cliSessionId) note(CODEX_SANDBOX_NOTE)

    // Did the run get anywhere? That decides how a second attempt is worded.
    let progressed = false
    const watched: AgentContext = {
      ...context,
      emit: {
        ...context.emit,
        item: (item) => {
          if (item.type !== 'notice') progressed = true
          context.emit.item(item)
        },
      },
    }

    const once = async (auth: CliRun['auth'], prompt: string): Promise<CliRunResult> => {
      const env = await cli.env(
        provider === 'claude'
          ? { ANTHROPIC_API_KEY: auth === 'api' ? (apiKey ?? undefined) : undefined }
          : { CODEX_API_KEY: auth === 'api' ? (apiKey ?? undefined) : undefined, OPENAI_API_KEY: undefined },
      )
      const run: CliRun = { file, env, auth, prompt, resume: session.cliSessionId }
      // On the plan the CLI uses its own model. On the API key the session's model is named, so its price is known.
      const model = auth === 'api' ? session.model : undefined
      const result =
        provider === 'claude'
          ? await runClaudeCli(watched, run, { bridge, permissionMode: claudePermissionMode(await cli.help(file)), model })
          : await runCodexCli(watched, run, { model })
      if (result.sessionId) session.cliSessionId = result.sessionId
      return result
    }
    const attempt = async (auth: CliRun['auth'], prompt: string): Promise<CliRunResult> => {
      const continuing = Boolean(session.cliSessionId)
      const result = await once(auth, prompt)
      if (!continuing || !result.error || !SESSION_GONE.test(result.error) || context.signal.aborted) return result
      // The CLI no longer has the earlier conversation (its history was cleared, say).
      // Start a new one rather than fail every turn from now on.
      session.cliSessionId = undefined
      note('The earlier conversation is no longer on this computer, so this turn starts a new one.')
      return once(auth, context.prompt)
    }

    let auth: CliRun['auth'] = usePlan && !pausedUntil ? 'plan' : 'api'
    let result = await attempt(auth, context.prompt)

    if (auth === 'plan' && result.fallback && !context.signal.aborted) {
      const { fallback } = result
      let why: string
      if (fallback.reason === 'limit') {
        const until = fallback.resetsAt && fallback.resetsAt > Date.now() ? fallback.resetsAt : Date.now() + LIMIT_PAUSE_MS
        cli.noteLimit(provider, until)
        why = `Your ${plan}’s usage limit is reached${fallback.resetsAt ? ` (it resets at ${clock(until)})` : ''}.`
      } else {
        why = EXPIRED_TEXT.test(fallback.detail)
          ? `${spec.name}’s sign-in to your ${plan} has expired.`
          : `${spec.name} is not signed in to your ${plan}.`
      }
      // Signing in is one click away, right under this message.
      const signIn: CliSetup | undefined = fallback.reason === 'signed-out' ? { provider, need: 'sign-in' } : undefined
      if (!apiKey) {
        return nothing(
          fallback.reason === 'limit' ? `${why} Add an API key in Settings and Threefold will carry on with it when this happens.` : why,
          signIn,
        )
      }
      note(`${why} Carrying on with your API key.`, signIn)
      // The request is sent again, because the cut-off attempt may or may not have saved it.
      const again = progressed
        ? `The previous attempt at the request below was cut off before it finished. Carry on from where it stopped and do not redo work that is already done.\n\n${context.prompt}`
        : context.prompt
      auth = 'api'
      result = await attempt(auth, again)
    } else if (auth === 'plan' && !result.error) {
      // The plan answered, so any earlier pause is over.
      cli.clearLimit(provider)
    }

    const tokens = `${formatTokens(result.inputTokens)} tokens in, ${formatTokens(result.outputTokens)} out`
    if (result.inputTokens + result.outputTokens > 0 || !result.error) {
      if (auth === 'api') {
        note(`Ran on your API key · ${formatUsd(result.costUsd, { estimated: result.estimated })} · ${tokens}`)
      } else if (result.billedTo === 'unknown') {
        note(`${spec.name} did not report a ${plan} as the account for this run. Check how it is signed in under “Use subscription”.`)
      } else {
        const model = result.model ? ` (${modelLabel(result.model)})` : ''
        note(`Ran on your ${plan}${model} · ${tokens} · not billed to your API key`)
      }
    }
    const billed = auth === 'api'
    return {
      costUsd: billed ? result.costUsd : 0,
      inputTokens: billed ? result.inputTokens : 0,
      outputTokens: billed ? result.outputTokens : 0,
      estimated: result.estimated,
      error: result.error,
    }
  }
}
