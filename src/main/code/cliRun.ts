// What the two CLI-backed coding engines share: how a run is described, what
// comes back, how the tool's output is read line by line, and how a message
// about a usage limit is recognised.

import { spawn } from 'node:child_process'
import readline from 'node:readline'

export interface CliRun {
  /** The CLI executable. */
  file: string
  /** Environment to run it in, already set up for the way this run is paid. */
  env: NodeJS.ProcessEnv
  /** plan: the CLI's own subscription sign-in. api: the user's API key. */
  auth: 'plan' | 'api'
  prompt: string
  /** Session or thread to continue. */
  resume?: string
}

export interface CliRunResult {
  /** API runs only; a plan run is not billed per token. */
  costUsd: number
  inputTokens: number
  outputTokens: number
  error?: string
  estimated: boolean
  /** Session or thread id, for the next turn. */
  sessionId?: string
  /** Model that answered, when the CLI says. */
  model?: string
  /** What the CLI itself reports paid for the run. */
  billedTo: 'plan' | 'api' | 'unknown'
  /** The plan could not serve this run, so the API key should take over. */
  fallback?: { reason: 'limit' | 'signed-out'; resetsAt?: number; detail: string }
}

/** Words the tools use when a plan's allowance is used up. */
export const LIMIT_TEXT = /usage limit|limit reached|hit your [a-z ]*limit|rate.?limit|out of (extra )?usage|quota/i
/** Words the tools use when nobody is signed in. */
export const SIGNED_OUT_TEXT = /not logged in|not signed in|please run \/login|run `?codex login|login required|authentication_error|authentication failed|oauth token (has )?expired|401 unauthorized/i

/**
 * Reads "try again in 2 hours 14 minutes" or "resets at 3:15 PM" out of a
 * limit message. Returns when that is, or nothing when the text does not say.
 */
export function parseResetTime(text: string, now = Date.now()): number | undefined {
  const relative = text.match(/\bin\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)[\s,]*(?:and\s+)?)+)/i)
  if (relative) {
    let ms = 0
    for (const part of relative[1]!.matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec)/gi)) {
      const amount = Number(part[1])
      const unit = part[2]!.toLowerCase()
      ms += amount * (unit === 'day' ? 86_400_000 : unit === 'hour' || unit === 'hr' ? 3_600_000 : unit.startsWith('min') ? 60_000 : 1000)
    }
    if (ms > 0) return now + ms
  }
  const clock = text.match(/\b(?:at|resets?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (clock) {
    let hour = Number(clock[1]) % 12
    if (clock[3]!.toLowerCase() === 'pm') hour += 12
    const when = new Date(now)
    when.setHours(hour, Number(clock[2] ?? 0), 0, 0)
    if (when.getTime() <= now) when.setDate(when.getDate() + 1)
    return when.getTime()
  }
  return undefined
}

/** A time the tool reported as a number: seconds or milliseconds since 1970. */
export function toMillis(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? value * 1000 : value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface Finished {
  code: number | null
  /** The last part of what the tool wrote to stderr. */
  stderr: string
  /** The run could not even be started. */
  spawnError?: string
}

/**
 * Runs a CLI and hands each line of its output to `onLine`. Stopping asks the
 * tool to end its turn first (an interrupt), and only then ends the process.
 */
export function runLines(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; signal: AbortSignal; /** Written to the tool's stdin, which is then closed. */ input?: string },
  onLine: (line: string) => void,
): Promise<Finished> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stderr: '', spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    }
    let stderr = ''
    let spawnError: string | undefined
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const stop = (): void => {
      child.kill('SIGINT')
      timers.push(setTimeout(() => child.kill('SIGTERM'), 3000), setTimeout(() => child.kill('SIGKILL'), 6000))
    }
    if (options.signal.aborted) stop()
    else options.signal.addEventListener('abort', stop, { once: true })

    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.trim()) onLine(line)
      })
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (error) => {
      spawnError = error.message
    })
    child.on('close', (code) => {
      for (const timer of timers) clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      resolve({ code, stderr: stderr.trim(), spawnError })
    })
  })
}
