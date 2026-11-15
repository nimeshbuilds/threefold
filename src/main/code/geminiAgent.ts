// Gemini mode coding agent: a tool loop on the Gemini API with Threefold's own
// file and shell tools. Reading is automatic; anything that changes files or
// runs a command asks first.

import { randomUUID } from 'node:crypto'
import { ApiError } from '@google/genai'
import type { Content, FunctionCall, FunctionDeclaration, GenerateContentResponse, Part } from '@google/genai'
import { tokenCost } from '@shared/pricing'
import { geminiClient, geminiErrorMessage, geminiTokens } from '../providers/gemini'
import { INSTRUCTIONS, MAX_STEPS, TOOL_SPECS, runToolCall } from './agentTools'
import type { AgentContext, AgentResult } from './service'

const DECLARATIONS: FunctionDeclaration[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parametersJsonSchema: { type: 'object', properties: spec.properties, required: spec.needed },
}))

export async function runGeminiAgent(ctx: AgentContext): Promise<AgentResult> {
  const client = geminiClient(ctx.apiKey)
  const contents: Content[] = Array.isArray(ctx.session.replay) ? (ctx.session.replay as Content[]) : []
  contents.push({ role: 'user', parts: [{ text: ctx.prompt }] })

  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let error: string | undefined
  let withThinking = true
  let unanswered = false

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const modelParts: Part[] = []
      const calls: FunctionCall[] = []
      let last: GenerateContentResponse | undefined
      let textItem: string | null = null
      let thinkingItem: string | null = null

      try {
        const stream = await client.models.generateContentStream({
          model: ctx.session.model,
          contents,
          config: {
            systemInstruction: INSTRUCTIONS,
            abortSignal: ctx.signal,
            tools: [{ functionDeclarations: DECLARATIONS }],
            ...(withThinking ? { thinkingConfig: { includeThoughts: true } } : {}),
          },
        })
        for await (const chunk of stream) {
          last = chunk
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            modelParts.push(part)
            if (part.text && part.thought) {
              if (!thinkingItem) {
                thinkingItem = randomUUID()
                ctx.emit.item({ id: thinkingItem, type: 'thinking', text: '' })
              }
              ctx.emit.delta(thinkingItem, 'thinking', part.text)
            } else if (part.text) {
              if (!textItem) {
                textItem = randomUUID()
                ctx.emit.item({ id: textItem, type: 'text', text: '' })
              }
              ctx.emit.delta(textItem, 'text', part.text)
            } else if (part.functionCall) {
              calls.push(part.functionCall)
            }
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        if (step === 0 && withThinking && err instanceof ApiError && err.status === 400) {
          withThinking = false
          step -= 1
          continue
        }
        throw err
      }

      if (!last) throw new Error('The connection closed before the reply finished.')
      if (last.usageMetadata) {
        const tokens = geminiTokens(last.usageMetadata)
        costUsd += tokenCost(ctx.session.model, tokens) ?? 0
        inputTokens += tokens.inputTokens + tokens.cacheReadTokens
        outputTokens += tokens.outputTokens
        ctx.emit.cost(costUsd, false)
      }

      // The model's parts go back unchanged; they carry its thought signatures.
      contents.push({ role: 'model', parts: modelParts })
      if (calls.length === 0) break
      if (step === MAX_STEPS - 1) error = 'The agent stopped because it reached its step limit.'

      const results: Part[] = []
      unanswered = true
      for (const call of calls) {
        const { output } = await runToolCall(ctx, call.id ?? randomUUID(), call.name ?? '', call.args ?? {})
        results.push({
          functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: { result: output } },
        })
        if (ctx.signal.aborted) throw new Error('aborted')
      }
      contents.push({ role: 'user', parts: results })
      unanswered = false
    }
  } catch (err) {
    error = ctx.signal.aborted ? 'Stopped.' : geminiErrorMessage(err)
  }

  // Keep the transcript for the next prompt, unless a tool call was left unanswered.
  if (!unanswered) ctx.session.replay = contents
  return { costUsd, inputTokens, outputTokens, error, estimated: false }
}
