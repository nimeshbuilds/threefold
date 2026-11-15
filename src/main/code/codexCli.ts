// ChatGPT mode's coding agent on the user's ChatGPT subscription.
//
// This runs the Codex CLI that is installed on the computer, exactly as OpenAI
// publishes it, with `codex exec --json`: its documented non-interactive mode.
// The CLI holds its own sign-in; Threefold never sees it. The same CLI and the
// same thread are used when the plan's limit is reached and the API key takes
// over (OpenAI documents CODEX_API_KEY for exactly that: one run on a key).
//
// Codex does not ask before each step when run this way. It works inside its
// own sandbox instead: it may change files in the project folder and nowhere
// else, and it has no network access.

import { randomUUID } from 'node:crypto'
import { tokenCost } from '@shared/pricing'
import { LIMIT_TEXT, SIGNED_OUT_TEXT, isRecord, parseResetTime, runLines, type CliRun, type CliRunResult } from './cliRun'
import type { AgentContext } from './service'

export const CODEX_SANDBOX_NOTE =
  'Codex is working in its own sandbox: it can change files inside this folder and nowhere else, and it has no network access. It does not ask before each step.'

export function codexArgs(input: { prompt: string; resume?: string; model?: string }): string[] {
  return [
    'exec',
    ...(input.resume ? ['resume', input.resume] : []),
    '--json',
    // Edits stay inside the project folder; nothing is asked and nothing escapes the sandbox.
    '-c',
    'sandbox_mode="workspace-write"',
    '--skip-git-repo-check',
    ...(input.model ? ['-m', input.model] : []),
    // Everything after "--" is the prompt, even when it starts with a dash.
    '--',
    input.prompt,
  ]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export async function runCodexCli(ctx: AgentContext, run: CliRun, deps: { model?: string }): Promise<CliRunResult> {
  const result: CliRunResult = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
    // Codex does not report which sign-in paid, so this follows from how the run was started.
    billedTo: run.auth,
    sessionId: run.resume,
    model: deps.model,
  }
  // Item ids start again at every run, so they are made unique to this one.
  const runId = randomUUID()
  let completed = false
  const plain: string[] = []

  const fail = (message: string): void => {
    if (run.auth === 'plan' && LIMIT_TEXT.test(message)) {
      result.fallback ??= { reason: 'limit', detail: message, resetsAt: parseResetTime(message) }
    } else if (run.auth === 'plan' && SIGNED_OUT_TEXT.test(message)) {
      result.fallback ??= { reason: 'signed-out', detail: message }
    }
    result.error ??= message || 'Codex stopped because of an error.'
  }

  const onItem = (item: Record<string, unknown>, done: boolean): void => {
    const id = `${runId}:${text(item.id) || randomUUID()}`
    switch (item.type) {
      case 'agent_message':
        ctx.emit.item({ id, type: 'text', text: text(item.text) })
        break
      case 'reasoning':
        ctx.emit.item({ id, type: 'thinking', text: text(item.text) })
        break
      case 'command_execution': {
        const command = text(item.command)
        const status = item.status === 'failed' ? 'error' : item.status === 'completed' ? 'done' : done ? 'done' : 'running'
        ctx.emit.item({
          id,
          type: 'tool',
          name: 'Run',
          summary: `Run: ${command.split('\n')[0]!.slice(0, 120)}`,
          input: command || undefined,
          output: text(item.aggregated_output).slice(0, 20_000) || undefined,
          status,
        })
        break
      }
      case 'file_change': {
        const changes = (Array.isArray(item.changes) ? item.changes : []).filter(isRecord)
        const names = changes.map((change) => text(change.path).split('/').pop()).filter(Boolean)
        ctx.emit.item({
          id,
          type: 'tool',
          name: 'Edit',
          summary: `Change ${changes.length === 1 ? names[0] : `${changes.length} files`}`,
          input: changes.map((change) => `${text(change.kind) || 'update'}  ${text(change.path)}`).join('\n') || undefined,
          status: item.status === 'failed' ? 'error' : 'done',
        })
        break
      }
      case 'mcp_tool_call':
        ctx.emit.item({
          id,
          type: 'tool',
          name: `${text(item.server)}.${text(item.tool)}`,
          summary: `Use ${text(item.tool)} from ${text(item.server)}`,
          input: item.arguments === undefined ? undefined : JSON.stringify(item.arguments, null, 2).slice(0, 6000),
          status: item.status === 'failed' ? 'error' : item.status === 'completed' ? 'done' : 'running',
        })
        break
      case 'web_search':
        ctx.emit.item({ id, type: 'tool', name: 'WebSearch', summary: `Search the web: ${text(item.query)}`, status: done ? 'done' : 'running' })
        break
      case 'todo_list': {
        const steps = (Array.isArray(item.items) ? item.items : []).filter(isRecord)
        const finished = steps.filter((step) => step.completed === true).length
        ctx.emit.item({
          id,
          type: 'tool',
          name: 'Plan',
          summary: `Plan: ${finished} of ${steps.length} done`,
          input: steps.map((step) => `${step.completed === true ? '[x]' : '[ ]'} ${text(step.text)}`).join('\n') || undefined,
          status: done ? 'done' : 'running',
        })
        break
      }
      case 'error':
        if (done) ctx.emit.item({ id, type: 'notice', text: text(item.message), tone: 'error' })
        break
    }
  }

  const onEvent = (event: Record<string, unknown>): void => {
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') result.sessionId = event.thread_id
        break
      case 'item.started':
      case 'item.updated':
        if (isRecord(event.item)) onItem(event.item, false)
        break
      case 'item.completed':
        if (isRecord(event.item)) onItem(event.item, true)
        break
      case 'turn.completed': {
        completed = true
        const usage = isRecord(event.usage) ? event.usage : {}
        const cached = num(usage.cached_input_tokens)
        const written = num(usage.cache_write_input_tokens)
        // OpenAI's input count includes the cached and cache-written tokens.
        const fresh = Math.max(0, num(usage.input_tokens) - cached - written)
        result.inputTokens += num(usage.input_tokens)
        result.outputTokens += num(usage.output_tokens)
        if (run.auth === 'api' && deps.model) {
          const cost = tokenCost(deps.model, {
            inputTokens: fresh,
            cacheReadTokens: cached,
            cacheWriteTokens: written,
            outputTokens: num(usage.output_tokens),
          })
          if (cost === null) result.estimated = true
          else result.costUsd += cost
          ctx.emit.cost(result.costUsd, false)
        }
        break
      }
      case 'turn.failed':
        fail(isRecord(event.error) ? text(event.error.message) : '')
        break
      case 'error':
        fail(text(event.message))
        break
    }
  }

  const args = codexArgs({ prompt: run.prompt, resume: run.resume, model: deps.model })
  const finished = await runLines(run.file, args, { env: run.env, cwd: ctx.session.cwd, signal: ctx.signal }, (line) => {
    try {
      const event: unknown = JSON.parse(line)
      if (isRecord(event)) onEvent(event)
    } catch {
      // Not JSON: a plain line of text, which is how some errors are reported.
      plain.push(line.trim())
    }
  })

  if (ctx.signal.aborted) {
    result.error = 'Stopped.'
    result.estimated = true
    result.fallback = undefined
    return result
  }
  if (finished.spawnError) result.error ??= `Codex could not be started: ${finished.spawnError}`
  else if (!completed && !result.error) {
    const said = [...plain, ...finished.stderr.split('\n')].map((line) => line.trim()).filter(Boolean).slice(-3).join(' ')
    fail(said || `Codex ended unexpectedly (exit code ${finished.code ?? 'none'}).`)
  }
  return result
}
