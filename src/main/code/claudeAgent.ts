// Claude mode coding agent, built on the Claude Agent SDK (Claude Code as a
// library). It runs with the user's API key, so the work is billed to the API
// organization that holds their monthly credits, not to their Claude plan.

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { tokenCost } from '@shared/pricing'
import type { AgentContext, AgentResult } from './service'

// Named so it cannot clash with the `require` the bundler injects into ESM output.
const nodeRequire = createRequire(import.meta.url)

/** In a packaged app the bundled CLI binary lives outside the asar archive. */
function bundledExecutable(): string | undefined {
  try {
    const pkg = nodeRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const binary = pkg.replace(/package\.json$/, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return binary.includes('app.asar') ? binary.replace('app.asar', 'app.asar.unpacked') : undefined
  } catch {
    return undefined
  }
}

function summarize(tool: string, input: Record<string, unknown>): { summary: string; detail: string } {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return { summary: `Run: ${text('command').split('\n')[0]!.slice(0, 120)}`, detail: text('command') }
    case 'Write':
      return { summary: `Write ${text('file_path')}`, detail: text('content').slice(0, 6000) }
    case 'Edit':
    case 'MultiEdit':
      return {
        summary: `Edit ${text('file_path')}`,
        detail: text('old_string') ? `- ${text('old_string')}\n+ ${text('new_string')}`.slice(0, 6000) : JSON.stringify(input, null, 2).slice(0, 6000),
      }
    case 'Read':
      return { summary: `Read ${text('file_path')}`, detail: '' }
    case 'Glob':
      return { summary: `Find files: ${text('pattern')}`, detail: '' }
    case 'Grep':
      return { summary: `Search: ${text('pattern')}`, detail: '' }
    case 'WebFetch':
      return { summary: `Fetch ${text('url')}`, detail: '' }
    case 'WebSearch':
      return { summary: `Search the web: ${text('query')}`, detail: '' }
    default:
      return { summary: tool, detail: JSON.stringify(input, null, 2).slice(0, 6000) }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

export async function runClaudeAgent(ctx: AgentContext): Promise<AgentResult> {
  const abortController = new AbortController()
  const onAbort = (): void => abortController.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  // Use the API key and nothing else: no subscription login, no inherited tokens.
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: ctx.apiKey }
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    delete env[name]
  }

  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let error: string | undefined
  let textItem: string | null = null
  let thinkingItem: string | null = null
  const toolNames = new Map<string, { name: string; summary: string; input: string }>()

  try {
    const stream = query({
      prompt: ctx.prompt,
      options: {
        cwd: ctx.session.cwd,
        model: ctx.session.model,
        env,
        abortController,
        includePartialMessages: true,
        permissionMode: 'default',
        // Project instructions (CLAUDE.md) apply; the user's personal Claude Code settings do not.
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(ctx.session.agentSessionId ? { resume: ctx.session.agentSessionId } : {}),
        ...(bundledExecutable() ? { pathToClaudeCodeExecutable: bundledExecutable() } : {}),
        canUseTool: async (toolName, input) => {
          const { summary, detail } = summarize(toolName, input)
          const allowed = await ctx.ask(toolName, summary, detail)
          return allowed
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'The user declined this action.' }
        },
      },
    })

    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        ctx.session.agentSessionId = message.session_id
        if (message.apiKeySource !== 'ANTHROPIC_API_KEY') {
          // Never fall through to another credential: that could bill the user's Claude plan.
          error = 'The coding agent did not pick up the API key, so the run was stopped before any work was done.'
          abortController.abort()
          break
        }
        continue
      }

      if (message.type === 'stream_event') {
        const event = message.event
        if (message.parent_tool_use_id) continue
        if (event.type === 'content_block_start') {
          textItem = null
          thinkingItem = null
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            if (!textItem) {
              textItem = randomUUID()
              ctx.emit.item({ id: textItem, type: 'text', text: '' })
            }
            ctx.emit.delta(textItem, 'text', event.delta.text)
          } else if (event.delta.type === 'thinking_delta') {
            if (!thinkingItem) {
              thinkingItem = randomUUID()
              ctx.emit.item({ id: thinkingItem, type: 'thinking', text: '' })
            }
            ctx.emit.delta(thinkingItem, 'thinking', event.delta.thinking)
          }
        }
        continue
      }

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue
          const { summary, detail } = summarize(block.name, (block.input ?? {}) as Record<string, unknown>)
          toolNames.set(block.id, { name: block.name, summary, input: detail })
          ctx.emit.item({ id: block.id, type: 'tool', name: block.name, summary, input: detail || undefined, status: 'running' })
        }
        // Running estimate; the final figure comes from the result message.
        const usage = message.message.usage
        const cost = tokenCost(message.message.model, {
          inputTokens: usage.input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          outputTokens: usage.output_tokens,
        })
        if (cost !== null) {
          costUsd += cost
          ctx.emit.cost(costUsd, true)
        }
        continue
      }

      if (message.type === 'user') {
        const content = message.message.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const known = toolNames.get(block.tool_use_id)
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
        continue
      }

      if (message.type === 'result') {
        costUsd = message.total_cost_usd
        inputTokens =
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0)
        outputTokens = message.usage.output_tokens
        ctx.emit.cost(costUsd, false)
        if (message.subtype !== 'success') {
          error =
            message.subtype === 'error_max_turns'
              ? 'The agent stopped because it reached its turn limit.'
              : 'The agent stopped because of an error.'
        } else if (message.is_error) {
          error = message.result || 'The agent reported an error.'
        }
      }
    }
  } catch (err) {
    if (!ctx.signal.aborted) error ??= err instanceof Error ? err.message : String(err)
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }

  if (ctx.signal.aborted) error ??= 'Stopped.'
  return { costUsd, inputTokens, outputTokens, error, estimated: ctx.signal.aborted }
}
