// Gemini mode: one chat turn against Google's Gemini API.
//
// The conversation is sent with every request. Google Search, URL reading and
// code execution run on Google's side; memory and image generation are
// functions the model can call, which run here. Deep research is a separate
// agent on Google's Interactions API and is handled by runGeminiResearch.

import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { Content, FunctionCall, FunctionDeclaration, GenerateContentResponse, Part, Tool } from '@google/genai'
import type { Attachment, Citation, Effort, Usage } from '@shared/types'
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_RESEARCH_AGENT,
  TOOL_FEES,
  UTILITY_MODEL,
  addRequest,
  emptyUsage,
  estimateTokens,
  imageCost,
} from '@shared/pricing'
import {
  EventLog,
  IMAGE_TOOL_DESCRIPTION,
  IMAGE_TOOL_NAME,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  addCitation,
  describeError,
  fileBlockText,
  imagePrompt,
  isResearch,
  memoryText,
  prepareAttachment,
  type TurnContext,
  type TurnResult,
} from './common'
import { LiveMeter } from './meter'

const MAX_LOOPS = 12
/** File types Gemini's code sandbox can read when they are sent inline. */
const SANDBOX_MIME = new Set(['text/csv', 'text/tab-separated-values'])
/** How often a running research task is checked, and how long it may run (Google's own cap is 60 minutes). */
const RESEARCH_POLL_MS = 6000
const RESEARCH_MAX_MS = 65 * 60_000
const MAX_TRANSCRIPT_CHARS = 24_000

const THINKING_LEVEL: Record<Exclude<Effort, 'default'>, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
}

export function geminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey })
}

/** Client for the Interactions API (deep research, image generation), which lives on the v1beta endpoint. */
function interactionsClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } })
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

/** The functions that run on this computer: memory, and image generation when it is switched on. */
function localFunctions(ctx: TurnContext): FunctionDeclaration[] {
  const functions: FunctionDeclaration[] = []
  if (ctx.memoryEnabled) {
    functions.push({
      name: MEMORY_TOOL_NAME,
      description: MEMORY_TOOL_DESCRIPTION,
      parametersJsonSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The fact to remember, as one short sentence.' } },
        required: ['text'],
      },
    })
  }
  if (ctx.conversation.tools.imageGen) {
    functions.push({
      name: IMAGE_TOOL_NAME,
      description: IMAGE_TOOL_DESCRIPTION,
      parametersJsonSchema: {
        type: 'object',
        properties: { prompt: { type: 'string', description: 'A detailed description of the image to create.' } },
        required: ['prompt'],
      },
    })
  }
  return functions
}

function buildTools(ctx: TurnContext, functions: FunctionDeclaration[]): Tool[] {
  const tools: Tool[] = []
  if (ctx.conversation.tools.webSearch) {
    tools.push({ googleSearch: {} })
    // Lets the model open the pages it finds, or a link the user pasted. Billed as input tokens only.
    tools.push({ urlContext: {} })
  }
  if (ctx.conversation.tools.codeExec) tools.push({ codeExecution: {} })
  if (functions.length > 0) tools.push({ functionDeclarations: functions })
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

/** The usage block of an Interactions API result (deep research, image generation). */
export interface InteractionUsage {
  total_input_tokens?: number
  total_cached_tokens?: number
  total_output_tokens?: number
  total_thought_tokens?: number
  total_tool_use_tokens?: number
  output_tokens_by_modality?: Array<{ modality?: string; tokens?: number }>
  grounding_tool_count?: Array<{ type?: string; count?: number }>
}

/** Token counts from an Interactions API result, in the shape the price table uses. */
export function interactionTokens(usage: InteractionUsage | undefined): {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  searches: number
  imageOutputTokens: number
} {
  const input = usage?.total_input_tokens ?? 0
  const cached = Math.min(usage?.total_cached_tokens ?? 0, input)
  const imageOutputTokens = (usage?.output_tokens_by_modality ?? [])
    .filter((entry) => entry.modality === 'image')
    .reduce((sum, entry) => sum + (entry.tokens ?? 0), 0)
  return {
    inputTokens: input - cached + (usage?.total_tool_use_tokens ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0),
    searches: (usage?.grounding_tool_count ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0),
    imageOutputTokens,
  }
}

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'MODEL_ARMOR'])

/** Creates one image with Gemini's image model. Returns the saved file and what the request cost. */
async function generateImage(
  ctx: TurnContext,
  prompt: string,
  index: number,
): Promise<{ file: Attachment; costUsd: number }> {
  const client = interactionsClient(ctx.apiKey)
  const interaction = await client.interactions.create({ model: GEMINI_IMAGE_MODEL, input: prompt, store: false })
  const image = interaction.output_image
  if (!image?.data) throw new Error('The image model returned no image.')
  const mime = image.mime_type ?? 'image/png'
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png'
  const file = ctx.store.saveAttachment(`image-${index}.${ext}`, Buffer.from(image.data, 'base64'), mime)
  const tokens = interactionTokens(interaction.usage as InteractionUsage | undefined)
  const costUsd =
    imageCost(GEMINI_IMAGE_MODEL, {
      inputTokens: tokens.inputTokens + tokens.cacheReadTokens,
      textOutputTokens: Math.max(0, tokens.outputTokens - tokens.imageOutputTokens),
      imageOutputTokens: tokens.imageOutputTokens,
    }) ?? 0
  return { file, costUsd }
}

/** The request as one block of text, with the earlier conversation for context. */
function researchInput(ctx: TurnContext): string {
  const latest = ctx.history[ctx.history.length - 1]
  const earlier = ctx.history
    .slice(0, -1)
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n')
  const parts: string[] = []
  if (earlier) {
    parts.push(
      `Conversation so far:\n${earlier.length > MAX_TRANSCRIPT_CHARS ? '…' + earlier.slice(-MAX_TRANSCRIPT_CHARS) : earlier}`,
    )
  }
  for (const attachment of latest?.attachments ?? []) {
    const prepared = prepareAttachment(ctx.store, attachment, false)
    if (prepared.type === 'text') parts.push(fileBlockText(attachment.name, prepared.text))
    else parts.push(`[The file "${attachment.name}" was attached but cannot be passed to the research agent.]`)
  }
  parts.push(`Research request:\n${latest?.text ?? ''}`)
  if (ctx.project?.instructions.trim()) parts.push(`Instructions for this project:\n${ctx.project.instructions.trim()}`)
  return parts.join('\n\n')
}

function minutes(ms: number): string {
  const total = Math.floor(ms / 60_000)
  return total < 1 ? 'under a minute' : `${total} min`
}

/**
 * Deep research on Gemini: Google's Deep Research agent, run in the background
 * on the Interactions API and checked until it finishes. A run usually takes
 * several minutes; Google estimates one to three dollars per run.
 */
export async function runGeminiResearch(ctx: TurnContext): Promise<TurnResult> {
  const client = interactionsClient(ctx.apiKey)
  const meter = new LiveMeter(GEMINI_RESEARCH_AGENT, ctx.emit.usage)
  const log = new EventLog(ctx.emit.event)
  const started = Date.now()
  let id: string | undefined

  const fail = (error: string): TurnResult => {
    log.finishRunning()
    return {
      text: '',
      thinking: '',
      events: log.events,
      citations: [],
      generated: [],
      usage: meter.finish(true),
      model: GEMINI_RESEARCH_AGENT,
      error,
    }
  }

  log.upsert({
    id: 'research',
    kind: 'research',
    title: 'Deep research',
    detail: "Google's Deep Research agent is planning, searching and reading. This usually takes several minutes.",
    status: 'running',
  })

  try {
    const created = await client.interactions.create({
      agent: GEMINI_RESEARCH_AGENT,
      input: researchInput(ctx),
      // The agent only runs in the background, and background runs must be stored on Google's side.
      background: true,
      store: true,
      agent_config: { type: 'deep-research', thinking_summaries: 'auto' },
    })
    id = created.id
    let interaction = created

    while (interaction.status === 'queued' || interaction.status === 'in_progress') {
      if (ctx.signal.aborted) break
      if (Date.now() - started > RESEARCH_MAX_MS) {
        void client.interactions.cancel(id).catch(() => {})
        return fail('The research run took longer than an hour and was stopped.')
      }
      await new Promise((resolve) => setTimeout(resolve, RESEARCH_POLL_MS))
      if (ctx.signal.aborted) break
      interaction = await client.interactions.get(id)
      log.patch('research', { title: `Deep research · ${minutes(Date.now() - started)}` })
    }

    if (ctx.signal.aborted) {
      // Stop the run on Google's side too, or it would keep going and keep costing.
      void client.interactions.cancel(id).catch(() => {})
      return fail('Stopped.')
    }

    const tokens = interactionTokens(interaction.usage as InteractionUsage | undefined)
    const freeLeft = Math.max(0, TOOL_FEES.geminiFreeSearchesPerMonth - ctx.searchesThisMonth)
    meter.requestFinished(GEMINI_RESEARCH_AGENT, tokens, {
      webSearches: tokens.searches,
      freeWebSearches: Math.min(tokens.searches, freeLeft),
    })

    if (interaction.status !== 'completed') {
      const reason = interaction.errors?.map((e) => (e as { message?: string }).message).filter(Boolean).join('; ')
      return fail(`The research run ended as "${interaction.status}"${reason ? `: ${reason}` : ''}.`)
    }

    const text = interaction.output_text ?? ''
    if (!text.trim()) return fail('The research agent finished without a report.')
    ctx.emit.text(text)
    log.patch('research', { status: 'done', title: `Deep research · ${minutes(Date.now() - started)}` })
    log.finishRunning()
    return {
      text,
      thinking: '',
      events: log.events,
      citations: [],
      generated: [],
      // Google does not publish which model the agent runs on, so the figure is an estimate.
      usage: { ...meter.finish(false), estimated: true },
      model: GEMINI_RESEARCH_AGENT,
    }
  } catch (err) {
    if (id && ctx.signal.aborted) void client.interactions.cancel(id).catch(() => {})
    return fail(ctx.signal.aborted ? 'Stopped.' : geminiErrorMessage(err))
  }
}

export async function runGeminiTurn(ctx: TurnContext): Promise<TurnResult> {
  if (isResearch(ctx.history)) return runGeminiResearch(ctx)

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
  let withFunctions = true
  let withThinking = true
  let searchesSoFar = 0
  let eventSeq = 0
  let imagesMade = 0

  const emitText = (delta: string): void => {
    text += delta
    ctx.emit.text(delta)
  }
  const callEventId = (call: FunctionCall, index: number, loop: number): string =>
    call.id ?? `gemini-call-${index + 1}-${loop}`

  try {
    const built = buildContents(ctx)
    const contents: Content[] = [...built.contents]

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const functions = withFunctions ? localFunctions(ctx) : []
      const tools = buildTools(ctx, functions)
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
            // Lets the model use Google's own tools and our functions in one request.
            ...(functions.length > 0 && mixedTools ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
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
              const call = part.functionCall
              const eventId = callEventId(call, calls.length, loop)
              calls.push(call)
              if (call.name === MEMORY_TOOL_NAME) {
                log.upsert({ id: eventId, kind: 'memory', title: 'Saving to memory', status: 'running' })
              } else if (call.name === IMAGE_TOOL_NAME) {
                log.upsert({ id: eventId, kind: 'image', title: 'Creating an image', status: 'running' })
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
        // Some models do not accept functions next to Google's own tools: drop ours for this turn.
        if (nothingShown && rejected && withFunctions && functions.length > 0 && mixedTools) {
          withFunctions = false
          log.upsert({
            id: 'no-functions',
            kind: 'notice',
            title: 'Memory and image creation are off for this reply',
            detail: 'This model does not accept them together with web search or code execution. Turn those off to use them.',
            status: 'done',
          })
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
      for (const [index, call] of calls.entries()) {
        const eventId = callEventId(call, index, loop)
        let response: Record<string, unknown>
        if (call.name === MEMORY_TOOL_NAME) {
          const saved = memoryText(call.args)
          if (saved) {
            ctx.store.addMemory(saved, 'gemini')
            log.patch(eventId, { status: 'done', title: 'Saved to memory', detail: saved })
            response = { result: 'Saved.' }
          } else {
            log.patch(eventId, { status: 'error' })
            response = { error: 'Invalid arguments. Expected {"text": "..."}.' }
          }
        } else if (call.name === IMAGE_TOOL_NAME) {
          const prompt = imagePrompt(call.args)
          if (!prompt) {
            log.patch(eventId, { status: 'error' })
            response = { error: 'Invalid arguments. Expected {"prompt": "..."}.' }
          } else {
            try {
              const image = await generateImage(ctx, prompt, ++imagesMade)
              generated.push(image.file)
              meter.addFee(image.costUsd)
              log.patch(eventId, { status: 'done', title: 'Created an image', detail: prompt })
              response = { result: 'The image was created and is shown to the user below your reply. Do not describe it at length.' }
            } catch (imageError) {
              log.patch(eventId, { status: 'error', output: geminiErrorMessage(imageError) })
              response = { error: `Image generation failed: ${geminiErrorMessage(imageError)}` }
            }
          }
        } else {
          response = { error: `Unknown function "${call.name ?? ''}".` }
        }
        results.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } })
        if (ctx.signal.aborted) throw new Error('aborted')
      }
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
