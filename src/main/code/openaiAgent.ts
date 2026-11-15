// ChatGPT mode coding agent: a tool loop on the OpenAI Responses API.
//
// OpenAI's subscriber API credits do not cover Codex, so this is a plain API
// agent with its own small tool set (read, search, write, edit, run). Reading
// is automatic; anything that changes files or runs a command asks first.

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { tokenCost } from '@shared/pricing'
import { openaiClient, openaiErrorMessage } from '../providers/openai'
import type { AgentContext, AgentResult } from './service'
import { ToolError, editFile, listDir, readFile, runCommand, searchFiles, writeFile } from './tools'

type InputItem = OpenAI.Responses.ResponseInputItem
type FunctionTool = OpenAI.Responses.FunctionTool

const MAX_STEPS = 60

const INSTRUCTIONS = `You are a coding agent working inside the user's project folder on their computer.

How to work:
- Explore before you change anything: list folders, read the relevant files, search for usages.
- Make focused changes with edit_file. Use write_file only for new files or full rewrites.
- After changing code, run the project's own checks (tests, type check, build) with run_command when they exist.
- All paths are relative to the project folder. You cannot read or write outside it.
- Writing files and running commands need the user's approval. If they decline, do not retry the same action; adapt or ask what they want.
- Keep the user informed with short notes on what you are doing, and finish with a brief summary of what changed and what you verified.`

/**
 * Builds a strict function tool. Strict mode wants every property listed as
 * required, so optional ones are declared nullable instead; `_needed` documents
 * which arguments the model must really supply.
 */
function fn(name: string, description: string, properties: Record<string, unknown>, _needed: string[]): FunctionTool {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  }
}

const TOOLS: FunctionTool[] = [
  fn('list_dir', 'List the files and folders in a directory.', { path: { type: 'string', description: 'Folder path, "." for the project root.' } }, ['path']),
  fn(
    'read_file',
    'Read a text file. Returns numbered lines.',
    {
      path: { type: 'string' },
      start_line: { type: ['integer', 'null'], description: 'First line to return (1-based). Null for the start.' },
      end_line: { type: ['integer', 'null'], description: 'Last line to return. Null for the end.' },
    },
    ['path'],
  ),
  fn(
    'search_files',
    'Search file contents with a case-insensitive regular expression.',
    {
      pattern: { type: 'string' },
      path: { type: ['string', 'null'], description: 'Folder to search in. Null for the whole project.' },
    },
    ['pattern'],
  ),
  fn('write_file', 'Create a file or replace its whole content. Needs approval.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn(
    'edit_file',
    'Replace an exact piece of text in a file. Needs approval.',
    {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, with enough context to be unique.' },
      new_string: { type: 'string' },
      replace_all: { type: ['boolean', 'null'], description: 'Replace every occurrence. Null means only one.' },
    },
    ['path', 'old_string', 'new_string'],
  ),
  fn(
    'run_command',
    'Run a shell command in the project folder. Needs approval.',
    {
      command: { type: 'string' },
      timeout_seconds: { type: ['integer', 'null'], description: 'Null for the default of 120 seconds.' },
    },
    ['command'],
  ),
]

const READ_ONLY = new Set(['list_dir', 'read_file', 'search_files'])

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`)
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function describe(name: string, args: Record<string, unknown>): { summary: string; detail: string } {
  const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '')
  switch (name) {
    case 'list_dir':
      return { summary: `List ${text('path') || '.'}`, detail: '' }
    case 'read_file':
      return { summary: `Read ${text('path')}`, detail: '' }
    case 'search_files':
      return { summary: `Search: ${text('pattern')}`, detail: '' }
    case 'write_file':
      return { summary: `Write ${text('path')}`, detail: text('content').slice(0, 6000) }
    case 'edit_file':
      return { summary: `Edit ${text('path')}`, detail: `- ${text('old_string')}\n+ ${text('new_string')}`.slice(0, 6000) }
    case 'run_command':
      return { summary: `Run: ${text('command').split('\n')[0]!.slice(0, 120)}`, detail: text('command') }
    default:
      return { summary: name, detail: '' }
  }
}

async function execute(ctx: AgentContext, name: string, args: Record<string, unknown>): Promise<string> {
  const root = ctx.session.cwd
  switch (name) {
    case 'list_dir':
      return listDir(root, typeof args.path === 'string' ? args.path : '.')
    case 'read_file':
      return readFile(root, str(args, 'path'), optionalNumber(args, 'start_line'), optionalNumber(args, 'end_line'))
    case 'search_files':
      return searchFiles(root, str(args, 'pattern'), typeof args.path === 'string' ? args.path : undefined)
    case 'write_file':
      return writeFile(root, str(args, 'path'), str(args, 'content'))
    case 'edit_file':
      return editFile(root, str(args, 'path'), str(args, 'old_string'), str(args, 'new_string'), args.replace_all === true)
    case 'run_command':
      return runCommand(root, str(args, 'command'), optionalNumber(args, 'timeout_seconds') ?? 120, ctx.signal)
    default:
      throw new ToolError(`Unknown tool "${name}".`)
  }
}

export async function runOpenAIAgent(ctx: AgentContext): Promise<AgentResult> {
  const client = openaiClient(ctx.apiKey)
  const input: InputItem[] = Array.isArray(ctx.session.replay) ? (ctx.session.replay as InputItem[]) : []
  input.push({ role: 'user', content: ctx.prompt })

  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let error: string | undefined
  let useReasoning = true

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let final: OpenAI.Responses.Response | null = null
      let textItem: string | null = null
      let thinkingItem: string | null = null

      try {
        const stream = await client.responses.create(
          {
            model: ctx.session.model,
            instructions: INSTRUCTIONS,
            input,
            tools: TOOLS,
            stream: true,
            store: false,
            prompt_cache_key: ctx.session.id.slice(0, 64),
            ...(useReasoning ? { include: ['reasoning.encrypted_content' as const], reasoning: { summary: 'auto' as const } } : {}),
          },
          { signal: ctx.signal },
        )
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            if (!textItem) {
              textItem = randomUUID()
              ctx.emit.item({ id: textItem, type: 'text', text: '' })
            }
            ctx.emit.delta(textItem, 'text', event.delta)
          } else if (event.type === 'response.reasoning_summary_text.delta') {
            if (!thinkingItem) {
              thinkingItem = randomUUID()
              ctx.emit.item({ id: thinkingItem, type: 'thinking', text: '' })
            }
            ctx.emit.delta(thinkingItem, 'thinking', event.delta)
          } else if (event.type === 'response.output_item.added') {
            if (event.item.type === 'message') textItem = null
            if (event.item.type === 'reasoning') thinkingItem = null
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            final = event.response
          } else if (event.type === 'response.failed') {
            throw new Error(event.response.error?.message ?? 'The request failed.')
          } else if (event.type === 'error') {
            throw new Error(event.message)
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        if (step === 0 && useReasoning && err instanceof OpenAI.BadRequestError) {
          useReasoning = false
          step -= 1
          continue
        }
        throw err
      }

      if (!final) throw new Error('The connection closed before the reply finished.')
      if (final.usage) {
        const cached = final.usage.input_tokens_details?.cached_tokens ?? 0
        const cost = tokenCost(final.model, {
          inputTokens: Math.max(0, final.usage.input_tokens - cached),
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: final.usage.output_tokens,
        })
        costUsd += cost ?? 0
        inputTokens += final.usage.input_tokens
        outputTokens += final.usage.output_tokens
        ctx.emit.cost(costUsd, false)
      }

      input.push(...(final.output as unknown as InputItem[]))
      const calls = final.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
      )
      if (calls.length === 0) break
      if (step === MAX_STEPS - 1) error = 'The agent stopped because it reached its step limit.'

      for (const call of calls) {
        let args: Record<string, unknown> = {}
        let output: string
        let status: 'done' | 'error' | 'denied' = 'done'
        try {
          const parsed: unknown = JSON.parse(call.arguments || '{}')
          if (typeof parsed !== 'object' || parsed === null) throw new ToolError('Arguments must be a JSON object.')
          args = parsed as Record<string, unknown>
          const { summary, detail } = describe(call.name, args)
          ctx.emit.item({ id: call.call_id, type: 'tool', name: call.name, summary, input: detail || undefined, status: 'running' })
          if (!READ_ONLY.has(call.name) && !(await ctx.ask(call.name, summary, detail))) {
            status = 'denied'
            output = 'The user declined this action.'
          } else {
            output = await execute(ctx, call.name, args)
          }
        } catch (err) {
          status = 'error'
          output = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        const { summary, detail } = describe(call.name, args)
        ctx.emit.item({
          id: call.call_id,
          type: 'tool',
          name: call.name,
          summary,
          input: detail || undefined,
          output: output.slice(0, 20_000),
          status,
        })
        input.push({ type: 'function_call_output', call_id: call.call_id, output })
        if (ctx.signal.aborted) throw new Error('aborted')
      }
    }
  } catch (err) {
    error = ctx.signal.aborted ? 'Stopped.' : openaiErrorMessage(err)
  }

  // Keep the transcript for the next prompt, unless a tool call was left unanswered.
  const answered = new Set(
    input.filter((item) => 'type' in item && item.type === 'function_call_output').map((item) => (item as { call_id: string }).call_id),
  )
  const complete = input.every(
    (item) => !('type' in item) || item.type !== 'function_call' || answered.has((item as { call_id: string }).call_id),
  )
  if (complete) ctx.session.replay = input

  return { costUsd, inputTokens, outputTokens, error, estimated: false }
}
