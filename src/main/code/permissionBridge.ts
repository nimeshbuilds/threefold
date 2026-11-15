// Lets Claude Code ask the user before it uses a tool.
//
// Run without its own interface, Claude Code sends every permission question to
// an MCP tool named with --permission-prompt-tool. Threefold provides that
// tool: a very small MCP server (a Node script that Claude Code starts) which
// passes each question over a local socket to the app, where the usual
// "Allow this?" card is shown, and returns the answer.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const PERMISSION_TOOL = 'mcp__threefold__approve'

export type PermissionAnswer =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export type PermissionHandler = (tool: string, input: Record<string, unknown>) => Promise<boolean>

/**
 * The MCP server, as source. It has no dependencies, so it runs on any Node
 * (in the app: Threefold's own binary in Node mode). It speaks the MCP stdio
 * transport: one JSON-RPC message per line.
 */
export const BRIDGE_SCRIPT = `'use strict'
const net = require('node:net')
const readline = require('node:readline')

const SOCKET = process.env.THREEFOLD_BRIDGE_SOCKET
const TOKEN = process.env.THREEFOLD_BRIDGE_TOKEN
const TOOL = {
  name: 'approve',
  description: 'Asks the person using Threefold whether a tool may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

function ask(args) {
  return new Promise((resolve) => {
    let buffer = ''
    let done = false
    const socket = net.createConnection(SOCKET)
    const finish = (answer) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(answer)
    }
    socket.on('connect', () => {
      socket.write(JSON.stringify({ token: TOKEN, tool: args.tool_name, input: args.input || {} }) + '\\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\\n')
      if (end === -1) return
      try {
        finish(JSON.parse(buffer.slice(0, end)))
      } catch {
        finish({ behavior: 'deny', message: 'Threefold sent an answer that could not be read, so this was not allowed.' })
      }
    })
    socket.on('error', () => finish({ behavior: 'deny', message: 'Threefold could not be reached, so this was not allowed.' }))
    socket.on('close', () => finish({ behavior: 'deny', message: 'Threefold closed before answering, so this was not allowed.' }))
  })
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') {
    reply({
      protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'threefold', version: '1' },
    })
  } else if (message.method === 'tools/list') {
    reply({ tools: [TOOL] })
  } else if (message.method === 'tools/call') {
    const answer = await ask((message.params && message.params.arguments) || {})
    reply({ content: [{ type: 'text', text: JSON.stringify(answer) }] })
  } else if (message.method === 'ping') {
    reply({})
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
})
`

export class PermissionBridge {
  private server: net.Server | null = null
  private readonly socketPath: string
  private readonly scriptPath: string
  private handlers = new Map<string, PermissionHandler>()

  /**
   * @param dir where the server script is written (the app's data folder)
   * @param nodeBinary a Node to run the script with (the app's own binary works, in Node mode)
   */
  constructor(
    dir: string,
    private readonly nodeBinary: string = process.execPath,
  ) {
    this.scriptPath = path.join(dir, 'permission-server.cjs')
    // Socket paths are limited to about 100 characters, so it lives in the temp folder under a short name.
    this.socketPath = path.join(os.tmpdir(), `threefold-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
  }

  private async listen(): Promise<void> {
    if (this.server) return
    fs.mkdirSync(path.dirname(this.scriptPath), { recursive: true })
    fs.writeFileSync(this.scriptPath, BRIDGE_SCRIPT, { mode: 0o600 })
    fs.rmSync(this.socketPath, { force: true })
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end === -1) return
        const line = buffer.slice(0, end)
        buffer = ''
        void this.answer(line).then((answer) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`)
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => resolve())
    })
    // Only this user may connect.
    fs.chmodSync(this.socketPath, 0o600)
    this.server = server
  }

  private async answer(line: string): Promise<PermissionAnswer> {
    let request: { token?: unknown; tool?: unknown; input?: unknown }
    try {
      request = JSON.parse(line) as typeof request
    } catch {
      return { behavior: 'deny', message: 'The request could not be read.' }
    }
    const handler = typeof request.token === 'string' ? this.handlers.get(request.token) : undefined
    // No handler means the run this question belongs to is over, or the caller is not ours.
    if (!handler || typeof request.tool !== 'string') return { behavior: 'deny', message: 'This run is no longer active.' }
    const input = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {}
    const allowed = await handler(request.tool, input).catch(() => false)
    return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this action.' }
  }

  /**
   * Opens the bridge for one run. Returns the --mcp-config value to give
   * Claude Code, and a function that closes the bridge for that run again.
   */
  async open(handler: PermissionHandler): Promise<{ mcpConfig: string; close(): void }> {
    await this.listen()
    const token = randomBytes(24).toString('hex')
    this.handlers.set(token, handler)
    const mcpConfig = JSON.stringify({
      mcpServers: {
        threefold: {
          type: 'stdio',
          command: this.nodeBinary,
          args: [this.scriptPath],
          env: { THREEFOLD_BRIDGE_SOCKET: this.socketPath, THREEFOLD_BRIDGE_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    })
    return { mcpConfig, close: () => void this.handlers.delete(token) }
  }

  stop(): void {
    this.handlers.clear()
    this.server?.close()
    this.server = null
    fs.rmSync(this.socketPath, { force: true })
  }
}
