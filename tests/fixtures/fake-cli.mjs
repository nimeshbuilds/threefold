#!/usr/bin/env node
// A stand-in for the Claude Code and Codex command-line tools, for tests.
// It makes no network calls and talks to no account.
//
// Which tool it plays comes from FAKE_CLI_KIND ("claude" or "codex"). Its
// state (version, sign-in, whether the plan's limit is reached) lives in the
// JSON file named by FAKE_CLI_STATE, so `update` and `login` have a lasting
// effect, and every agent run is logged there for the tests to read.
//
// Words in a prompt steer a run:  LIMIT   the plan's usage limit is reached
//                                 HALFWAY some work is done before the limit hits
//                                 SLOW    the run takes long enough to be stopped

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const kind = process.env.FAKE_CLI_KIND
const statePath = process.env.FAKE_CLI_STATE
const args = process.argv.slice(2)

const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
const me = () => read()[kind]
const change = (edit) => {
  const state = read()
  edit(state[kind])
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1))
}
const out = (line) => process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** Does what Claude Code does with --permission-prompt-tool: starts the MCP server and calls its tool. */
function askPermission(question) {
  const config = flag('--mcp-config')
  const tool = flag('--permission-prompt-tool') ?? ''
  if (!config || !tool.startsWith('mcp__')) return Promise.resolve({ behavior: 'deny', message: 'No permission tool was given.' })
  const [, serverName, toolName] = tool.split('__')
  const server = JSON.parse(config).mcpServers[serverName]
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: question } })
      } else if (message.id === 2) {
        child.kill()
        resolve(JSON.parse(message.result.content[0].text))
      }
    })
    child.on('error', () => resolve({ behavior: 'deny', message: 'The permission server could not be started.' }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } })
  })
}

async function claudeRun() {
  const prompt = fs.readFileSync(0, 'utf8')
  const onKey = Boolean(process.env.ANTHROPIC_API_KEY)
  const resume = flag('--resume')
  const model = flag('--model') ?? 'claude-opus-5-5'
  const state = me()
  const sessionId = resume ?? `claude-session-${state.calls.length + 1}`
  change((s) =>
    s.calls.push({
      auth: onKey ? 'api' : 'plan',
      resume: resume ?? null,
      model: flag('--model') ?? null,
      prompt,
      permissionMode: flag('--permission-mode') ?? null,
      settingSources: flag('--setting-sources') ?? null,
      promptTool: flag('--permission-prompt-tool') ?? null,
    }),
  )
  const usage = (input, output) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output })
  if (resume && state.forgot) {
    // What the real tool does when the session it is asked to continue is not on disk.
    process.stderr.write(`No conversation found with session ID: ${resume}\n`)
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume, total_cost_usd: 0, usage: usage(0, 0) })
    process.exitCode = 1
    return
  }
  const say = async (id, text, input, output) => {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null })
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, parent_tool_use_id: null })
      await sleep(8)
    }
    out({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage: usage(input, output) }, parent_tool_use_id: null })
  }
  const end = (text, isError) => {
    // total_cost_usd is deliberately absurd: Threefold must add up this turn's requests itself.
    out({ type: 'result', subtype: 'success', is_error: isError, result: text, session_id: sessionId, total_cost_usd: 99, usage: usage(0, 0) })
    process.exitCode = isError ? 1 : 0
  }

  // As the real tool does: on a plan the model is named with its context window in brackets, and a
  // status message follows the first one.
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') ?? `${model}[1m]`, apiKeySource: onKey ? 'ANTHROPIC_API_KEY' : 'none', permissionMode: 'default' })
  out({ type: 'system', subtype: 'status', session_id: sessionId })
  if (!onKey && !state.loggedIn) {
    // The second wording is what Claude Code 2.1.281 really printed with a sign-in that had run out.
    const said = state.expired ? 'Failed to authenticate: OAuth session expired and could not be refreshed' : 'Not logged in · Please run /login'
    out({ type: 'assistant', error: 'authentication_failed', message: { id: 'msg_auth', model, role: 'assistant', content: [{ type: 'text', text: said }], usage: usage(0, 0) } })
    return end(said, true)
  }
  if (!onKey && (state.limit || /LIMIT/.test(prompt))) {
    if (/HALFWAY/.test(prompt)) await say('msg_half', 'I got part of the way. ', 800, 12)
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600, rateLimitType: 'five_hour' }, session_id: sessionId })
    return end('Claude usage limit reached. Your limit will reset at 3pm.', true)
  }

  await say('msg_1', 'Looking at the project. ', 1200, 20)
  if (/SLOW/.test(prompt)) await sleep(8000)
  const edit = { file_path: 'notes.txt', old_string: 'draft', new_string: 'final' }
  out({ type: 'assistant', message: { id: 'msg_1', model, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: edit }], usage: usage(1200, 60) }, parent_tool_use_id: null })
  const answer = await askPermission({ tool_name: 'Edit', input: edit, tool_use_id: 'toolu_1' })
  const allowed = answer.behavior === 'allow'
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: allowed ? 'Edited notes.txt' : answer.message, is_error: !allowed }] }, parent_tool_use_id: null })
  const closing = allowed ? 'Done: notes.txt now says final.' : 'Understood, I left notes.txt alone.'
  await say('msg_2', closing, 1500, 40)
  end(closing, false)
}

async function codexRun() {
  const resume = args[1] === 'resume' ? args[2] : undefined
  const prompt = args[args.length - 1]
  const onKey = Boolean(process.env.CODEX_API_KEY)
  const state = me()
  const threadId = resume ?? `codex-thread-${state.calls.length + 1}`
  change((s) =>
    s.calls.push({
      auth: onKey ? 'api' : 'plan',
      resume: resume ?? null,
      model: flag('-m') ?? null,
      prompt,
      sandboxed: args.includes('sandbox_mode="workspace-write"'),
      json: args.includes('--json'),
      sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    }),
  )
  const fail = (message) => {
    out({ type: 'error', message })
    out({ type: 'turn.failed', error: { message } })
    process.exitCode = 1
  }
  if (resume && state.forgot) {
    // What the real tool does when the thread it is asked to continue is not on disk.
    process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${resume} (code -32600)\n`)
    process.exitCode = 1
    return
  }
  out({ type: 'thread.started', thread_id: threadId })
  out({ type: 'turn.started' })
  if (!onKey && !state.loggedIn) return fail('Not logged in. Run `codex login` to sign in.')
  if (!onKey && (state.limit || /LIMIT/.test(prompt))) {
    if (/HALFWAY/.test(prompt)) out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I got part of the way.' } })
    return fail("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 14 minutes.")
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Checking what is in the folder.' } })
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"', aggregated_output: '', status: 'in_progress' } })
  if (/SLOW/.test(prompt)) await sleep(8000)
  await sleep(40)
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"', aggregated_output: 'notes.txt\nREADME.md\n', exit_code: 0, status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: `${process.cwd()}/notes.txt`, kind: 'update' }], status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done: notes.txt now says final.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100 } })
}

async function main() {
  const name = kind === 'claude' ? 'Claude Code' : 'Codex'
  if (args[0] === '--version') return out(kind === 'claude' ? `${me().version} (Claude Code)` : `codex-cli ${me().version}`)
  if (args[0] === '--help') return out('Usage\n  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")')
  if (args[0] === 'update') {
    out(`Updating ${name} from ${me().version} to ${me().latest}…`)
    await sleep(150)
    change((s) => {
      s.version = s.latest
    })
    return out('\u001b[32mUpdate complete.\u001b[0m')
  }
  const signingIn = kind === 'claude' ? args[0] === 'auth' && args[1] === 'login' : args[0] === 'login' && args[1] !== 'status'
  if (signingIn) {
    out('Opening your browser to sign in…')
    out(`If it did not open, go to: https://${kind === 'claude' ? 'claude.ai' : 'auth.openai.com'}/oauth/authorize?demo=1`)
    await sleep(250)
    change((s) => {
      s.loggedIn = true
    })
    return out(kind === 'claude' ? 'Login successful.' : 'Successfully logged in')
  }
  if (kind === 'claude' && args[0] === 'auth' && args[1] === 'status') {
    const state = me()
    out(
      JSON.stringify(
        state.loggedIn
          ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: state.plan, email: 'sam@example.com' }
          : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
      ),
    )
    process.exitCode = state.loggedIn ? 0 : 1
    return
  }
  if (kind === 'codex' && args[0] === 'login' && args[1] === 'status') {
    if (me().loggedIn) return out('Logged in using ChatGPT')
    process.stderr.write('Not logged in\n')
    process.exitCode = 1
    return
  }
  if (kind === 'claude' && args.includes('-p')) return claudeRun()
  if (kind === 'codex' && args[0] === 'exec') return codexRun()
  process.stderr.write(`fake ${kind}: unexpected arguments ${JSON.stringify(args)}\n`)
  process.exitCode = 2
}

await main()
