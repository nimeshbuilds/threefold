// File and shell tools for the ChatGPT-mode coding agent.
//
// Every path the model supplies is untrusted: it is resolved against the
// project folder and rejected if it lands outside it (including through a
// symlink). Writes and commands additionally need the user's approval, which
// the caller handles before invoking these functions.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target'])
const MAX_READ_CHARS = 60_000
const MAX_OUTPUT_CHARS = 30_000
const MAX_SEARCH_HITS = 200
const MAX_SEARCH_FILE_BYTES = 1_000_000

export class ToolError extends Error {}

/** Resolves a model-supplied path inside `root`, or throws. */
export function resolveInside(root: string, candidate: string): string {
  const realRoot = fs.realpathSync(root)
  const target = path.resolve(realRoot, candidate || '.')
  // Check the deepest part of the path that exists, so a symlink cannot lead outside.
  let existing = target
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  const realExisting = fs.realpathSync(existing)
  const relative = path.relative(realRoot, realExisting)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new ToolError(`"${candidate}" is outside the project folder.`)
  }
  const lexical = path.relative(realRoot, target)
  if (lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) {
    throw new ToolError(`"${candidate}" is outside the project folder.`)
  }
  return target
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters not shown)` : text
}

export async function listDir(root: string, dir: string): Promise<string> {
  const target = resolveInside(root, dir)
  const entries = await fsp.readdir(target, { withFileTypes: true })
  const lines = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 400)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  return lines.length > 0 ? lines.join('\n') : '(empty folder)'
}

export async function readFile(root: string, file: string, startLine?: number, endLine?: number): Promise<string> {
  const target = resolveInside(root, file)
  const stat = await fsp.stat(target)
  if (stat.isDirectory()) throw new ToolError(`"${file}" is a folder. Use list_dir.`)
  const data = await fsp.readFile(target)
  if (data.subarray(0, 8000).includes(0)) throw new ToolError(`"${file}" is a binary file.`)
  const lines = data.toString('utf8').split('\n')
  const from = Math.max(1, Math.floor(startLine ?? 1))
  const to = Math.min(lines.length, Math.floor(endLine ?? lines.length))
  const numbered = lines
    .slice(from - 1, to)
    .map((line, index) => `${String(from + index).padStart(5)}  ${line}`)
    .join('\n')
  return clip(numbered, MAX_READ_CHARS)
}

export async function searchFiles(root: string, pattern: string, dir?: string): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'i')
  } catch {
    throw new ToolError(`"${pattern}" is not a valid regular expression.`)
  }
  const realRoot = fs.realpathSync(root)
  const start = resolveInside(root, dir ?? '.')
  const hits: string[] = []
  const walk = async (current: string): Promise<void> => {
    if (hits.length >= MAX_SEARCH_HITS) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full)
        continue
      }
      try {
        const stat = await fsp.stat(full)
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue
        const data = await fsp.readFile(full)
        if (data.subarray(0, 4000).includes(0)) continue
        const lines = data.toString('utf8').split('\n')
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (regex.test(lines[i]!)) {
            hits.push(`${path.relative(realRoot, full)}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`)
          }
        }
      } catch {
        // Unreadable file: skip it.
      }
    }
  }
  await walk(start)
  if (hits.length === 0) return 'No matches.'
  return hits.join('\n') + (hits.length >= MAX_SEARCH_HITS ? '\n… (more matches not shown)' : '')
}

export async function writeFile(root: string, file: string, content: string): Promise<string> {
  const target = resolveInside(root, file)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, content)
  return `Wrote ${content.length} characters to ${file}.`
}

export async function editFile(
  root: string,
  file: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<string> {
  const target = resolveInside(root, file)
  const original = await fsp.readFile(target, 'utf8')
  if (!oldString) throw new ToolError('old_string must not be empty.')
  const count = original.split(oldString).length - 1
  if (count === 0) throw new ToolError(`old_string was not found in ${file}. Read the file and copy the exact text.`)
  if (count > 1 && !replaceAll) {
    throw new ToolError(`old_string appears ${count} times in ${file}. Add more context, or set replace_all.`)
  }
  const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, () => newString)
  await fsp.writeFile(target, updated)
  return `Edited ${file} (${replaceAll ? count : 1} replacement${replaceAll && count !== 1 ? 's' : ''}).`
}

export function runCommand(root: string, command: string, timeoutSeconds: number, signal: AbortSignal): Promise<string> {
  const timeoutMs = Math.min(Math.max(timeoutSeconds || 120, 1), 600) * 1000
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd: fs.realpathSync(root), env: process.env })
    let output = ''
    let finished = false
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const finish = (suffix: string): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(`${clip(output.trim(), MAX_OUTPUT_CHARS)}\n${suffix}`.trim())
    }
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish('[stopped by the user]')
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(`[timed out after ${timeoutMs / 1000}s]`)
    }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => finish(`[could not start: ${error.message}]`))
    child.on('close', (code) => finish(`[exit code ${code ?? 'unknown'}]`))
  })
}
