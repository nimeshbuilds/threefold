// Tool set shared by the coding agents that Threefold runs itself (ChatGPT
// mode and Gemini mode). Claude mode uses the Claude Agent SDK's own tools.

import type { AgentContext } from './service'
import { ToolError, editFile, listDir, readFile, runCommand, searchFiles, writeFile } from './tools'

export const MAX_STEPS = 60

export const INSTRUCTIONS = `You are a coding agent working inside the user's project folder on their computer.

How to work:
- Explore before you change anything: list folders, read the relevant files, search for usages.
- Make focused changes with edit_file. Use write_file only for new files or full rewrites.
- After changing code, run the project's own checks (tests, type check, build) with run_command when they exist.
- All paths are relative to the project folder. You cannot read or write outside it.
- Writing files and running commands need the user's approval. If they decline, do not retry the same action; adapt or ask what they want.
- Keep the user informed with short notes on what you are doing, and finish with a brief summary of what changed and what you verified.`

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema properties. Optional arguments are declared nullable. */
  properties: Record<string, { type: string | string[]; description?: string }>
  /** Arguments the model must really supply. */
  needed: string[]
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_dir',
    description: 'List the files and folders in a directory.',
    properties: { path: { type: 'string', description: 'Folder path, "." for the project root.' } },
    needed: ['path'],
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines.',
    properties: {
      path: { type: 'string' },
      start_line: { type: ['integer', 'null'], description: 'First line to return (1-based). Null for the start.' },
      end_line: { type: ['integer', 'null'], description: 'Last line to return. Null for the end.' },
    },
    needed: ['path'],
  },
  {
    name: 'search_files',
    description: 'Search file contents with a case-insensitive regular expression.',
    properties: {
      pattern: { type: 'string' },
      path: { type: ['string', 'null'], description: 'Folder to search in. Null for the whole project.' },
    },
    needed: ['pattern'],
  },
  {
    name: 'write_file',
    description: 'Create a file or replace its whole content. Needs approval.',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    needed: ['path', 'content'],
  },
  {
    name: 'edit_file',
    description: 'Replace an exact piece of text in a file. Needs approval.',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, with enough context to be unique.' },
      new_string: { type: 'string' },
      replace_all: { type: ['boolean', 'null'], description: 'Replace every occurrence. Null means only one.' },
    },
    needed: ['path', 'old_string', 'new_string'],
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the project folder. Needs approval.',
    properties: {
      command: { type: 'string' },
      timeout_seconds: { type: ['integer', 'null'], description: 'Null for the default of 120 seconds.' },
    },
    needed: ['command'],
  },
]

export const READ_ONLY = new Set(['list_dir', 'read_file', 'search_files'])

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`)
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function describeCall(name: string, args: Record<string, unknown>): { summary: string; detail: string } {
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

export async function executeCall(ctx: AgentContext, name: string, args: Record<string, unknown>): Promise<string> {
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

/**
 * Runs one tool call for an agent: shows it, asks for approval when it changes
 * something, executes it and reports the outcome. Never throws.
 */
export async function runToolCall(
  ctx: AgentContext,
  id: string,
  name: string,
  rawArgs: unknown,
): Promise<{ output: string; status: 'done' | 'error' | 'denied' }> {
  let args: Record<string, unknown> = {}
  let output: string
  let status: 'done' | 'error' | 'denied' = 'done'
  try {
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
      throw new ToolError('Arguments must be a JSON object.')
    }
    args = rawArgs as Record<string, unknown>
    const { summary, detail } = describeCall(name, args)
    ctx.emit.item({ id, type: 'tool', name, summary, input: detail || undefined, status: 'running' })
    if (!READ_ONLY.has(name) && !(await ctx.ask(name, summary, detail))) {
      status = 'denied'
      output = 'The user declined this action.'
    } else {
      output = await executeCall(ctx, name, args)
    }
  } catch (err) {
    status = 'error'
    output = `Error: ${err instanceof Error ? err.message : String(err)}`
  }
  const { summary, detail } = describeCall(name, args)
  ctx.emit.item({ id, type: 'tool', name, summary, input: detail || undefined, output: output.slice(0, 20_000), status })
  return { output, status }
}
