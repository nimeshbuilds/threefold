// ChatGPT mode: one chat turn against the OpenAI Responses API.
//
// Requests are stateless (`store: false`): the conversation lives on this
// computer and is sent with every request. Web search, the code interpreter
// and image generation are OpenAI-hosted tools; memory is a function tool that
// runs here.

import path from 'node:path'
import OpenAI, { toFile } from 'openai'
import type { Attachment, Citation, Usage } from '@shared/types'
import { TOOL_FEES, UTILITY_MODEL, addRequest, emptyUsage, estimateTokens } from '@shared/pricing'
import {
  EventLog,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  addCitation,
  describeError,
  fileBlockText,
  memoryText,
  prepareAttachment,
  type TurnContext,
  type TurnResult,
} from './common'
import { LiveMeter } from './meter'

type InputItem = OpenAI.Responses.ResponseInputItem
type InputContent = OpenAI.Responses.ResponseInputContent
type Tool = OpenAI.Responses.Tool
type ResponseObject = OpenAI.Responses.Response
type Includable = OpenAI.Responses.ResponseIncludable

const MAX_LOOPS = 12

export function openaiClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey })
}

/** Checks a key with a free call. Returns the model ids the key can use. */
export async function verifyOpenAIKey(apiKey: string): Promise<string[]> {
  const client = openaiClient(apiKey)
  const ids: string[] = []
  for await (const model of client.models.list()) ids.push(model.id)
  return ids
}

interface BuiltInput {
  items: InputItem[]
  sandboxFileIds: string[]
  uploadedNow: boolean
  chars: number
}

async function attachmentParts(
  client: OpenAI,
  ctx: TurnContext,
  attachments: Attachment[] | undefined,
  built: BuiltInput,
): Promise<InputContent[]> {
  const parts: InputContent[] = []
  for (const attachment of attachments ?? []) {
    const prepared = prepareAttachment(ctx.store, attachment, ctx.conversation.tools.codeExec)
    switch (prepared.type) {
      case 'image':
        parts.push({
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${attachment.mime};base64,${prepared.base64}`,
        })
        break
      case 'pdf':
        parts.push({
          type: 'input_file',
          filename: attachment.name,
          file_data: `data:application/pdf;base64,${prepared.base64}`,
        })
        break
      case 'text': {
        const text = fileBlockText(attachment.name, prepared.text)
        built.chars += text.length
        parts.push({ type: 'input_text', text })
        break
      }
      case 'sandbox':
        try {
          let fileId = attachment.remote?.chatgpt
          if (!fileId) {
            const uploaded = await client.files.create(
              {
                file: await toFile(ctx.store.readAttachment(attachment), attachment.name, { type: attachment.mime }),
                purpose: 'user_data',
              },
              { signal: ctx.signal },
            )
            fileId = uploaded.id
            attachment.remote = { ...attachment.remote, chatgpt: fileId }
            built.uploadedNow = true
          }
          built.sandboxFileIds.push(fileId)
          parts.push({
            type: 'input_text',
            text: `[The file "${attachment.name}" is available in the code sandbox under /mnt/data.]`,
          })
        } catch (error) {
          parts.push({
            type: 'input_text',
            text: `[The file "${attachment.name}" could not be uploaded to the code sandbox: ${describeError(error)}]`,
          })
        }
        break
      case 'note':
        parts.push({ type: 'input_text', text: prepared.text })
        break
    }
  }
  return parts
}

async function buildInput(client: OpenAI, ctx: TurnContext): Promise<BuiltInput> {
  const built: BuiltInput = { items: [], sandboxFileIds: [], uploadedNow: false, chars: ctx.system.length }

  if (ctx.project && ctx.project.files.length > 0) {
    const parts = await attachmentParts(client, ctx, ctx.project.files, built)
    parts.push({ type: 'input_text', text: `These are the files of the project "${ctx.project.name}".` })
    built.items.push({ role: 'user', content: parts })
  }

  for (const message of ctx.history) {
    if (message.role === 'user') {
      const parts = await attachmentParts(client, ctx, message.attachments, built)
      if (message.text) {
        parts.push({ type: 'input_text', text: message.text })
        built.chars += message.text.length
      }
      if (parts.length > 0) built.items.push({ role: 'user', content: parts })
    } else if (message.text.trim()) {
      built.items.push({ role: 'assistant', content: message.text })
      built.chars += message.text.length
    }
  }
  return built
}

function buildTools(ctx: TurnContext, built: BuiltInput, containerId: string | undefined): Tool[] {
  const tools: Tool[] = []
  if (ctx.conversation.tools.webSearch) tools.push({ type: 'web_search' })
  if (ctx.conversation.tools.codeExec) {
    // Reuse the sandbox from earlier turns unless new files have to be loaded into a fresh one.
    const reuse = containerId && !built.uploadedNow
    tools.push({
      type: 'code_interpreter',
      container: reuse ? containerId : { type: 'auto', file_ids: built.sandboxFileIds },
    })
  }
  if (ctx.conversation.tools.imageGen) tools.push({ type: 'image_generation' })
  if (ctx.memoryEnabled) {
    tools.push({
      type: 'function',
      name: MEMORY_TOOL_NAME,
      description: MEMORY_TOOL_DESCRIPTION,
      strict: true,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The fact to remember, as one short sentence.' } },
        required: ['text'],
        additionalProperties: false,
      },
    })
  }
  return tools
}

export async function runOpenAITurn(ctx: TurnContext): Promise<TurnResult> {
  const client = openaiClient(ctx.apiKey)
  const model = ctx.conversation.model
  const meter = new LiveMeter(model, ctx.emit.usage)
  const log = new EventLog(ctx.emit.event)
  const citations: Citation[] = []
  const generated: Attachment[] = []
  let text = ''
  let thinking = ''
  let lastItem = ''
  let servedBy = model
  let containerId = ctx.conversation.containerId
  let containerChargedAt = ctx.conversation.containerChargedAt
  let error: string | undefined
  let useReasoning = true
  let interrupted = false

  const emitText = (delta: string): void => {
    text += delta
    ctx.emit.text(delta)
  }

  const downloadContainerFile = async (cid: string, fileId: string, name: string): Promise<void> => {
    try {
      const response = await client.containers.files.content.retrieve(fileId, { container_id: cid }, { signal: ctx.signal })
      const data = Buffer.from(await response.arrayBuffer())
      generated.push(ctx.store.saveAttachment(path.basename(name) || 'output', data))
    } catch {
      // The reply still makes sense without the file; it just cannot be shown.
    }
  }

  try {
    const built = await buildInput(client, ctx)
    const input: InputItem[] = [...built.items]

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const tools = buildTools(ctx, built, containerId)
      const include: Includable[] = []
      if (useReasoning) include.push('reasoning.encrypted_content')
      if (ctx.conversation.tools.codeExec) include.push('code_interpreter_call.outputs')

      meter.requestStarted(
        model,
        { inputTokens: estimateTokens(built.chars + text.length), cacheReadTokens: 0, cacheWriteTokens: 0 },
        false,
      )

      let final: ResponseObject | null = null
      try {
        const stream = await client.responses.create(
          {
            model,
            instructions: ctx.system,
            input,
            stream: true,
            store: false,
            prompt_cache_key: ctx.conversation.id.slice(0, 64),
            ...(tools.length > 0 ? { tools } : {}),
            ...(include.length > 0 ? { include } : {}),
            ...(useReasoning
              ? {
                  reasoning: {
                    summary: 'auto' as const,
                    ...(ctx.conversation.effort !== 'default' ? { effort: ctx.conversation.effort } : {}),
                  },
                }
              : {}),
          },
          { signal: ctx.signal },
        )

        for await (const event of stream) {
          switch (event.type) {
            case 'response.output_text.delta':
              emitText(event.delta)
              meter.outputChars(event.delta.length)
              break
            case 'response.reasoning_summary_part.added':
              if (thinking) {
                thinking += '\n\n'
                ctx.emit.thinking('\n\n')
              }
              break
            case 'response.reasoning_summary_text.delta':
              thinking += event.delta
              ctx.emit.thinking(event.delta)
              meter.outputChars(event.delta.length)
              break
            case 'response.output_item.added': {
              const item = event.item
              if (item.type === 'message') {
                if (text && lastItem !== 'message') emitText('\n\n')
              } else if (item.type === 'web_search_call') {
                log.upsert({ id: item.id, kind: 'web_search', title: 'Searching the web', status: 'running' })
              } else if (item.type === 'code_interpreter_call') {
                log.upsert({ id: item.id, kind: 'code', title: 'Running code', status: 'running' })
              } else if (item.type === 'image_generation_call') {
                log.upsert({ id: item.id, kind: 'image', title: 'Creating an image', status: 'running' })
              } else if (item.type === 'function_call' && item.name === MEMORY_TOOL_NAME) {
                log.upsert({ id: item.call_id, kind: 'memory', title: 'Saving to memory', status: 'running' })
              }
              lastItem = item.type
              break
            }
            case 'response.code_interpreter_call_code.delta':
              meter.outputChars(event.delta.length)
              break
            case 'response.code_interpreter_call_code.done':
              log.patch(event.item_id, { detail: event.code.slice(0, 20_000) })
              break
            case 'response.output_item.done': {
              const item = event.item
              if (item.type === 'web_search_call') {
                const action = item.action
                let detail: string | undefined
                if (action.type === 'search') {
                  detail = action.query ?? action.queries?.join(', ')
                  for (const source of action.sources ?? []) addCitation(citations, source.url, null)
                } else if (action.type === 'open_page') {
                  detail = action.url ?? undefined
                } else {
                  detail = `"${action.pattern}" in ${action.url}`
                }
                log.patch(item.id, {
                  status: item.status === 'failed' ? 'error' : 'done',
                  title: action.type === 'search' ? 'Searched the web' : 'Read a page',
                  detail,
                })
              } else if (item.type === 'code_interpreter_call') {
                const logs = (item.outputs ?? [])
                  .map((output) => (output.type === 'logs' ? output.logs : ''))
                  .filter(Boolean)
                  .join('\n')
                log.patch(item.id, {
                  status: item.status === 'failed' ? 'error' : 'done',
                  title: 'Ran code',
                  detail: item.code?.slice(0, 20_000) ?? undefined,
                  output: logs.slice(0, 20_000) || undefined,
                })
              } else if (item.type === 'image_generation_call') {
                if (item.result) {
                  generated.push(
                    ctx.store.saveAttachment(`image-${generated.length + 1}.png`, Buffer.from(item.result, 'base64')),
                  )
                  log.patch(item.id, { status: 'done', title: 'Created an image' })
                } else {
                  log.patch(item.id, { status: 'error' })
                }
              } else if (item.type === 'message') {
                for (const part of item.content) {
                  if (part.type !== 'output_text') continue
                  for (const annotation of part.annotations) {
                    if (annotation.type === 'url_citation') {
                      addCitation(citations, annotation.url, annotation.title)
                    } else if (annotation.type === 'container_file_citation') {
                      await downloadContainerFile(annotation.container_id, annotation.file_id, annotation.filename)
                    }
                  }
                }
              }
              break
            }
            case 'response.completed':
              final = event.response
              break
            case 'response.incomplete':
              final = event.response
              error =
                event.response.incomplete_details?.reason === 'content_filter'
                  ? 'The reply was stopped by the content filter.'
                  : 'The reply was cut off because it reached the length limit.'
              break
            case 'response.failed':
              throw new Error(event.response.error?.message ?? 'The request failed.')
            case 'error':
              throw new Error(event.message)
            default:
              break
          }
        }
      } catch (err) {
        if (err instanceof OpenAI.APIUserAbortError || ctx.signal.aborted) throw err
        const nothingShown = loop === 0 && !text
        // An expired sandbox id is rejected: start a fresh sandbox instead.
        if (nothingShown && containerId && (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError)) {
          containerId = undefined
          containerChargedAt = undefined
          loop -= 1
          continue
        }
        // Some models do not accept reasoning options: retry without them.
        if (nothingShown && useReasoning && err instanceof OpenAI.BadRequestError) {
          useReasoning = false
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
        throw err
      }

      if (!final) throw new Error('The connection closed before the reply finished.')
      servedBy = final.model

      // What the provider billed for this request.
      let feesUsd = 0
      let webSearches = 0
      for (const item of final.output) {
        if (item.type === 'web_search_call' && item.action.type === 'search') webSearches += 1
        if (item.type === 'code_interpreter_call') {
          const now = Date.now()
          const sessionMs = TOOL_FEES.openaiContainerMinutes * 60_000
          if (item.container_id !== containerId || !containerChargedAt || now - containerChargedAt > sessionMs) {
            feesUsd += TOOL_FEES.openaiContainerSession
            containerChargedAt = now
          }
          containerId = item.container_id
        }
      }
      const usage = final.usage
      if (usage) {
        const cached = usage.input_tokens_details?.cached_tokens ?? 0
        meter.requestFinished(
          final.model,
          {
            inputTokens: Math.max(0, usage.input_tokens - cached),
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
            outputTokens: usage.output_tokens,
          },
          { webSearches, feesUsd },
        )
      } else {
        interrupted = true
      }

      if (error) break

      const calls = final.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
      )
      if (calls.length === 0) break

      // Send the model's own items back with the tool results (stateless tool loop).
      input.push(...(final.output as unknown as InputItem[]))
      for (const call of calls) {
        let saved: string | null = null
        if (call.name === MEMORY_TOOL_NAME) {
          try {
            saved = memoryText(JSON.parse(call.arguments))
          } catch {
            saved = null
          }
        }
        if (saved) {
          ctx.store.addMemory(saved, 'chatgpt')
          log.patch(call.call_id, { status: 'done', title: 'Saved to memory', detail: saved })
          input.push({ type: 'function_call_output', call_id: call.call_id, output: 'Saved.' })
        } else {
          log.patch(call.call_id, { status: 'error' })
          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: 'Error: the arguments were not valid. Expected {"text": "..."}.',
          })
        }
      }
    }
  } catch (err) {
    log.finishRunning()
    const aborted = err instanceof OpenAI.APIUserAbortError || ctx.signal.aborted
    return {
      text,
      thinking,
      events: log.events,
      citations,
      generated,
      usage: meter.finish(true),
      model: servedBy,
      error: aborted ? 'Stopped.' : openaiErrorMessage(err),
      containerId,
      containerChargedAt,
    }
  }

  log.finishRunning()
  return {
    text,
    thinking,
    events: log.events,
    citations,
    generated,
    usage: meter.finish(interrupted),
    model: servedBy,
    error,
    containerId,
    containerChargedAt,
  }
}

export function openaiErrorMessage(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) return 'The OpenAI API key was rejected. Check it in Settings.'
  if (error instanceof OpenAI.PermissionDeniedError) return 'This API key is not allowed to use that model or feature.'
  if (error instanceof OpenAI.RateLimitError) {
    if (error.code === 'credit_balance_exhausted' || error.code === 'insufficient_quota') {
      return 'Your OpenAI API credit balance is used up. It refills at your next billing cycle, or you can add credits on the API platform.'
    }
    return 'OpenAI rate limit reached. Wait a moment and try again.'
  }
  if (error instanceof OpenAI.BadRequestError) return `OpenAI rejected the request: ${error.message}`
  if (error instanceof OpenAI.NotFoundError) return `OpenAI could not find that model or resource: ${error.message}`
  if (error instanceof OpenAI.APIConnectionError) return 'Could not reach OpenAI. Check your internet connection.'
  if (error instanceof OpenAI.APIError) return `OpenAI error ${error.status ?? ''}: ${error.message}`.trim()
  return describeError(error)
}

/** Names a chat from its first exchange, on the cheapest model. */
export async function openaiTitle(
  apiKey: string,
  userText: string,
  assistantText: string,
): Promise<{ title: string; usage: Usage } | null> {
  const model = UTILITY_MODEL.chatgpt
  const client = openaiClient(apiKey)
  const response = await client.responses.create({
    model,
    store: false,
    max_output_tokens: 400,
    instructions:
      'Write a title of at most six words for this conversation. Reply with the title only: no quotes, no trailing punctuation.',
    input: `User: ${userText.slice(0, 1500)}\n\nAssistant: ${assistantText.slice(0, 1500)}`,
  })
  const title = response.output_text.replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 80)
  if (!title) return null
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0
  const usage = addRequest(emptyUsage(model), model, {
    inputTokens: Math.max(0, (response.usage?.input_tokens ?? 0) - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  })
  return { title, usage: { ...usage, estimated: false } }
}
