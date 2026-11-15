// Subscription mode in the Code tab: finding and updating the official CLIs,
// signing in, running a session on the plan, and falling back to the API key.
// Stand-ins play Claude Code and Codex, so no account and no network is used.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliEvent, CodeEvent, CodeItem, LedgerEntry, PermissionDecision, Provider } from '@shared/types'
import { formatUsd, modelLabel, tokenCost } from '@shared/pricing'
import {
  CLI,
  CliManager,
  compareVersions,
  installCommand,
  installOf,
  runnableInstall,
  parseClaudeAuth,
  parseCodexAuth,
  parseVersion,
  plainText,
  which,
} from '../src/main/code/cli'
import { inside, projectRoots, summarize } from '../src/main/code/claudeAgent'
import { claudeArgs, claudePermissionMode } from '../src/main/code/claudeCli'
import { LIMIT_TEXT, SIGNED_OUT_TEXT, parseResetTime, toMillis } from '../src/main/code/cliRun'
import { CODEX_SANDBOX_NOTE, codexArgs, shownCommand } from '../src/main/code/codexCli'
import { PERMISSION_TOOL, PermissionBridge } from '../src/main/code/permissionBridge'
import { CodeService } from '../src/main/code/service'
import { Store } from '../src/main/store'

const root = path.resolve(__dirname, '..')

// ---------- small things ----------

describe('reading what the tools say about themselves', () => {
  it('finds a version in each tool’s own format and compares versions', () => {
    expect(parseVersion('2.1.281 (Claude Code)')).toBe('2.1.281')
    expect(parseVersion('codex-cli 0.156.1')).toBe('0.156.1')
    expect(parseVersion('command not found')).toBeUndefined()
    expect(compareVersions('2.1.281', '2.1.325')).toBeLessThan(0)
    expect(compareVersions('0.169.0', '0.156.1')).toBeGreaterThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('tells a plan sign-in from an API sign-in and from none', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')).toEqual({ account: 'subscription', plan: 'Max' })
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"console"}')).toEqual({ account: 'api' })
    expect(parseClaudeAuth('{"loggedIn":false}')).toEqual({ account: 'none' })
    expect(parseClaudeAuth('not json')).toEqual({ account: 'none' })
    expect(parseCodexAuth('Logged in using ChatGPT\n')).toEqual({ account: 'subscription' })
    expect(parseCodexAuth('Logged in using an API key - sk-***')).toEqual({ account: 'api' })
    expect(parseCodexAuth('Not logged in')).toEqual({ account: 'none' })
  })

  it('works out how a tool was installed and which command updates it', () => {
    const cask = installOf('/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude')
    expect(cask).toEqual({ manager: 'homebrew', brew: { name: 'claude-code@latest', cask: true } })
    expect(installCommand(CLI.claude, { path: '/opt/homebrew/bin/claude', install: cask }).display).toBe('brew upgrade --cask claude-code@latest')
    expect(installOf('/opt/homebrew/Cellar/codex/0.1.0/bin/codex')).toEqual({ manager: 'homebrew', brew: { name: 'codex', cask: false } })

    const npm = installOf('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')
    expect(npm.manager).toBe('npm')
    expect(installCommand(CLI.chatgpt, { path: '/opt/homebrew/bin/codex', install: npm }).display).toBe('npm install -g @openai/codex@latest')

    const native = installOf('/Users/sam/.local/share/claude/versions/2.1.325')
    expect(native.manager).toBe('native')
    expect(installCommand(CLI.claude, { path: '/Users/sam/.local/bin/claude', install: native })).toMatchObject({ args: ['update'], display: 'claude update' })
    expect(installCommand(CLI.chatgpt, { path: '/somewhere/codex', install: installOf('/somewhere/codex') }).display).toBe('codex update')
  })

  it('installs a missing tool with its maker’s own installer', () => {
    expect(installCommand(CLI.claude, null)).toEqual({ file: '/bin/sh', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], display: 'curl -fsSL https://claude.ai/install.sh | bash' })
    expect(installCommand(CLI.chatgpt, null).display).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
  })

  it('never leaves an update to the Terminal: without Homebrew or npm it uses the maker’s installer', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-bin-'))
    fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\n', { mode: 0o755 })
    const cask = { path: '/opt/homebrew/bin/claude', install: installOf('/opt/homebrew/Caskroom/claude-code/2.1.0/claude') }
    // Homebrew is there: its full path is used.
    expect(runnableInstall(CLI.claude, cask, bin)).toMatchObject({ file: path.join(bin, 'brew'), display: 'brew upgrade --cask claude-code' })
    // Homebrew cannot be found: fall back to Anthropic's own installer instead of giving up.
    expect(runnableInstall(CLI.claude, cask, '/nonexistent')).toEqual(installCommand(CLI.claude, null))
    const npm = { path: '/usr/local/bin/codex', install: installOf('/usr/local/lib/node_modules/@openai/codex/bin/codex.js') }
    expect(runnableInstall(CLI.chatgpt, npm, '/nonexistent').display).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
    // The tool's own updater needs no lookup.
    const native = { path: '/Users/sam/.local/bin/claude', install: installOf('/Users/sam/.local/share/claude/versions/2.1.325') }
    expect(runnableInstall(CLI.claude, native, '/nonexistent')).toMatchObject({ file: '/Users/sam/.local/bin/claude', args: ['update'] })
    fs.rmSync(bin, { recursive: true, force: true })
  })

  it('strips terminal colour codes from tool output', () => {
    expect(plainText('\u001b[32mUpdate complete.\u001b[0m\r\n')).toBe('Update complete.\n')
    expect(plainText('\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007 \u001b[2K\u001b[1Gdone')).toBe('link done')
  })

  it('finds an executable in a list of folders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-which-'))
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'notes'), 'text', { mode: 0o644 })
    expect(which('tool', `/nonexistent${path.delimiter}${dir}`)).toBe(path.join(dir, 'tool'))
    expect(which('notes', dir)).toBeNull()
    expect(which('missing', dir)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads when a limit resets, and recognises limit and sign-in messages', () => {
    const now = new Date('2026-11-15T10:00:00').getTime()
    expect(parseResetTime("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 14 minutes.", now)).toBe(now + (2 * 60 + 14) * 60_000)
    expect(parseResetTime('try again in 45 minutes', now)).toBe(now + 45 * 60_000)
    expect(parseResetTime('Claude usage limit reached. Your limit will reset at 3pm.', now)).toBe(new Date('2026-11-15T15:00:00').getTime())
    expect(parseResetTime('resets at 9:30 am', now)).toBe(new Date('2026-11-16T09:30:00').getTime())
    expect(parseResetTime('Something else went wrong', now)).toBeUndefined()
    expect(toMillis(1_800_000_000)).toBe(1_800_000_000_000)
    expect(toMillis(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(toMillis('soon')).toBeUndefined()
    expect(LIMIT_TEXT.test('Claude usage limit reached')).toBe(true)
    expect(LIMIT_TEXT.test("You've hit your usage limit")).toBe(true)
    expect(LIMIT_TEXT.test('File not found')).toBe(false)
    expect(SIGNED_OUT_TEXT.test('Not logged in · Please run /login')).toBe(true)
    expect(SIGNED_OUT_TEXT.test('Not logged in. Run `codex login` to sign in.')).toBe(true)
    // What Claude Code 2.1.281 really printed when its saved sign-in had run out.
    expect(SIGNED_OUT_TEXT.test('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
  })

  it('names a model the way Claude Code reports it on a plan', () => {
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Claude Opus 5.5')
    expect(tokenCost('claude-opus-5-5[1m]', { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 })).toBe(
      tokenCost('claude-opus-5-5', { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }),
    )
  })

  it('shows a file by its place in the project, not its full path on the disk', () => {
    const roots = ['/var/folders/x/project', '/private/var/folders/x/project']
    // The real Claude Code reported the second spelling of the folder.
    expect(inside('/private/var/folders/x/project/src/notes.txt', roots)).toBe('src/notes.txt')
    expect(inside('/var/folders/x/project/notes.txt', roots)).toBe('notes.txt')
    expect(inside('/private/var/folders/x/project', roots)).toBe('.')
    // A file outside the project keeps its full path, so it is plain that it is outside.
    expect(inside('/etc/hosts', roots)).toBe('/etc/hosts')
    expect(inside('/var/folders/x/project-other/a.txt', roots)).toBe('/var/folders/x/project-other/a.txt')
    expect(summarize('Edit', { file_path: '/private/var/folders/x/project/notes.txt', old_string: 'draft', new_string: 'final' }, roots)).toEqual({
      summary: 'Edit notes.txt',
      detail: '- draft\n+ final',
    })
    expect(summarize('Read', { file_path: '/etc/hosts' }, roots).summary).toBe('Read /etc/hosts')
    expect(summarize('Write', { file_path: 'relative.txt', content: 'x' }).summary).toBe('Write relative.txt')
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-roots-'))
    expect(projectRoots(here)).toContain(fs.realpathSync(here))
    expect(projectRoots('/no/such/folder')).toEqual(['/no/such/folder'])
    fs.rmSync(here, { recursive: true, force: true })
  })

  it('shows the command Codex ran, without the login shell it was wrapped in', () => {
    // The shape the real Codex 0.156.1 reported.
    expect(shownCommand('/bin/zsh -lc "python3 - <<\'PY\'\nprint(\\"hi\\")\nPY"')).toBe('python3 - <<\'PY\'\nprint("hi")\nPY')
    expect(shownCommand("bash -lc 'ls -la'")).toBe('ls -la')
    expect(shownCommand('sh -c "echo \\$HOME"')).toBe('echo $HOME')
    expect(shownCommand('git status')).toBe('git status')
  })

  it('builds the command lines the tools document', () => {
    expect(claudePermissionMode('(choices: "acceptEdits", "manual", "plan")')).toBe('manual')
    expect(claudePermissionMode('(choices: "acceptEdits", "default", "plan")')).toBe('default')
    const claude = claudeArgs({ mcpConfig: '{}', permissionMode: 'manual', resume: 'abc', model: 'claude-opus-5-5' })
    // The prompt is not on the command line at all: it goes in on stdin.
    expect(claude).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--setting-sources', 'project', '--permission-mode', 'manual', '--permission-prompt-tool', PERMISSION_TOOL,
      '--mcp-config', '{}', '--resume', 'abc', '--model', 'claude-opus-5-5',
    ])
    // Claude Code never runs in bare mode here: bare mode cannot use a plan sign-in.
    expect(claude).not.toContain('--bare')
    expect(codexArgs({ prompt: '--fix it' })).toEqual(['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', '--', '--fix it'])
    expect(codexArgs({ prompt: 'go on', resume: 't1', model: 'gpt-6.1-sol' })).toEqual([
      'exec', 'resume', 't1', '--json', '-c', 'sandbox_mode="workspace-write"', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '--', 'go on',
    ])
  })
})

// ---------- stand-in CLIs ----------

interface FakeState {
  version: string
  latest: string
  loggedIn: boolean
  plan: string
  limit: boolean
  calls: Array<Record<string, unknown>>
}

let dir: string
let statePath: string
let env: NodeJS.ProcessEnv

function fake(kind: 'claude' | 'codex'): FakeState {
  return (JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, FakeState>)[kind]!
}
function setFake(kind: 'claude' | 'codex', patch: Partial<FakeState>): void {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, FakeState>
  Object.assign(state[kind]!, patch)
  fs.writeFileSync(statePath, JSON.stringify(state))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-cli-'))
  statePath = path.join(dir, 'state.json')
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      claude: { version: '2.1.281', latest: '2.1.325', loggedIn: true, plan: 'max', limit: false, calls: [] },
      codex: { version: '0.156.1', latest: '0.169.0', loggedIn: true, plan: 'pro', limit: false, calls: [] },
    }),
  )
  for (const kind of ['claude', 'codex']) {
    const script = `#!/bin/sh\nFAKE_CLI_KIND=${kind} exec "${process.execPath}" "${path.join(root, 'tests/fixtures/fake-cli.mjs')}" "$@"\n`
    fs.writeFileSync(path.join(dir, kind), script, { mode: 0o755 })
  }
  env = {
    ...process.env,
    THREEFOLD_CLAUDE_CLI: path.join(dir, 'claude'),
    THREEFOLD_CODEX_CLI: path.join(dir, 'codex'),
    THREEFOLD_CLI_LATEST: JSON.stringify({ claude: '2.1.325', chatgpt: '0.169.0' }),
    FAKE_CLI_STATE: statePath,
    // A key that happens to be in the environment must never leak into a plan run.
    ANTHROPIC_API_KEY: 'sk-from-the-shell',
    OPENAI_API_KEY: 'sk-from-the-shell',
  }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function manager(): { cli: CliManager; events: CliEvent[] } {
  const events: CliEvent[] = []
  return { cli: new CliManager((event) => events.push(event), { env, searchPath: process.env.PATH ?? '' }), events }
}

describe('checking, updating and signing in to a CLI', () => {
  it('reports what is installed, whether it is current and how it is signed in', async () => {
    const { cli } = manager()
    expect(await cli.status('claude')).toMatchObject({
      name: 'Claude Code', installed: true, version: '2.1.281', latest: '2.1.325', outdated: true, unsupported: false,
      account: 'subscription', plan: 'Max', installCommand: 'claude update',
    })
    expect(await cli.status('chatgpt')).toMatchObject({ name: 'Codex', installed: true, version: '0.156.1', latest: '0.169.0', outdated: true, account: 'subscription' })
  })

  it('says so when a CLI is missing, too old, or signed out', async () => {
    setFake('codex', { loggedIn: false, version: '0.50.0' })
    const { cli } = manager()
    expect(await cli.status('chatgpt')).toMatchObject({ installed: true, unsupported: true, account: 'none' })
    fs.rmSync(path.join(dir, 'claude'))
    expect(await cli.status('claude')).toMatchObject({ installed: false, account: 'none', installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', latest: '2.1.325' })
  })

  it('updates a CLI with its own updater and shows what it printed', async () => {
    const { cli, events } = manager()
    expect(await cli.install('claude')).toEqual({ ok: true })
    expect(await cli.status('claude')).toMatchObject({ version: '2.1.325', outdated: false })
    const output = events.flatMap((e) => (e.type === 'output' ? [e.text] : [])).join('')
    expect(output).toContain('$ claude update')
    expect(output).toContain('Updating Claude Code from 2.1.281 to 2.1.325')
    // Colour codes are gone.
    expect(output).toContain('Update complete.')
    expect(output).not.toContain('\u001b')
    expect(events.at(-1)).toEqual({ type: 'done', provider: 'claude', task: 'install', ok: true, error: undefined })
  })

  it('signs in through the CLI’s own command and never sees a credential', async () => {
    setFake('codex', { loggedIn: false })
    const { cli, events } = manager()
    expect((await cli.status('chatgpt')).account).toBe('none')
    expect(await cli.login('chatgpt')).toEqual({ ok: true })
    expect((await cli.status('chatgpt')).account).toBe('subscription')
    const output = events.flatMap((e) => (e.type === 'output' ? [e.text] : [])).join('')
    // The link the tool printed is passed on, in case the browser did not open.
    expect(output).toContain('https://auth.openai.com/oauth/authorize?demo=1')
    expect(events.at(-1)).toMatchObject({ type: 'done', task: 'login', ok: true })
  })

  it('signs in to Claude Code with its subscription sign-in command', async () => {
    setFake('claude', { loggedIn: false })
    const { cli, events } = manager()
    expect(await cli.login('claude')).toEqual({ ok: true })
    expect(await cli.status('claude')).toMatchObject({ account: 'subscription', plan: 'Max' })
    expect(events.flatMap((e) => (e.type === 'output' ? [e.text] : [])).join('')).toContain('Login successful.')
  })

  it('treats a sign-in that was cancelled as stopped, not as a failure', async () => {
    setFake('codex', { loggedIn: false })
    const { cli, events } = manager()
    const pending = cli.login('chatgpt')
    await new Promise((resolve) => setTimeout(resolve, 60))
    cli.cancel('chatgpt')
    expect(await pending).toEqual({ ok: false })
    expect(events.at(-1)).toEqual({ type: 'done', provider: 'chatgpt', task: 'login', ok: false, error: undefined })
    expect(fake('codex').loggedIn).toBe(false)
  })

  it('remembers a plan limit until it resets', () => {
    const { cli } = manager()
    const now = Date.now()
    cli.noteLimit('claude', now + 60_000)
    expect(cli.limitedUntil('claude', now)).toBe(now + 60_000)
    expect(cli.limitedUntil('chatgpt', now)).toBeUndefined()
    expect(cli.limitedUntil('claude', now + 61_000)).toBeUndefined()
  })

  it('gives a CLI a PATH that reaches the usual install folders, and only the changes asked for', async () => {
    const { cli } = manager()
    const plain = await cli.env()
    expect(plain.PATH).toBe(process.env.PATH)
    const changed = await cli.env({ ANTHROPIC_API_KEY: undefined, CODEX_API_KEY: 'k' })
    expect(changed.ANTHROPIC_API_KEY).toBeUndefined()
    expect(changed.CODEX_API_KEY).toBe('k')
    expect(changed.OPENAI_API_KEY).toBe('sk-from-the-shell')
  })
})

// ---------- the channel Claude Code uses to ask permission ----------

describe('the permission bridge', () => {
  /** Plays Claude Code: starts the MCP server from the config and calls its tool. */
  function callTool(mcpConfig: string, args: Record<string, unknown>, change: (envs: Record<string, string>) => void = () => {}): Promise<{ tools: string[]; answer: Record<string, unknown> }> {
    const server = (JSON.parse(mcpConfig) as { mcpServers: { threefold: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.threefold
    const serverEnv = { ...server.env }
    change(serverEnv)
    return new Promise((resolve, reject) => {
      const child = spawn(server.command, server.args, { env: { ...process.env, ...serverEnv }, stdio: ['pipe', 'pipe', 'inherit'] })
      const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`)
      let tools: string[] = []
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line) as { id: number; result: Record<string, unknown> }
        if (message.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        if (message.id === 2) {
          tools = (message.result.tools as Array<{ name: string }>).map((tool) => tool.name)
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: args } })
        }
        if (message.id === 3) {
          child.kill()
          resolve({ tools, answer: JSON.parse((message.result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown> })
        }
      })
      child.on('error', reject)
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
    })
  }

  it('passes each question to the app and the answer back', async () => {
    const bridge = new PermissionBridge(dir, process.execPath)
    const asked: Array<[string, Record<string, unknown>]> = []
    const session = await bridge.open(async (tool, input) => {
      asked.push([tool, input])
      return tool !== 'Bash'
    })
    const edit = { file_path: 'a.txt', old_string: 'x', new_string: 'y' }
    const allowed = await callTool(session.mcpConfig, { tool_name: 'Edit', input: edit, tool_use_id: 't1' })
    expect(allowed.tools).toEqual(['approve'])
    // An allowed call gets its input handed back unchanged, which is what Claude Code expects.
    expect(allowed.answer).toEqual({ behavior: 'allow', updatedInput: edit })
    const denied = await callTool(session.mcpConfig, { tool_name: 'Bash', input: { command: 'rm -rf /' } })
    expect(denied.answer).toEqual({ behavior: 'deny', message: 'The user declined this action.' })
    expect(asked).toEqual([['Edit', edit], ['Bash', { command: 'rm -rf /' }]])
    expect(PERMISSION_TOOL).toBe('mcp__threefold__approve')
    bridge.stop()
  })

  it('refuses a caller with the wrong token, and every caller once the run is over', async () => {
    const bridge = new PermissionBridge(dir, process.execPath)
    let asked = 0
    const session = await bridge.open(async () => {
      asked += 1
      return true
    })
    const forged = await callTool(session.mcpConfig, { tool_name: 'Edit', input: {} }, (envs) => {
      envs.THREEFOLD_BRIDGE_TOKEN = 'guess'
    })
    expect(forged.answer.behavior).toBe('deny')
    session.close()
    const late = await callTool(session.mcpConfig, { tool_name: 'Edit', input: {} })
    expect(late.answer).toEqual({ behavior: 'deny', message: 'This run is no longer active.' })
    expect(asked).toBe(0)
    bridge.stop()
    // With the app gone, the answer is still a clear no.
    const gone = await callTool(session.mcpConfig, { tool_name: 'Edit', input: {} })
    expect(gone.answer.behavior).toBe('deny')
  })
})

// ---------- whole sessions ----------

function harness(options: { keys?: Partial<Record<Provider, string>>; decide?: PermissionDecision } = {}) {
  const store = new Store(path.join(dir, 'data'))
  const events: CodeEvent[] = []
  const waiters: Array<() => void> = []
  const cli = new CliManager(() => {}, { env, searchPath: process.env.PATH ?? '' })
  const bridge = new PermissionBridge(dir, process.execPath)
  const keys = options.keys ?? { claude: 'sk-ant-real', chatgpt: 'sk-openai-real' }
  const asked: string[] = []
  const service: CodeService = new CodeService(
    store,
    { get: (provider) => keys[provider] ?? null },
    (event) => {
      events.push(event)
      if (event.type === 'permission') {
        asked.push(event.request.summary)
        service.respond(event.request.requestId, options.decide ?? 'allow')
      }
      for (const waiter of waiters.splice(0)) waiter()
    },
    () => {},
    { cli, bridge },
  )
  /** Sends a prompt and waits for the turn to finish. Returns the transcript items added by it. */
  const turn = async (sessionId: string, prompt: string, again = false): Promise<CodeItem[]> => {
    const before = again ? 0 : (service.get(sessionId)?.items.length ?? 0)
    const seen = events.length
    expect(service.start(sessionId, prompt, undefined, again)).toEqual({ ok: true })
    for (;;) {
      if (events.slice(seen).some((event) => event.type === 'done')) break
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    return store.getCodeSession(sessionId)!.items.slice(before)
  }
  const ledger = (): LedgerEntry[] => {
    try {
      return fs.readFileSync(path.join(dir, 'data', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry)
    } catch {
      return []
    }
  }
  const notices = (items: CodeItem[]): string[] => items.flatMap((item) => (item.type === 'notice' ? [item.text] : []))
  return { store, service, cli, bridge, events, asked, turn, ledger, notices }
}

const work = (): string => fs.mkdtempSync(path.join(dir, 'project-'))

describe('a Claude session on the subscription', () => {
  it('only uses the CLI when "use my subscription" was on as the session was created', () => {
    const { store, service } = harness()
    expect(service.create('claude', work()).engine).toBeUndefined()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    expect(service.create('claude', work()).engine).toBe('cli')
    expect(service.create('chatgpt', work()).engine).toBeUndefined()
    // Gemini has no subscription route in the Code tab.
    expect(service.create('gemini', work()).engine).toBeUndefined()
    expect(store.getSettings().subscription).toEqual({ claude: true, chatgpt: false })
  })

  it('runs on the plan, asks before an edit, and bills nothing to the API key', async () => {
    const { store, service, asked, turn, ledger, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    const items = await turn(session.id, 'Change draft to final in notes.txt')

    // What Claude Code was started with.
    const [call] = fake('claude').calls
    expect(call).toMatchObject({
      auth: 'plan', resume: null, model: null, prompt: 'Change draft to final in notes.txt',
      permissionMode: 'manual', settingSources: 'project', promptTool: PERMISSION_TOOL,
    })
    // The user was asked, through the bridge, before the edit ran.
    expect(asked).toEqual(['Edit notes.txt'])
    expect(items.map((item) => item.type)).toEqual(['user', 'text', 'tool', 'text', 'notice'])
    expect(items[1]).toMatchObject({ type: 'text', text: 'Looking at the project. ' })
    expect(items[2]).toMatchObject({ type: 'tool', name: 'Edit', summary: 'Edit notes.txt', status: 'done', output: 'Edited notes.txt' })
    expect(items[3]).toMatchObject({ text: 'Done: notes.txt now says final.' })
    expect(notices(items)).toEqual(['Ran on your Claude plan (Claude Opus 5.5) · 2.7k tokens in, 100 out · not billed to your API key'])

    const saved = store.getCodeSession(session.id)!
    expect(saved.cliSessionId).toBe('claude-session-1')
    expect(saved.costUsd).toBe(0)
    expect(ledger()).toEqual([])
    bridge.stop()
  })

  it('shows a declined edit as declined and lets the agent carry on', async () => {
    const { store, service, turn, bridge } = harness({ decide: 'deny' })
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const items = await turn(service.create('claude', work()).id, 'Change the file')
    expect(items[2]).toMatchObject({ type: 'tool', status: 'error', output: 'The user declined this action.' })
    expect(items[3]).toMatchObject({ text: 'Understood, I left notes.txt alone.' })
    bridge.stop()
  })

  it('continues the same Claude Code session on the next turn', async () => {
    const { store, service, turn, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    await turn(session.id, 'First')
    await turn(session.id, 'Second')
    expect(fake('claude').calls.map((call) => [call.auth, call.resume])).toEqual([['plan', null], ['plan', 'claude-session-1']])
    bridge.stop()
  })

  it('switches to the API key in the same session when the plan’s limit is reached, and says so', async () => {
    const { store, service, cli, turn, ledger, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    const items = await turn(session.id, 'Hit the LIMIT please')

    const calls = fake('claude').calls
    expect(calls.map((call) => [call.auth, call.resume, call.model])).toEqual([
      ['plan', null, null],
      // Same session, now on the key, with the session's model named so the price is known.
      ['api', 'claude-session-1', 'claude-opus-5-5'],
    ])
    // Nothing had been done yet, so the request is simply sent again.
    expect(calls[1]!.prompt).toBe('Hit the LIMIT please')
    const said = notices(items)
    expect(said[0]).toMatch(/^Your Claude plan’s usage limit is reached \(it resets at .+\)\. Carrying on with your API key\.$/)
    // The cost is this turn's own requests at API prices, not the CLI's running total (the stand-in reports $99).
    const expected = tokenCost('claude-opus-5-5', { inputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60 })! +
      tokenCost('claude-opus-5-5', { inputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 })!
    expect(said[1]).toBe(`Ran on your API key · ${formatUsd(expected)} · 2.7k tokens in, 100 out`)
    expect(items.at(-1)).toMatchObject({ type: 'notice', tone: 'info' })
    const saved = store.getCodeSession(session.id)!
    expect(saved.costUsd).toBeCloseTo(expected, 10)
    expect(ledger()).toMatchObject([{ kind: 'code', provider: 'claude', model: 'claude-opus-5-5', inputTokens: 2700, outputTokens: 100 }])
    expect(ledger()[0]!.costUsd).toBeCloseTo(expected, 10)

    // The limit is remembered: the next turn goes straight to the key, and says why.
    expect(cli.limitedUntil('claude')).toBeGreaterThan(Date.now() + 60 * 60_000)
    const next = await turn(session.id, 'And again')
    expect(fake('claude').calls.at(-1)).toMatchObject({ auth: 'api', resume: 'claude-session-1' })
    expect(fake('claude').calls).toHaveLength(3)
    expect(notices(next)[0]).toMatch(/^Your Claude plan’s limit is reached until .+\. Using your API key until then\.$/)

    // Once the limit has reset, the plan is used again.
    cli.clearLimit('claude')
    await turn(session.id, 'Back on the plan')
    expect(fake('claude').calls.at(-1)).toMatchObject({ auth: 'plan', resume: 'claude-session-1' })
    bridge.stop()
  })

  it('asks the API run to carry on, not start over, when the limit hit part-way', async () => {
    const { store, service, turn, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const items = await turn(service.create('claude', work()).id, 'HALFWAY to the LIMIT')
    expect(items[1]).toMatchObject({ type: 'text', text: 'I got part of the way. ' })
    const retry = String(fake('claude').calls[1]!.prompt)
    expect(retry).toMatch(/^The previous attempt at the request below was cut off/)
    expect(retry.endsWith('HALFWAY to the LIMIT')).toBe(true)
    bridge.stop()
  })

  it('stops with a clear message when the limit is reached and there is no API key', async () => {
    const { store, service, turn, ledger, notices, bridge } = harness({ keys: {} })
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const items = await turn(service.create('claude', work()).id, 'Hit the LIMIT')
    expect(fake('claude').calls).toHaveLength(1)
    expect(notices(items).at(-1)).toMatch(/usage limit is reached.*Add an API key in Settings and Threefold will carry on with it/)
    expect(ledger()).toEqual([])
    bridge.stop()
  })

  it('uses the API key when Claude Code turns out not to be signed in', async () => {
    setFake('claude', { loggedIn: false })
    const { store, service, turn, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const items = await turn(service.create('claude', work()).id, 'Do the thing')
    expect(fake('claude').calls.map((call) => call.auth)).toEqual(['plan', 'api'])
    expect(notices(items)[0]).toBe('Claude Code is not signed in to your Claude plan. Carrying on with your API key.')
    // The notice carries what is needed to sign in on the spot.
    expect(items.find((item) => item.type === 'notice' && item.setup)).toMatchObject({ setup: { provider: 'claude', need: 'sign-in' } })
    bridge.stop()
  })

  it('says so when the sign-in has expired, with or without an API key to fall back on', async () => {
    setFake('claude', { loggedIn: false, expired: true } as never)
    const withKey = harness()
    withKey.store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const first = await withKey.turn(withKey.service.create('claude', work()).id, 'Do the thing')
    expect(withKey.notices(first)[0]).toBe('Claude Code’s sign-in to your Claude plan has expired. Carrying on with your API key.')
    expect(withKey.notices(first).at(-1)).toMatch(/^Ran on your API key/)
    withKey.bridge.stop()

    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
    const noKey = harness({ keys: {} })
    noKey.store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const second = await noKey.turn(noKey.service.create('claude', work()).id, 'Do the thing')
    expect(noKey.notices(second)).toEqual(['Claude Code’s sign-in to your Claude plan has expired.'])
    expect(second.at(-1)).toMatchObject({ type: 'notice', tone: 'error', setup: { provider: 'claude', need: 'sign-in' } })
    expect(noKey.ledger()).toEqual([])
    noKey.bridge.stop()
  })

  it('sends the same request again after signing in, without showing it twice', async () => {
    setFake('claude', { loggedIn: false, expired: true } as never)
    const { store, service, turn, notices, bridge } = harness({ keys: {} })
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    await turn(session.id, 'Change the file')
    // The user signs in from the button under the notice; the window then sends the request again.
    setFake('claude', { loggedIn: true })
    const all = await turn(session.id, 'Change the file', true)
    expect(all.filter((item) => item.type === 'user')).toHaveLength(1)
    // The notice about signing in has done its job and is gone.
    expect(all.some((item) => item.type === 'notice' && item.setup)).toBe(false)
    expect(all.map((item) => item.type)).toEqual(['user', 'text', 'tool', 'text', 'notice'])
    expect(notices(all).at(-1)).toMatch(/^Ran on your Claude plan/)
    expect(fake('claude').calls.map((call) => call.prompt)).toEqual(['Change the file', 'Change the file'])
    bridge.stop()
  })

  it('runs an existing CLI session on the API key once "use my subscription" is switched off', async () => {
    const { store, service, turn, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    store.updateSettings({ subscription: { claude: false, chatgpt: false } })
    const items = await turn(session.id, 'Do the thing')
    expect(fake('claude').calls.map((call) => call.auth)).toEqual(['api'])
    expect(notices(items).at(-1)).toMatch(/^Ran on your API key · \$/)
    bridge.stop()
  })

  it('can be stopped', async () => {
    const { store, service, events, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    service.start(session.id, 'A SLOW task')
    while (!events.some((event) => event.type === 'delta')) await new Promise((resolve) => setTimeout(resolve, 20))
    service.stop(session.id)
    while (!events.some((event) => event.type === 'done')) await new Promise((resolve) => setTimeout(resolve, 20))
    const items = store.getCodeSession(session.id)!.items
    expect(items.at(-1)).toMatchObject({ type: 'notice', text: 'Stopped.', tone: 'info' })
    // A stopped plan run is not followed by an API run.
    expect(fake('claude').calls).toHaveLength(1)
    bridge.stop()
  })

  it('starts a new conversation when the CLI no longer has the earlier one', async () => {
    const { store, service, turn, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: true } })
    for (const [provider, kind] of [['claude', 'claude'], ['chatgpt', 'codex']] as const) {
      const session = service.create(provider, work())
      await turn(session.id, 'First')
      // The tool's own history is cleared behind Threefold's back.
      setFake(kind, { forgot: true } as never)
      const items = await turn(session.id, 'Second')
      expect(notices(items)).toContain('The earlier conversation is no longer on this computer, so this turn starts a new one.')
      // Asked to continue, told it is gone, then started afresh with the same request.
      expect(fake(kind).calls.slice(-2).map((call) => [call.resume === null ? 'new' : 'continue', call.prompt])).toEqual([
        ['continue', 'Second'],
        ['new', 'Second'],
      ])
      expect(items.some((item) => item.type === 'text' && /Done: notes\.txt now says final\./.test(item.text))).toBe(true)
      expect(notices(items).at(-1)).toMatch(/^Ran on your (Claude|ChatGPT) plan/)
    }
    bridge.stop()
  })

  it('explains what to do when the CLI is not installed', async () => {
    const { store, service, turn, bridge } = harness()
    store.updateSettings({ subscription: { claude: true, chatgpt: false } })
    const session = service.create('claude', work())
    fs.rmSync(path.join(dir, 'claude'))
    const items = await turn(session.id, 'Hello')
    expect(items.at(-1)).toMatchObject({ type: 'notice', text: 'Claude Code is not installed on this computer.', setup: { provider: 'claude', need: 'install' } })
    bridge.stop()
  })
})

describe('a ChatGPT session on the subscription', () => {
  it('runs Codex in its sandbox on the plan and shows what it did', async () => {
    const { store, service, turn, ledger, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: false, chatgpt: true } })
    const session = service.create('chatgpt', work())
    expect(session.engine).toBe('cli')
    const items = await turn(session.id, 'Change draft to final in notes.txt')

    expect(fake('codex').calls).toEqual([
      // No key reaches a plan run, not even one that was sitting in the environment.
      { auth: 'plan', resume: null, model: null, prompt: 'Change draft to final in notes.txt', sandboxed: true, json: true, sawOpenAiKey: false },
    ])
    expect(notices(items)).toEqual([CODEX_SANDBOX_NOTE, 'Ran on your ChatGPT plan · 5.0k tokens in, 300 out · not billed to your API key'])
    const shown = items.filter((item) => item.type !== 'notice' && item.type !== 'user')
    expect(shown.map((item) => item.type)).toEqual(['thinking', 'tool', 'tool', 'text'])
    expect(shown[1]).toMatchObject({ name: 'Run', summary: 'Run: ls -la', status: 'done', output: 'notes.txt\nREADME.md\n' })
    expect(shown[2]).toMatchObject({ name: 'Edit', summary: 'Change notes.txt', status: 'done' })
    expect(shown[3]).toMatchObject({ text: 'Done: notes.txt now says final.' })
    expect(store.getCodeSession(session.id)!.cliSessionId).toBe('codex-thread-1')
    expect(ledger()).toEqual([])

    // The sandbox note is only shown once per session.
    expect(notices(await turn(session.id, 'Again'))).not.toContain(CODEX_SANDBOX_NOTE)
    expect(fake('codex').calls[1]).toMatchObject({ auth: 'plan', resume: 'codex-thread-1' })
    bridge.stop()
  })

  it('falls back to the API key in the same thread, with the cost worked out from the tokens', async () => {
    const { store, service, cli, turn, ledger, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: false, chatgpt: true } })
    const session = service.create('chatgpt', work())
    const before = Date.now()
    const items = await turn(session.id, 'Reach the LIMIT')
    expect(fake('codex').calls.map((call) => [call.auth, call.resume, call.model])).toEqual([
      ['plan', null, null],
      ['api', 'codex-thread-1', 'gpt-6.1-sol'],
    ])
    // Codex said "try again in 2 hours 14 minutes"; that is how long the plan is left alone.
    const until = cli.limitedUntil('chatgpt')!
    expect(until).toBeGreaterThanOrEqual(before + 134 * 60_000)
    expect(until).toBeLessThanOrEqual(Date.now() + 134 * 60_000)
    // 5,000 input tokens of which 1,000 were cached, 300 out.
    const expected = tokenCost('gpt-6.1-sol', { inputTokens: 4000, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 300 })!
    expect(notices(items)).toEqual([
      CODEX_SANDBOX_NOTE,
      expect.stringMatching(/^Your ChatGPT plan’s usage limit is reached \(it resets at .+\)\. Carrying on with your API key\.$/),
      `Ran on your API key · ${formatUsd(expected)} · 5.0k tokens in, 300 out`,
    ])
    expect(ledger()).toMatchObject([{ kind: 'code', provider: 'chatgpt', model: 'gpt-6.1-sol' }])
    expect(store.getCodeSession(session.id)!.costUsd).toBeCloseTo(expected, 10)
    bridge.stop()
  })

  it('falls back when Codex is signed out', async () => {
    setFake('codex', { loggedIn: false })
    const { store, service, turn, notices, bridge } = harness()
    store.updateSettings({ subscription: { claude: false, chatgpt: true } })
    const items = await turn(service.create('chatgpt', work()).id, 'Go')
    expect(notices(items)).toContain('Codex is not signed in to your ChatGPT plan. Carrying on with your API key.')
    expect(items.find((item) => item.type === 'notice' && item.setup)).toMatchObject({ setup: { provider: 'chatgpt', need: 'sign-in' } })
    expect(fake('codex').calls.map((call) => call.auth)).toEqual(['plan', 'api'])
    bridge.stop()
  })
})
