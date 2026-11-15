// Gemini mode: one chat turn against Google's Gemini API.
//
// The conversation is sent with every request. Google Search and code
// execution run on Google's side; memory is a function the model can call,
// which runs here.

import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { Content, FunctionCall, GenerateContentResponse, Part, Tool } from '@google/genai'
import type { Attachment, Citation, Effort, Usage } from '@shared/types'
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

const MAX_LOOPS = 12
/** File types Gemini's code sandbox can read when they are sent inline. */
const SANDBOX_MIME = new Set(['text/csv', 'text/tab-separated-values'])

const THINKING_LEVEL: Record<Exclude<Effort, 'default'>, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
}

export function geminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey })
}

/** Checks a key with a free call. Returns the model ids the key can use. */
export async function verifyGeminiKey(apiKey: string): Promise<string[]> {
  const client = geminiClient(apiKey)
  const ids: string[] = []
  const pager = await client.models.list()
  for await (const model of pager) {
    if (model.name) ids.push(model.name.replace(/^models\//, ''))
    if (ids.length >= 500) break
  }
  return ids
}

interface Built {
  contents: Content[]
  chars: number
}

function attachmentParts(ctx: TurnContext, attachments: Attachment[] | undefined, built: Built): Part[] {
  const parts: Part[] = []
  for (const attachment of attachments ?? []) {
    const prepared = prepareAttachment(ctx.store, attachment, ctx.conversation.tools.codeExec)
    switch (prepared.type) {
      case 'image':
      case 'pdf':
        parts.push({ inlineData: { mimeType: attachment.mime, data: prepared.base64 } })
        break
      case 'text': {
        const text = fileBlockText(attachment.name, prepared.text)
        built.chars += text.length
        parts.push({ text })
        break
      }
      case 'sandbox':
        if (SANDBOX_MIME.has(attachment.mime)) {
          try {
            const data = ctx.store.readAttachment(attachment)
            parts.push({ inlineData: { mimeType: attachment.mime, data: data.toString('base64') } })
            parts.push({ text: `[The file "${attachment.name}" is attached for the code sandbox.]` })
          } catch {
            parts.push({ text: `[The file "${attachment.name}" is no longer on this computer.]` })
          }
        } else {
          parts.push({
            text: `[The file "${attachment.name}" was attached, but Gemini's code sandbox only reads CSV and TSV files. Ask the user to convert it.]`,
          })
        }
        break
      case 'note':
        parts.push({ text: prepared.text })
        break
    }
  }
  return parts
}

function buildContents(ctx: TurnContext): Built {
  const built: Built = { contents: [], chars: ctx.system.length }

  if (ctx.project && ctx.project.files.length > 0) {
    const parts = attachmentParts(ctx, ctx.project.files, built)
    parts.push({ text: `These are the files of the project "${ctx.project.name}".` })
    built.contents.push({ role: 'user', parts })
  }

  for (const message of ctx.history) {
    if (message.role === 'user') {
      const parts = attachmentParts(ctx, message.attachments, built)
      if (message.text) {
        parts.push({ text: message.text })
        built.chars += message.text.length
      }
      if (parts.length > 0) built.contents.push({ role: 'user', parts })
    } else if (message.text.trim()) {
      built.contents.push({ role: 'model', parts: [{ text: message.text }] })
      built.chars += message.text.length
    }
  }

  // The API expects the conversation to open with the user (imports can start otherwise).
  if (built.contents[0]?.role !== 'user') {
    built.contents.unshift({
      role: 'user',
      parts: [{ text: '(This conversation was imported; the first message is missing.)' }],
    })
  }
  return built
}

function buildTools(ctx: TurnContext, withMemory: boolean): Tool[] {
  const tools: Tool[] = []
  if (ctx.conversation.tools.webSearch) tools.push({ googleSearch: {} })
  if (ctx.conversation.tools.codeExec) tools.push({ codeExecution: {} })
  if (withMemory) {
    tools.push({
      functionDeclarations: [
        {
          name: MEMORY_TOOL_NAME,
          description: MEMORY_TOOL_DESCRIPTION,
          parametersJsonSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The fact to remember, as one short sentence.' } },
            required: ['text'],
          },
        },
      ],
    })
  }
  return tools
}

/** Token counts from one response, in the shape the price table uses. */
export function geminiTokens(usage: GenerateContentResponse['usageMetadata']): {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
} {
  const prompt = usage?.promptTokenCount ?? 0
  const cached = Math.min(usage?.cachedContentTokenCount ?? 0, prompt)
  return {
    // Tool results fed back to the model (search, code output) are billed as input.
    inputTokens: prompt - cached + (usage?.toolUsePromptTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    // Thinking tokens are billed at the output rate.
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  }
}

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'MODEL_ARMOR'])

export async function runGeminiTurn(ctx: TurnContext): Promise<TurnResult> {
  const client = geminiClient(ctx.apiKey)
  const model = ctx.conversation.model
  const meter = new LiveMeter(model, ctx.emit.usage)
  const log = new EventLog(ctx.emit.event)
  const citations: Citation[] = []
  const generated: Attachment[] = []
  const mixedTools = ctx.conversation.tools.webSearch || ctx.conversation.tools.codeExec
  let text = ''
  let thinking = ''
  let error: string | undefined
  let interrupted = false
  let withMemory = ctx.memoryEnabled
  let withThinking = true
  let searchesSoFar = 0
  let eventSeq = 0

  const emitText = (delta: string): void => {
    text += delta
    ctx.emit.text(delta)
  }

  try {
    const built = buildContents(ctx)
    const contents: Content[] = [...built.contents]

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const tools = buildTools(ctx, withMemory)
      const modelParts: Part[] = []
      const calls: FunctionCall[] = []
      let last: GenerateContentResponse | undefined
      let finishReason: string | undefined
      let inputReported = false
      let codeEvent: string | null = null
      let lastKind = ''

      meter.requestStarted(
        model,
        { inputTokens: estimateTokens(built.chars + text.length), cacheReadTokens: 0, cacheWriteTokens: 0 },
        false,
      )

      try {
        const stream = await client.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction: ctx.system,
            abortSignal: ctx.signal,
            ...(tools.length > 0 ? { tools } : {}),
            // Lets the model use Google's own tools and our memory function in one request.
            ...(withMemory && mixedTools ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
            ...(withThinking
              ? {
                  thinkingConfig: {
                    includeThoughts: true,
                    ...(ctx.conversation.effort !== 'default'
                      ? { thinkingLevel: THINKING_LEVEL[ctx.conversation.effort] }
                      : {}),
                  },
                }
              : {}),
          },
        })

        for await (const chunk of stream) {
          last = chunk
          if (chunk.usageMetadata?.promptTokenCount && !inputReported) {
            inputReported = true
            const tokens = geminiTokens(chunk.usageMetadata)
            meter.inputKnown(model, {
              inputTokens: tokens.inputTokens,
              cacheReadTokens: tokens.cacheReadTokens,
              cacheWriteTokens: 0,
            })
          }
          const candidate = chunk.candidates?.[0]
          if (candidate?.finishReason) finishReason = candidate.finishReason
          for (const part of candidate?.content?.parts ?? []) {
            modelParts.push(part)
            if (part.text) {
              if (part.thought) {
                if (thinking && lastKind !== 'thought') {
                  thinking += '\n\n'
                  ctx.emit.thinking('\n\n')
                }
                thinking += part.text
                ctx.emit.thinking(part.text)
                lastKind = 'thought'
              } else {
                if (text && lastKind !== 'text' && lastKind !== '') emitText('\n\n')
                emitText(part.text)
                lastKind = 'text'
              }
              meter.outputChars(part.text.length)
            } else if (part.executableCode) {
              codeEvent = `gemini-code-${++eventSeq}`
              log.upsert({
                id: codeEvent,
                kind: 'code',
                title: 'Running code',
                detail: (part.executableCode.code ?? '').slice(0, 20_000),
                status: 'running',
              })
              meter.outputChars(part.executableCode.code?.length ?? 0)
              lastKind = 'code'
            } else if (part.codeExecutionResult) {
              const ok = part.codeExecutionResult.outcome === 'OUTCOME_OK'
              if (codeEvent) {
                log.patch(codeEvent, {
                  status: ok ? 'done' : 'error',
                  title: 'Ran code',
                  output: (part.codeExecutionResult.output ?? '').slice(0, 20_000) || undefined,
                })
              }
              codeEvent = null
              lastKind = 'code'
            } else if (part.inlineData?.data) {
              // A chart or file the sandbox produced.
              const mime = part.inlineData.mimeType ?? 'image/png'
              const ext = mime.split('/')[1]?.split('+')[0]?.replace(/[^a-z0-9]/g, '') || 'png'
              generated.push(
                ctx.store.saveAttachment(`output-${generated.length + 1}.${ext}`, Buffer.from(part.inlineData.data, 'base64'), mime),
              )
              lastKind = 'file'
            } else if (part.functionCall) {
              calls.push(part.functionCall)
              if (part.functionCall.name === MEMORY_TOOL_NAME) {
                log.upsert({
                  id: part.functionCall.id ?? `gemini-memory-${calls.length}-${loop}`,
                  kind: 'memory',
                  title: 'Saving to memory',
                  status: 'running',
                })
              }
              lastKind = 'call'
            }
          }

          const grounding = candidate?.groundingMetadata
          if (grounding) {
            for (const source of grounding.groundingChunks ?? []) {
              if (source.web?.uri) addCitation(citations, source.web.uri, source.web.title ?? source.web.domain)
            }
            const queries = grounding.webSearchQueries ?? []
            if (queries.length > 0) {
              log.upsert({
                id: `gemini-search-${loop}`,
                kind: 'web_search',
                title: 'Searched the web',
                detail: queries.join('\n'),
                status: 'done',
              })
            }
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        const nothingShown = loop === 0 && !text
        const rejected = err instanceof ApiError && err.status === 400
        // Some models do not accept a function next to Google's own tools: drop memory for this turn.
        if (nothingShown && rejected && withMemory && mixedTools) {
          withMemory = false
          loop -= 1
          continue
        }
        // Some models do not accept thinking options: retry without them.
        if (nothingShown && rejected && withThinking) {
          withThinking = false
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

      if (!last) throw new Error('The connection closed before the reply finished.')

      // What Google billed for this request. Searches are free up to a monthly allowance.
      const searches = last.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0
      const freeLeft = Math.max(0, TOOL_FEES.geminiFreeSearchesPerMonth - ctx.searchesThisMonth - searchesSoFar)
      searchesSoFar += searches
      if (last.usageMetadata) {
        meter.requestFinished(model, geminiTokens(last.usageMetadata), {
          webSearches: searches,
          freeWebSearches: Math.min(searches, freeLeft),
        })
      } else {
        interrupted = true
      }

      const blockReason = last.promptFeedback?.blockReason
      if (blockReason) {
        error = `Gemini blocked this request (${blockReason}).`
        break
      }
      if (finishReason && BLOCKED_FINISH.has(finishReason)) {
        error = `Gemini stopped the reply (${finishReason.toLowerCase().replace(/_/g, ' ')}).`
        break
      }
      if (finishReason === 'MAX_TOKENS') {
        error = 'The reply was cut off because it reached the length limit.'
        break
      }
      if (calls.length === 0) break

      // Send the model's own parts back unchanged (they carry its thought signatures), then the results.
      contents.push({ role: 'model', parts: modelParts })
      const results: Part[] = []
      calls.forEach((call, index) => {
        const eventId = call.id ?? `gemini-memory-${index + 1}-${loop}`
        const saved = call.name === MEMORY_TOOL_NAME ? memoryText(call.args) : null
        if (saved) {
          ctx.store.addMemory(saved, 'gemini')
          log.patch(eventId, { status: 'done', title: 'Saved to memory', detail: saved })
        } else {
          log.patch(eventId, { status: 'error' })
        }
        results.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: saved ? { result: 'Saved.' } : { error: 'Invalid arguments. Expected {"text": "..."}.' },
          },
        })
      })
      contents.push({ role: 'user', parts: results })
    }
  } catch (err) {
    log.finishRunning()
    return {
      text,
      thinking,
      events: log.events,
      citations,
      generated,
      usage: meter.finish(true),
      model,
      error: ctx.signal.aborted ? 'Stopped.' : geminiErrorMessage(err),
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
    model,
    error,
  }
}

export function geminiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message
    if (error.status === 400 && /api key/i.test(message)) return 'The Gemini API key was rejected. Check it in Settings.'
    if (error.status === 401 || error.status === 403) {
      return 'This Gemini API key is not allowed to use that model or feature.'
    }
    if (error.status === 429) {
      return 'Gemini quota reached. Free-tier limits are low; set up billing in Google AI Studio to use your plan credits, or wait and try again.'
    }
    if (error.status === 404) return `Gemini could not find that model: ${message}`
    if (error.status === 400) return `Gemini rejected the request: ${message}`
    return `Gemini error ${error.status}: ${message}`
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return 'Could not reach Google. Check your internet connection.'
  }
  return describeError(error)
}

/** Names a chat from its first exchange, on the cheapest model. */
export async function geminiTitle(
  apiKey: string,
  userText: string,
  assistantText: string,
): Promise<{ title: string; usage: Usage } | null> {
  const model = UTILITY_MODEL.gemini
  const client = geminiClient(apiKey)
  const response = await client.models.generateContent({
    model,
    contents: `User: ${userText.slice(0, 1500)}\n\nAssistant: ${assistantText.slice(0, 1500)}`,
    config: {
      systemInstruction:
        'Write a title of at most six words for this conversation. Reply with the title only: no quotes, no trailing punctuation.',
      maxOutputTokens: 400,
    },
  })
  const title = (response.text ?? '').replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 80)
  if (!title) return null
  const usage = addRequest(emptyUsage(model), model, geminiTokens(response.usageMetadata))
  return { title, usage: { ...usage, estimated: false } }
}
