// Finding, checking, installing, updating and signing in to the two official
// coding CLIs: Claude Code (Anthropic) and Codex (OpenAI).
//
// Threefold only ever runs these tools exactly as their makers publish them.
// Signing in is the tool's own doing: it opens the maker's page in the browser
// and keeps the credentials itself. Threefold never reads, stores or passes on
// a password or a token, and it never changes how the tool signs in.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliEvent, CliProvider, CliStatus } from '@shared/types'

export interface CliSpec {
  provider: CliProvider
  /** The tool's own name. */
  name: string
  /** Who makes it and bills for it. */
  maker: string
  bin: string
  npmPackage: string
  /** The maker's own install script, which needs nothing but curl. */
  installer: string
  /** Oldest version whose command line Threefold knows how to drive. */
  minVersion: string
  /** Environment variable that names the executable to use instead of looking for one (for tests). */
  override: string
}

export const CLI: Record<CliProvider, CliSpec> = {
  claude: {
    provider: 'claude',
    name: 'Claude Code',
    maker: 'Anthropic',
    bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    installer: 'curl -fsSL https://claude.ai/install.sh | bash',
    minVersion: '2.1.200',
    override: 'THREEFOLD_CLAUDE_CLI',
  },
  chatgpt: {
    provider: 'chatgpt',
    name: 'Codex',
    maker: 'OpenAI',
    bin: 'codex',
    npmPackage: '@openai/codex',
    installer: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    minVersion: '0.120.0',
    override: 'THREEFOLD_CODEX_CLI',
  },
}

// ---------- small pure helpers ----------

export function parseVersion(text: string): string | undefined {
  return text.match(/(\d+)\.(\d+)\.(\d+)/)?.[0]
}

/** Negative when a is older than b, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface Install {
  manager: CliStatus['manager']
  /** Homebrew only: the cask or formula name, and which of the two it is. */
  brew?: { name: string; cask: boolean }
}

/** Works out how a CLI was installed from where its real file lives. */
export function installOf(realPath: string): Install {
  const cask = realPath.match(/\/Caskroom\/([^/]+)\//)
  if (cask) return { manager: 'homebrew', brew: { name: cask[1]!, cask: true } }
  const formula = realPath.match(/\/Cellar\/([^/]+)\//)
  if (formula) return { manager: 'homebrew', brew: { name: formula[1]!, cask: false } }
  if (realPath.includes('/node_modules/')) return { manager: 'npm' }
  if (/\/\.local\/(share|bin)\/|\/\.claude\/|\/\.codex\//.test(realPath)) return { manager: 'native' }
  return { manager: 'unknown' }
}

export interface Command {
  file: string
  args: string[]
  /** The command as a person would type it, shown before it runs. */
  display: string
}

/** The command that installs a missing CLI or updates one that is there. */
export function installCommand(spec: CliSpec, found: { path: string; install: Install } | null): Command {
  if (!found) return { file: '/bin/sh', args: ['-c', spec.installer], display: spec.installer }
  const { install } = found
  if (install.manager === 'homebrew' && install.brew) {
    const args = ['upgrade', ...(install.brew.cask ? ['--cask'] : []), install.brew.name]
    return { file: 'brew', args, display: `brew ${args.join(' ')}` }
  }
  if (install.manager === 'npm') {
    const args = ['install', '-g', `${spec.npmPackage}@latest`]
    return { file: 'npm', args, display: `npm ${args.join(' ')}` }
  }
  // A copy from the maker's own installer updates itself.
  return { file: found.path, args: ['update'], display: `${spec.bin} update` }
}

export interface Account {
  account: CliStatus['account']
  plan?: string
}

/** Reads `claude auth status --json`. */
export function parseClaudeAuth(stdout: string): Account {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown }
    if (status.loggedIn !== true) return { account: 'none' }
    if (status.authMethod !== 'claude.ai') return { account: 'api' }
    const plan = typeof status.subscriptionType === 'string' && status.subscriptionType ? status.subscriptionType : undefined
    return { account: 'subscription', plan: plan ? plan[0]!.toUpperCase() + plan.slice(1) : undefined }
  } catch {
    return { account: 'none' }
  }
}

/** Reads the line `codex login status` prints. */
export function parseCodexAuth(output: string): Account {
  if (/logged in using chatgpt/i.test(output)) return { account: 'subscription' }
  if (/logged in using an? (api key|access token)/i.test(output)) return { account: 'api' }
  return { account: 'none' }
}

/** Removes terminal colour and cursor codes so tool output can be shown as plain text. */
export function plainText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
}

/** Finds an executable by name in a PATH-style list of folders. */
export function which(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

// ---------- running things ----------

interface Captured {
  code: number | null
  stdout: string
  stderr: string
}

function capture(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15_000): Promise<Captured> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export interface CliManagerOptions {
  /** Environment to start from. Defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Folders to search, PATH-style. Defaults to the login shell's PATH plus the usual places. */
  searchPath?: string
  /** Looks up the newest published version of an npm package. */
  latest?: (npmPackage: string) => Promise<string | undefined>
  /** Skip the online version lookup (demo mode makes no network calls). */
  offline?: boolean
}

const HOME = os.homedir()
const USUAL_PLACES = [
  path.join(HOME, '.local/bin'),
  path.join(HOME, '.claude/local'),
  path.join(HOME, '.codex/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.npm-global/bin'),
  path.join(HOME, '.volta/bin'),
  path.join(HOME, '.bun/bin'),
  path.join(HOME, 'Library/pnpm'),
]

async function npmLatest(npmPackage: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, { signal: AbortSignal.timeout(6000) })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? parseVersion(body.version) : undefined
  } catch {
    return undefined
  }
}

export class CliManager {
  private readonly baseEnv: NodeJS.ProcessEnv
  private searchPath: string | null
  private tasks = new Map<CliProvider, { task: 'install' | 'login'; child: ChildProcess }>()
  private limited = new Map<CliProvider, number>()
  private latestCache = new Map<string, { at: number; version: string | undefined }>()
  private helpCache = new Map<string, string>()

  constructor(
    private readonly send: (event: CliEvent) => void,
    private readonly options: CliManagerOptions = {},
  ) {
    this.baseEnv = options.env ?? process.env
    this.searchPath = options.searchPath ?? null
  }

  /**
   * Where to look for tools. An app started from the Finder only gets the
   * system's default PATH, so the login shell is asked for the real one.
   */
  private async pathList(): Promise<string> {
    if (this.searchPath !== null) return this.searchPath
    const shell = this.baseEnv.SHELL || '/bin/zsh'
    const asked = await capture(shell, ['-lc', 'printf "__PATH__%s" "$PATH"'], this.baseEnv, 5000)
    const fromShell = asked.stdout.split('__PATH__')[1]?.trim() ?? ''
    const seen = new Set<string>()
    const dirs = [...(this.baseEnv.PATH ?? '').split(path.delimiter), ...fromShell.split(path.delimiter), ...USUAL_PLACES].filter(
      (dir) => dir && !seen.has(dir) && seen.add(dir),
    )
    this.searchPath = dirs.join(path.delimiter)
    return this.searchPath
  }

  /** Environment for running a CLI: the user's, with a PATH that finds node, brew and friends. */
  async env(changes: Record<string, string | undefined> = {}): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, PATH: await this.pathList() }
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    return env
  }

  async find(provider: CliProvider): Promise<string | null> {
    const spec = CLI[provider]
    const forced = this.baseEnv[spec.override]
    if (forced) return fs.existsSync(forced) ? forced : null
    return which(spec.bin, await this.pathList())
  }

  private async latest(spec: CliSpec): Promise<string | undefined> {
    // Test hook: {"claude":"2.1.325","chatgpt":"0.169.0"}
    const hook = this.baseEnv.THREEFOLD_CLI_LATEST
    if (hook) {
      try {
        const value = (JSON.parse(hook) as Record<string, unknown>)[spec.provider]
        return typeof value === 'string' ? value : undefined
      } catch {
        return undefined
      }
    }
    if (this.options.offline) return undefined
    const cached = this.latestCache.get(spec.npmPackage)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.version
    const version = await (this.options.latest ?? npmLatest)(spec.npmPackage)
    this.latestCache.set(spec.npmPackage, { at: Date.now(), version })
    return version
  }

  private async account(provider: CliProvider, file: string, env: NodeJS.ProcessEnv): Promise<Account> {
    if (provider === 'claude') return parseClaudeAuth((await capture(file, ['auth', 'status', '--json'], env)).stdout)
    const result = await capture(file, ['login', 'status'], env)
    return parseCodexAuth(`${result.stdout}\n${result.stderr}`)
  }

  private async located(provider: CliProvider): Promise<{ path: string; install: Install } | null> {
    const file = await this.find(provider)
    if (!file) return null
    let real = file
    try {
      real = fs.realpathSync(file)
    } catch {
      // Keep the path as found.
    }
    return { path: file, install: installOf(real) }
  }

  async status(provider: CliProvider): Promise<CliStatus> {
    const spec = CLI[provider]
    const limitedUntil = this.limitedUntil(provider)
    const base: CliStatus = {
      provider,
      name: spec.name,
      installed: false,
      outdated: false,
      unsupported: false,
      manager: 'unknown',
      account: 'none',
      installCommand: spec.installer,
      limitedUntil,
    }
    try {
      const [found, latest, env] = await Promise.all([this.located(provider), this.latest(spec), this.env()])
      if (!found) return { ...base, latest }
      const [versionOut, account] = await Promise.all([capture(found.path, ['--version'], env), this.account(provider, found.path, env)])
      const version = parseVersion(`${versionOut.stdout}\n${versionOut.stderr}`)
      if (!version) {
        return { ...base, latest, path: found.path, error: `${spec.name} was found at ${found.path} but did not report a version.` }
      }
      return {
        ...base,
        installed: true,
        path: found.path,
        version,
        latest,
        outdated: latest !== undefined && compareVersions(version, latest) < 0,
        unsupported: compareVersions(version, spec.minVersion) < 0,
        manager: found.install.manager,
        account: account.account,
        plan: account.plan,
        installCommand: installCommand(spec, found).display,
      }
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A CLI's --help text, read once per executable. Used to see which options this version has. */
  async help(file: string): Promise<string> {
    const cached = this.helpCache.get(file)
    if (cached !== undefined) return cached
    const result = await capture(file, ['--help'], await this.env())
    const text = `${result.stdout}\n${result.stderr}`
    this.helpCache.set(file, text)
    return text
  }

  // ---------- plan limits ----------

  /** Remembers that the plan's usage limit is reached, so the next runs go straight to the API key. */
  noteLimit(provider: CliProvider, until: number): void {
    this.limited.set(provider, until)
  }

  clearLimit(provider: CliProvider): void {
    this.limited.delete(provider)
  }

  limitedUntil(provider: CliProvider, now = Date.now()): number | undefined {
    const until = this.limited.get(provider)
    if (until === undefined) return undefined
    if (until <= now) {
      this.limited.delete(provider)
      return undefined
    }
    return until
  }

  // ---------- install, update, sign in ----------

  private run(
    provider: CliProvider,
    task: 'install' | 'login',
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    input: boolean,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(file, args, { env, cwd: HOME, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
      } catch (error) {
        this.send({ type: 'output', provider, task, text: `${error instanceof Error ? error.message : String(error)}\n` })
        resolve(null)
        return
      }
      this.tasks.set(provider, { task, child })
      const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
      const forward = (chunk: Buffer): void => {
        const text = plainText(chunk.toString('utf8'))
        if (text) this.send({ type: 'output', provider, task, text })
      }
      child.stdout?.on('data', forward)
      child.stderr?.on('data', forward)
      child.on('error', (error) => {
        this.send({ type: 'output', provider, task, text: `${error.message}\n` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (this.tasks.get(provider)?.child === child) this.tasks.delete(provider)
        resolve(code)
      })
    })
  }

  private finish(provider: CliProvider, task: 'install' | 'login', error?: string): { ok: boolean; error?: string } {
    this.send({ type: 'done', provider, task, ok: !error, error })
    return error ? { ok: false, error } : { ok: true }
  }

  /** Installs the CLI with its maker's installer, or updates the copy that is already there. */
  async install(provider: CliProvider): Promise<{ ok: boolean; error?: string }> {
    const spec = CLI[provider]
    if (this.tasks.has(provider)) return { ok: false, error: `${spec.name} is already being set up.` }
    const [found, env] = await Promise.all([this.located(provider), this.env()])
    const command = installCommand(spec, found)
    const before = found ? parseVersion((await capture(found.path, ['--version'], env)).stdout) : undefined
    // brew and npm live wherever the user installed them.
    const file = path.isAbsolute(command.file) ? command.file : which(command.file, env.PATH ?? '')
    if (!file) {
      return this.finish(provider, 'install', `"${command.file}" was not found on this computer. Run this in Terminal instead: ${command.display}`)
    }
    this.send({ type: 'output', provider, task: 'install', text: `$ ${command.display}\n` })
    const code = await this.run(provider, 'install', file, command.args, env, false)

    this.helpCache.clear()
    // Judge by what is there now, not by the exit code alone.
    const after = await this.located(provider)
    const version = after ? parseVersion((await capture(after.path, ['--version'], env)).stdout) : undefined
    if (!version) {
      return this.finish(provider, 'install', `${spec.name} is still not installed. Run this in Terminal to see why: ${command.display}`)
    }
    if (code !== 0 && version === before) {
      return this.finish(provider, 'install', `The update did not go through (exit code ${code ?? 'none'}). Run this in Terminal to see why: ${command.display}`)
    }
    return this.finish(provider, 'install')
  }

  /**
   * Starts the CLI's own sign-in. It opens the maker's sign-in page in the
   * browser and stores the result itself; all Threefold does is start it, show
   * what it prints, and pass along a line the user types (a code the browser
   * showed). It runs inside a pseudo-terminal because both tools expect one.
   */
  async login(provider: CliProvider): Promise<{ ok: boolean; error?: string }> {
    const spec = CLI[provider]
    if (this.tasks.has(provider)) return { ok: false, error: `${spec.name} is already being set up.` }
    const [file, env] = await Promise.all([this.find(provider), this.env()])
    if (!file) return this.finish(provider, 'login', `${spec.name} is not installed yet.`)
    const args = provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login']
    // `script` provides the pseudo-terminal. It cannot take its input straight from this
    // process (Node's pipes are sockets, which it rejects), so `cat` passes the input along
    // through a real pipe, and keeps it open without ever ending it.
    const pty = 'exec /usr/bin/script -q /dev/null "$0" "$@" < <(cat 2>/dev/null)'
    const usePty = process.platform === 'darwin' && fs.existsSync('/usr/bin/script') && fs.existsSync('/bin/bash')
    await (usePty
      ? this.run(provider, 'login', '/bin/bash', ['-c', pty, file, ...args], env, true)
      : this.run(provider, 'login', file, args, env, true))
    const account = await this.account(provider, file, env)
    if (account.account === 'none') {
      return this.finish(provider, 'login', `${spec.name} is still not signed in. If the browser did not open, run "${spec.bin} ${args.join(' ')}" in Terminal.`)
    }
    return this.finish(provider, 'login')
  }

  loginInput(provider: CliProvider, text: string): void {
    const running = this.tasks.get(provider)
    if (running?.task === 'login') running.child.stdin?.write(`${text.trim()}\n`)
  }

  cancel(provider: CliProvider): void {
    this.tasks.get(provider)?.child.kill('SIGTERM')
  }

  cancelAll(): void {
    for (const { child } of this.tasks.values()) child.kill('SIGTERM')
  }
}
