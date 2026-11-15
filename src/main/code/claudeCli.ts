// Claude mode's coding agent on the user's Claude subscription.
//
// This runs the Claude Code CLI that is installed on the computer, exactly as
// Anthropic publishes it, in its documented non-interactive mode. The CLI holds
// its own sign-in; Threefold never sees it. The same CLI and the same session
// are used when the plan's limit is reached and the user's API key takes over.

import { randomUUID } from 'node:crypto'
import { tokenCost } from '@shared/pricing'
import { projectRoots, resultText, summarize } from './claudeAgent'
import {
  LIMIT_TEXT,
  SIGNED_OUT_TEXT,
  isRecord,
  parseResetTime,
  runLines,
  toMillis,
  type CliRun,
  type CliRunResult,
} from './cliRun'
import { PERMISSION_TOOL, type PermissionBridge } from './permissionBridge'
import type { AgentContext } from './service'

/** Sources Claude Code reports when no API key is in play, that is, when a Claude account is. */
const PLAN_SOURCES = new Set(['none', 'oauth'])

/** The permission mode that asks before acting. Newer versions call it "manual", older ones "default". */
export function claudePermissionMode(helpText: string): 'manual' | 'default' {
  return /"manual"/.test(helpText) ? 'manual' : 'default'
}

/** The prompt itself goes in on stdin, so its length and its first character never matter. */
export function claudeArgs(input: { mcpConfig: string; permissionMode: string; resume?: string; model?: string }): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Project instructions (CLAUDE.md) apply; personal settings do not, the same as Threefold's API-key agent.
    '--setting-sources',
    'project',
    // Ask before acting, and send the question to Threefold.
    '--permission-mode',
    input.permissionMode,
    '--permission-prompt-tool',
    PERMISSION_TOOL,
    '--mcp-config',
    input.mcpConfig,
    ...(input.resume ? ['--resume', input.resume] : []),
    ...(input.model ? ['--model', input.model] : []),
  ]
}

interface Counted {
  model: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export async function runClaudeCli(
  ctx: AgentContext,
  run: CliRun,
  deps: { bridge: PermissionBridge; permissionMode: string; model?: string },
): Promise<CliRunResult> {
  const result: CliRunResult = { costUsd: 0, inputTokens: 0, outputTokens: 0, estimated: false, billedTo: 'unknown' }
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  const roots = projectRoots(ctx.session.cwd)
  const bridge = await deps.bridge.open((tool, input) => {
    const { summary, detail } = summarize(tool, input, roots)
    return ctx.ask(tool, summary, detail)
  })

  let textItem: string | null = null
  let thinkingItem: string | null = null
  let sawResult = false
  let vague = false
  const plain: string[] = []
  const tools = new Map<string, { name: string; summary: string; input: string }>()
  // One API request can arrive as several messages with the same id; the last one has its final token counts.
  const requests = new Map<string, Counted>()

  const total = (): { cost: number | null; input: number; output: number } => {
    let cost: number | null = 0
    let input = 0
    let output = 0
    for (const request of requests.values()) {
      input += request.input + request.cacheRead + request.cacheWrite
      output += request.output
      const one = tokenCost(request.model, {
        inputTokens: request.input,
        cacheReadTokens: request.cacheRead,
        cacheWriteTokens: request.cacheWrite,
        outputTokens: request.output,
      })
      cost = cost === null || one === null ? null : cost + one
    }
    return { cost, input, output }
  }
  const limited = (detail: string, resetsAt?: number): void => {
    if (run.auth !== 'plan') return
    result.fallback ??= { reason: 'limit', detail, resetsAt: resetsAt ?? parseResetTime(detail) }
  }
  const signedOut = (detail: string): void => {
    if (run.auth === 'plan') result.fallback ??= { reason: 'signed-out', detail }
  }

  const onMessage = (message: Record<string, unknown>): void => {
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') result.sessionId = message.session_id
      if (typeof message.model === 'string') result.model = message.model
      const source = typeof message.apiKeySource === 'string' ? message.apiKeySource : ''
      if (run.auth === 'api') {
        if (source !== 'ANTHROPIC_API_KEY') {
          // Never let a run that should be on the API key use anything else.
          result.error = 'Claude Code did not pick up the API key, so the run was stopped before any work was done.'
          controller.abort()
          return
        }
        result.billedTo = 'api'
      } else {
        result.billedTo = PLAN_SOURCES.has(source) ? 'plan' : 'unknown'
      }
      return
    }

    if (message.type === 'rate_limit_event' && isRecord(message.rate_limit_info)) {
      const info = message.rate_limit_info
      if (info.status === 'rejected') limited('Your plan’s usage limit is reached.', toMillis(info.resetsAt))
      return
    }

    if (message.type === 'stream_event' && isRecord(message.event)) {
      if (message.parent_tool_use_id) return
      const event = message.event
      if (event.type === 'content_block_start') {
        textItem = null
        thinkingItem = null
      } else if (event.type === 'content_block_delta' && isRecord(event.delta)) {
        if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          if (!textItem) {
            textItem = randomUUID()
            ctx.emit.item({ id: textItem, type: 'text', text: '' })
          }
          ctx.emit.delta(textItem, 'text', event.delta.text)
        } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          if (!thinkingItem) {
            thinkingItem = randomUUID()
            ctx.emit.item({ id: thinkingItem, type: 'thinking', text: '' })
          }
          ctx.emit.delta(thinkingItem, 'thinking', event.delta.thinking)
        }
      }
      return
    }

    if (message.type === 'assistant' && isRecord(message.message)) {
      const inner = message.message
      // An error arrives as an ordinary message whose text says what went wrong.
      const said = (Array.isArray(inner.content) ? inner.content : [])
        .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join(' ')
        .trim()
      if (message.error === 'rate_limit') limited(said || 'Your plan’s usage limit is reached.')
      if (message.error === 'authentication_failed') signedOut(said || 'Claude Code is not signed in.')
      for (const block of Array.isArray(inner.content) ? inner.content : []) {
        if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
        const { summary, detail } = summarize(block.name, isRecord(block.input) ? block.input : {}, roots)
        tools.set(block.id, { name: block.name, summary, input: detail })
        ctx.emit.item({ id: block.id, type: 'tool', name: block.name, summary, input: detail || undefined, status: 'running' })
      }
      if (isRecord(inner.usage) && typeof inner.id === 'string') {
        requests.set(inner.id, {
          model: typeof inner.model === 'string' ? inner.model : (result.model ?? ''),
          input: num(inner.usage.input_tokens),
          cacheRead: num(inner.usage.cache_read_input_tokens),
          cacheWrite: num(inner.usage.cache_creation_input_tokens),
          output: num(inner.usage.output_tokens),
        })
        // A plan run is not billed per token, so only an API run moves the cost meter.
        const so = total()
        if (run.auth === 'api' && so.cost !== null) ctx.emit.cost(so.cost, true)
      }
      return
    }

    if (message.type === 'user' && isRecord(message.message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const known = tools.get(block.tool_use_id)
        if (!known) continue
        ctx.emit.item({
          id: block.tool_use_id,
          type: 'tool',
          name: known.name,
          summary: known.summary,
          input: known.input || undefined,
          output: resultText(block.content).slice(0, 20_000) || undefined,
          status: block.is_error ? 'error' : 'done',
        })
      }
      return
    }

    if (message.type === 'result') {
      sawResult = true
      if (typeof message.session_id === 'string') result.sessionId ??= message.session_id
      const listed = Array.isArray(message.errors) ? message.errors.filter((entry) => typeof entry === 'string').join(' ') : ''
      const text = (typeof message.result === 'string' ? message.result : '') || listed
      const failed = message.subtype !== 'success' || message.is_error === true
      if (failed) {
        if (LIMIT_TEXT.test(text)) limited(text)
        else if (SIGNED_OUT_TEXT.test(text)) signedOut(text)
        // Some failures carry no text here; the reason was printed as a plain line instead.
        vague = !text && message.subtype !== 'error_max_turns'
        result.error ??=
          message.subtype === 'error_max_turns'
            ? 'The agent stopped because it reached its turn limit.'
            : text || 'The agent stopped because of an error.'
      }
      // The CLI's own total covers the whole conversation on a resumed session, earlier
      // turns included, so this turn's cost is worked out from this turn's requests.
      const so = total()
      if (run.auth === 'api' && so.cost === null && typeof message.total_cost_usd === 'number') {
        result.costUsd = message.total_cost_usd
        result.estimated = true
      }
    }
  }

  const args = claudeArgs({
    mcpConfig: bridge.mcpConfig,
    permissionMode: deps.permissionMode,
    resume: run.resume,
    model: deps.model,
  })
  const finished = await runLines(run.file, args, { env: run.env, cwd: ctx.session.cwd, signal: controller.signal, input: run.prompt }, (line) => {
    try {
      const message: unknown = JSON.parse(line)
      if (isRecord(message)) onMessage(message)
    } catch {
      // Not JSON: a plain line of text, which is how some errors are reported.
      plain.push(line.trim())
    }
  })
  bridge.close()
  ctx.signal.removeEventListener('abort', onAbort)

  const so = total()
  result.inputTokens = so.input
  result.outputTokens = so.output
  if (run.auth === 'api') {
    if (so.cost !== null) result.costUsd = so.cost
    ctx.emit.cost(result.costUsd, false)
  }
  if (ctx.signal.aborted) {
    result.error = 'Stopped.'
    result.estimated = true
    result.fallback = undefined
    return result
  }
  // What the tool said outside its JSON output, most recent last.
  const said = [...plain, ...finished.stderr.split('\n')].map((line) => line.trim()).filter(Boolean).slice(-3).join(' ')
  if (finished.spawnError) result.error ??= `Claude Code could not be started: ${finished.spawnError}`
  else if ((!sawResult && !result.error) || (vague && said)) {
    if (LIMIT_TEXT.test(said)) limited(said)
    else if (SIGNED_OUT_TEXT.test(said)) signedOut(said)
    result.error = said || `Claude Code ended unexpectedly (exit code ${finished.code ?? 'none'}).`
  }
  return result
}
