// Claude mode: one chat turn against the Anthropic Messages API.
//
// The turn is a loop. Each pass streams one response; if Claude asked for a
// tool that runs on this computer (memory), the result is appended and the
// loop continues. Web search, web fetch and code execution run on Anthropic's
// servers inside a single response.

import path from 'node:path'
import Anthropic, { toFile } from '@anthropic-ai/sdk'
import type { Attachment, ChatMessage, Citation, Usage } from '@shared/types'
import { UTILITY_MODEL, addRequest, emptyUsage, estimateTokens, findModel } from '@shared/pricing'
import {
  EventLog,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  addCitation,
  describeError,
  fileBlockText,
  isResearch,
  memoryText,
  prepareAttachment,
  userText,
  type TurnContext,
  type TurnResult,
} from './common'
import { LiveMeter } from './meter'

type MessageParam = Anthropic.Beta.BetaMessageParam
type BlockParam = Anthropic.Beta.BetaContentBlockParam
type Block = Anthropic.Beta.BetaContentBlock
type BetaMessage = Anthropic.Beta.BetaMessage
type ToolUnion = Anthropic.Beta.BetaToolUnion
type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

const MAX_OUTPUT_TOKENS = 64_000
const MAX_LOOPS = 12
const BETA_THINKING_CONTROLS = 'thinking-binding-controls-2026-08-01'
const BETA_FALLBACK = 'server-side-fallback-2026-07-01'

export function claudeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

/** Checks a key with a free call. Returns the model ids the key can use. */
export async function verifyClaudeKey(apiKey: string): Promise<string[]> {
  const client = claudeClient(apiKey)
  const ids: string[] = []
  for await (const model of client.models.list({ limit: 100 })) ids.push(model.id)
  return ids
}

async function ensureUploaded(client: Anthropic, ctx: TurnContext, attachment: Attachment): Promise<string> {
  const existing = attachment.remote?.claude
  if (existing) return existing
  const data = ctx.store.readAttachment(attachment)
  const uploaded = await client.files.upload(
    { file: await toFile(data, attachment.name, { type: attachment.mime }) },
    { signal: ctx.signal },
  )
  attachment.remote = { ...attachment.remote, claude: uploaded.id }
  return uploaded.id
}

async function attachmentBlocks(
  client: Anthropic,
  ctx: TurnContext,
  attachments: Attachment[] | undefined,
): Promise<BlockParam[]> {
  const blocks: BlockParam[] = []
  for (const attachment of attachments ?? []) {
    const prepared = prepareAttachment(ctx.store, attachment, ctx.conversation.tools.codeExec)
    switch (prepared.type) {
      case 'image':
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mime as ImageMime, data: prepared.base64 },
        })
        break
      case 'pdf':
        blocks.push({
          type: 'document',
          title: attachment.name,
          source: { type: 'base64', media_type: 'application/pdf', data: prepared.base64 },
        })
        break
      case 'text':
        blocks.push({ type: 'text', text: fileBlockText(attachment.name, prepared.text) })
        break
      case 'sandbox':
        try {
          const fileId = await ensureUploaded(client, ctx, attachment)
          blocks.push({ type: 'container_upload', file_id: fileId })
          blocks.push({ type: 'text', text: `[The file "${attachment.name}" is available in the code sandbox.]` })
        } catch (error) {
          blocks.push({
            type: 'text',
            text: `[The file "${attachment.name}" could not be uploaded to the code sandbox: ${describeError(error)}]`,
          })
        }
        break
      case 'note':
        blocks.push({ type: 'text', text: prepared.text })
        break
    }
  }
  return blocks
}

/**
 * After a mid-answer fallback the API only accepts part of the declined
 * model's output back: thinking and tool calls before the last `fallback`
 * block must be left out, and the `fallback` block itself must stay in place.
 */
export function sanitizeReplay(turn: MessageParam[]): MessageParam[] {
  return turn.map((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message
    const blocks = message.content
    let boundary = -1
    blocks.forEach((block, index) => {
      if ((block as { type: string }).type === 'fallback') boundary = index
    })
    if (boundary === -1) return message
    const before = blocks.slice(0, boundary)
    const answered = new Set<string>()
    for (const block of before) {
      const id = (block as { tool_use_id?: unknown }).tool_use_id
      if (typeof id === 'string') answered.add(id)
    }
    const kept = before.filter((block) => {
      const type = (block as { type: string }).type
      if (type === 'text' || type === 'fallback') return true
      if (type === 'server_tool_use') return answered.has((block as { id: string }).id)
      return typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
    })
    return { ...message, content: [...kept, ...blocks.slice(boundary)] }
  })
}

async function buildMessages(client: Anthropic, ctx: TurnContext, plain: boolean): Promise<MessageParam[]> {
  const messages: MessageParam[] = []

  if (ctx.project && ctx.project.files.length > 0) {
    const blocks = await attachmentBlocks(client, ctx, ctx.project.files)
    blocks.push({ type: 'text', text: `These are the files of the project "${ctx.project.name}".` })
    messages.push({ role: 'user', content: blocks })
  }

  for (const message of ctx.history) {
    if (message.role === 'user') {
      const blocks = await attachmentBlocks(client, ctx, message.attachments)
      if (message.text) blocks.push({ type: 'text', text: userText(message) })
      if (blocks.length === 0) continue
      messages.push({ role: 'user', content: blocks })
      continue
    }
    if (!plain && message.replayProvider === 'claude' && Array.isArray(message.replay) && message.replay.length > 0) {
      messages.push(...sanitizeReplay(message.replay as MessageParam[]))
    } else if (message.text.trim()) {
      messages.push({ role: 'assistant', content: message.text })
    }
  }

  // The API requires the first message to come from the user (imports can start otherwise).
  if (messages[0]?.role !== 'user') {
    messages.unshift({ role: 'user', content: '(This conversation was imported; the first message is missing.)' })
  }
  return messages
}

function buildTools(ctx: TurnContext): ToolUnion[] {
  const tools: ToolUnion[] = []
  // Deep research always searches and reads the web, whatever the toggle says.
  if (ctx.conversation.tools.webSearch || isResearch(ctx.history)) {
    tools.push({ type: 'web_search_20260209', name: 'web_search' })
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch' })
  }
  if (ctx.conversation.tools.codeExec) {
    tools.push({ type: 'code_execution_20260521', name: 'code_execution' })
  }
  if (ctx.memoryEnabled) {
    tools.push({
      name: MEMORY_TOOL_NAME,
      description: MEMORY_TOOL_DESCRIPTION,
      // Stream the input as it is written; the arguments are validated before use.
      eager_input_streaming: true,
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The fact to remember, as one short sentence.' } },
        required: ['text'],
        additionalProperties: false,
      },
    })
  }
  return tools
}

function serverToolTitle(name: string): { kind: 'web_search' | 'web_fetch' | 'code'; title: string } {
  if (name === 'web_search') return { kind: 'web_search', title: 'Searching the web' }
  if (name === 'web_fetch') return { kind: 'web_fetch', title: 'Reading a page' }
  if (name === 'text_editor_code_execution') return { kind: 'code', title: 'Editing a file in the sandbox' }
  return { kind: 'code', title: 'Running code' }
}

function toolInputDetail(name: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['query', 'url', 'command', 'code', 'path', 'text']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  return name === 'web_search' ? undefined : JSON.stringify(input)
}

function requestTokens(usage: {
  input_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  }
}

/** Folds one finished response into the meter, pricing each attempt on the model that ran it. */
function settle(meter: LiveMeter, final: BetaMessage): void {
  const webSearches = final.usage.server_tool_use?.web_search_requests ?? 0
  const iterations = final.usage.iterations ?? []
  if (iterations.length === 0) {
    meter.requestFinished(
      final.model,
      { ...requestTokens(final.usage), outputTokens: final.usage.output_tokens },
      { webSearches },
    )
    return
  }
  iterations.forEach((iteration, index) => {
    meter.requestFinished(
      ('model' in iteration ? iteration.model : null) ?? final.model,
      { ...requestTokens(iteration), outputTokens: iteration.output_tokens },
      { webSearches: index === 0 ? webSearches : 0 },
    )
  })
}

async function downloadGenerated(client: Anthropic, ctx: TurnContext, fileId: string): Promise<Attachment | null> {
  try {
    const meta = await client.files.retrieveMetadata(fileId, undefined, { signal: ctx.signal })
    const response = await client.files.download(fileId, undefined, { signal: ctx.signal })
    const data = Buffer.from(await response.arrayBuffer())
    const name = path.basename(meta.filename || '') || 'output'
    return ctx.store.saveAttachment(name, data, meta.mime_type || undefined)
  } catch {
    return null
  }
}

interface StreamState {
  text: string
  thinking: string
  lastBlock: string
}

export async function runClaudeTurn(ctx: TurnContext): Promise<TurnResult> {
  const client = claudeClient(ctx.apiKey)
  const requestedModel = ctx.conversation.model
  const caps = findModel(requestedModel)
  const meter = new LiveMeter(requestedModel, ctx.emit.usage)
  const log = new EventLog(ctx.emit.event)
  const citations: Citation[] = []
  const generated: Attachment[] = []
  const state: StreamState = { text: '', thinking: '', lastBlock: '' }
  const tools = buildTools(ctx)
  // Anthropic has no separate research endpoint: deep research is the chat model at its
  // highest practical effort, with web search and web fetch, following the research brief.
  const research = isResearch(ctx.history)
  if (research) {
    log.upsert({
      id: 'research',
      kind: 'research',
      title: 'Deep research',
      detail: 'Searching, reading sources and cross-checking. This can take several minutes.',
      status: 'running',
    })
  }
  const maxLoops = research ? MAX_LOOPS * 3 : MAX_LOOPS
  const turn: MessageParam[] = []
  let servedBy = requestedModel
  let containerId = ctx.conversation.containerId
  let error: string | undefined
  let safeMode = false
  let base = await buildMessages(client, ctx, false)
  let jsonRetries = 0

  const emitText = (delta: string): void => {
    state.text += delta
    ctx.emit.text(delta)
  }

  const streamOnce = async (): Promise<BetaMessage> => {
    const betas: string[] = []
    if (!safeMode) {
      betas.push(BETA_THINKING_CONTROLS)
      if (caps?.fallbacks) betas.push(BETA_FALLBACK)
    }
    const stream = client.beta.messages.stream(
      {
        model: requestedModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [{ type: 'text', text: ctx.system }],
        messages: [...base, ...turn],
        // Caches the conversation so far; later turns re-read it at the cache rate.
        cache_control: { type: 'ephemeral' },
        thinking: safeMode
          ? { type: 'adaptive', display: 'summarized' }
          : {
              type: 'adaptive',
              display: 'summarized',
              // If an earlier turn was edited, drop its reasoning instead of failing the request.
              block_binding: { prefix_mismatch_behavior: 'drop_block' },
            },
        ...(tools.length > 0 ? { tools } : {}),
        ...(research
          ? { output_config: { effort: 'xhigh' as const } }
          : ctx.conversation.effort !== 'default'
            ? { output_config: { effort: ctx.conversation.effort } }
            : {}),
        ...(!safeMode && caps?.fallbacks ? { fallbacks: 'default' as const } : {}),
        ...(!safeMode && containerId && ctx.conversation.tools.codeExec ? { container: containerId } : {}),
        ...(betas.length > 0 ? { betas } : {}),
      },
      { signal: ctx.signal },
    )

    const inputs = new Map<number, { id: string; name: string; json: string }>()

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          meter.inputKnown(event.message.model, requestTokens(event.message.usage))
          break
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            if (state.text && state.lastBlock !== 'text') emitText('\n\n')
          } else if (block.type === 'thinking') {
            if (state.thinking) {
              state.thinking += '\n\n'
              ctx.emit.thinking('\n\n')
            }
          } else if (block.type === 'server_tool_use') {
            const { kind, title } = serverToolTitle(block.name)
            inputs.set(event.index, { id: block.id, name: block.name, json: '' })
            log.upsert({ id: block.id, kind, title, status: 'running' })
          } else if (block.type === 'tool_use') {
            inputs.set(event.index, { id: block.id, name: block.name, json: '' })
            if (block.name === MEMORY_TOOL_NAME) {
              log.upsert({ id: block.id, kind: 'memory', title: 'Saving to memory', status: 'running' })
            }
          } else if (block.type === 'web_search_tool_result') {
            if (Array.isArray(block.content)) {
              log.patch(block.tool_use_id, {
                status: 'done',
                output: block.content
                  .slice(0, 8)
                  .map((r) => `${r.title} — ${r.url}`)
                  .join('\n'),
              })
            } else {
              log.patch(block.tool_use_id, { status: 'error', output: block.content.error_code })
            }
          } else if (block.type === 'web_fetch_tool_result') {
            log.patch(block.tool_use_id, { status: 'done' })
          } else if (block.type === 'bash_code_execution_tool_result') {
            if (block.content.type === 'bash_code_execution_result') {
              const output = [block.content.stdout, block.content.stderr].filter(Boolean).join('\n').trim()
              log.patch(block.tool_use_id, {
                status: block.content.return_code === 0 ? 'done' : 'error',
                output: output.slice(0, 20_000),
              })
              for (const file of block.content.content) {
                const saved = await downloadGenerated(client, ctx, file.file_id)
                if (saved) generated.push(saved)
              }
            } else {
              log.patch(block.tool_use_id, { status: 'error', output: block.content.error_code })
            }
          } else if (block.type === 'text_editor_code_execution_tool_result') {
            log.patch(block.tool_use_id, { status: 'done' })
          } else if (block.type === 'code_execution_tool_result') {
            log.patch(block.tool_use_id, { status: 'done' })
          } else if (block.type === 'fallback') {
            servedBy = block.to.model
            log.upsert({
              id: `fallback-${event.index}-${turn.length}`,
              kind: 'notice',
              title: `Answered by ${findModel(block.to.model)?.label ?? block.to.model}`,
              detail: `${findModel(block.from.model)?.label ?? block.from.model} declined this request, so the API switched models.`,
              status: 'done',
            })
          }
          state.lastBlock = block.type
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            emitText(delta.text)
            meter.outputChars(delta.text.length)
          } else if (delta.type === 'thinking_delta') {
            state.thinking += delta.thinking
            ctx.emit.thinking(delta.thinking)
            meter.outputChars(delta.thinking.length)
          } else if (delta.type === 'input_json_delta') {
            const pending = inputs.get(event.index)
            if (pending) pending.json += delta.partial_json
            meter.outputChars(delta.partial_json.length)
          }
          break
        }
        case 'content_block_stop': {
          const pending = inputs.get(event.index)
          if (pending) {
            let parsed: unknown
            try {
              parsed = pending.json ? JSON.parse(pending.json) : undefined
            } catch {
              parsed = undefined
            }
            const detail = toolInputDetail(pending.name, parsed)
            if (detail) log.patch(pending.id, { detail: detail.slice(0, 20_000) })
          }
          break
        }
        default:
          break
      }
    }
    return stream.finalMessage()
  }

  try {
    for (let loop = 0; loop < maxLoops; loop++) {
      let final: BetaMessage
      try {
        final = await streamOnce()
        jsonRetries = 0
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError) throw err
        // First request rejected as malformed: retry once without the beta
        // features and with text-only history, which every model accepts.
        if (err instanceof Anthropic.BadRequestError && !safeMode && turn.length === 0 && !state.text) {
          safeMode = true
          containerId = undefined
          base = await buildMessages(client, ctx, true)
          log.upsert({
            id: 'safe-mode',
            kind: 'notice',
            title: 'Retried in compatibility mode',
            detail: err.message,
            status: 'done',
          })
          loop -= 1
          continue
        }
        if (err instanceof Anthropic.APIError) throw err
        // A tool input that was not valid JSON: ask again, at most twice in a row.
        if (jsonRetries++ >= 2) throw err
        continue
      }

      settle(meter, final)
      servedBy = final.model
      if (final.container?.id) containerId = final.container.id

      for (const block of final.content) {
        if (block.type !== 'text') continue
        for (const citation of block.citations ?? []) {
          if (citation.type === 'web_search_result_location') addCitation(citations, citation.url, citation.title)
        }
      }

      if (final.stop_reason === 'refusal') {
        const category = final.stop_details?.category
        error =
          'The model declined this request' +
          (category ? ` (safety category: ${category})` : '') +
          '. Try rephrasing, or switch to another model.'
        break
      }

      turn.push({ role: 'assistant', content: final.content as unknown as BlockParam[] })

      // Server tools hit their step limit: send the turn back and the API resumes.
      if (final.stop_reason === 'pause_turn') continue

      // Tool calls made before a mid-answer fallback are not replayed, so they are not run either.
      let boundary = -1
      final.content.forEach((block: Block, index: number) => {
        if (block.type === 'fallback') boundary = index
      })
      const calls = final.content
        .slice(boundary + 1)
        .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
      if (calls.length === 0) {
        if (final.stop_reason === 'max_tokens') error = 'The reply was cut off because it reached the length limit.'
        break
      }
      if (final.stop_reason === 'max_tokens') {
        turn.pop()
        error = 'The reply was cut off in the middle of a tool call. Please try again.'
        break
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const call of calls) {
        if (call.name !== MEMORY_TOOL_NAME) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Unknown tool.' })
          continue
        }
        const text = memoryText(call.input)
        if (!text) {
          log.patch(call.id, { status: 'error' })
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }),
          })
          continue
        }
        ctx.store.addMemory(text, 'claude')
        log.patch(call.id, { status: 'done', title: 'Saved to memory', detail: text })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Saved.' })
      }
      turn.push({ role: 'user', content: results })
    }
  } catch (err) {
    log.finishRunning()
    if (err instanceof Anthropic.APIUserAbortError || ctx.signal.aborted) {
      return {
        text: state.text,
        thinking: state.thinking,
        events: log.events,
        citations,
        generated,
        usage: meter.finish(true),
        model: servedBy,
        error: 'Stopped.',
        containerId,
      }
    }
    return {
      text: state.text,
      thinking: state.thinking,
      events: log.events,
      citations,
      generated,
      usage: meter.finish(true),
      model: servedBy,
      error: claudeErrorMessage(err),
      containerId,
    }
  }

  log.finishRunning()
  return {
    text: state.text,
    thinking: state.thinking,
    events: log.events,
    citations,
    generated,
    usage: meter.finish(false),
    model: servedBy,
    // A refused turn is not replayed; the next request sends its text only.
    replay: error || safeMode ? undefined : turn,
    error,
    containerId,
  }
}

export function claudeErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API key was rejected. Check it in Settings.'
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'This API key is not allowed to use that model or feature.'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate limit reached. Wait a moment and try again.'
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(error.message)) {
      return 'Your Anthropic API credit balance is used up. It refills at your next billing cycle, or you can add credits in the Claude Console.'
    }
    return `Anthropic rejected the request: ${error.message}`
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check your internet connection.'
  }
  if (error instanceof Anthropic.APIError) return `Anthropic error ${error.status ?? ''}: ${error.message}`.trim()
  return describeError(error)
}

/** Names a chat from its first exchange, on the cheapest model. */
export async function claudeTitle(
  apiKey: string,
  userText: string,
  assistantText: string,
): Promise<{ title: string; usage: Usage } | null> {
  const model = UTILITY_MODEL.claude
  const client = claudeClient(apiKey)
  const response = await client.messages.create({
    model,
    max_tokens: 64,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system:
      'Write a title of at most six words for this conversation. Reply with the title only: no quotes, no trailing punctuation.',
    messages: [
      {
        role: 'user',
        content: `User: ${userText.slice(0, 1500)}\n\nAssistant: ${assistantText.slice(0, 1500)}`,
      },
    ],
  })
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? ''
  const title = text.replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 80)
  if (!title) return null
  const usage = addRequest(emptyUsage(model), model, {
    ...requestTokens(response.usage),
    outputTokens: response.usage.output_tokens,
  })
  return { title, usage: { ...usage, estimated: false } }
}

/** Rough size of a conversation in tokens, for the "this will cost about" hint. */
export function approxHistoryTokens(history: ChatMessage[]): number {
  return estimateTokens(history.reduce((sum, m) => sum + m.text.length, 0))
}
