// ChatGPT mode coding agent: a tool loop on the OpenAI Responses API.
//
// OpenAI's subscriber API credits do not cover Codex, so this is a plain API
// agent with Threefold's own small tool set (read, search, write, edit, run).
// Reading is automatic; anything that changes files or runs a command asks first.

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { tokenCost } from '@shared/pricing'
import { openaiClient, openaiErrorMessage } from '../providers/openai'
import { INSTRUCTIONS, MAX_STEPS, TOOL_SPECS, runToolCall } from './agentTools'
import type { AgentContext, AgentResult } from './service'

type InputItem = OpenAI.Responses.ResponseInputItem
type FunctionTool = OpenAI.Responses.FunctionTool

// Strict mode wants every property listed as required, so optional ones are nullable instead.
const TOOLS: FunctionTool[] = TOOL_SPECS.map((spec) => ({
  type: 'function',
  name: spec.name,
  description: spec.description,
  strict: true,
  parameters: {
    type: 'object',
    properties: spec.properties,
    required: Object.keys(spec.properties),
    additionalProperties: false,
  },
}))

export async function runOpenAIAgent(ctx: AgentContext): Promise<AgentResult> {
  const client = openaiClient(ctx.apiKey)
  const input: InputItem[] = Array.isArray(ctx.session.replay) ? (ctx.session.replay as InputItem[]) : []
  input.push({ role: 'user', content: ctx.prompt })

  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let error: string | undefined
  let useReasoning = true

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let final: OpenAI.Responses.Response | null = null
      let textItem: string | null = null
      let thinkingItem: string | null = null

      try {
        const stream = await client.responses.create(
          {
            model: ctx.session.model,
            instructions: INSTRUCTIONS,
            input,
            tools: TOOLS,
            stream: true,
            store: false,
            prompt_cache_key: ctx.session.id.slice(0, 64),
            ...(useReasoning ? { include: ['reasoning.encrypted_content' as const], reasoning: { summary: 'auto' as const } } : {}),
          },
          { signal: ctx.signal },
        )
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            if (!textItem) {
              textItem = randomUUID()
              ctx.emit.item({ id: textItem, type: 'text', text: '' })
            }
            ctx.emit.delta(textItem, 'text', event.delta)
          } else if (event.type === 'response.reasoning_summary_text.delta') {
            if (!thinkingItem) {
              thinkingItem = randomUUID()
              ctx.emit.item({ id: thinkingItem, type: 'thinking', text: '' })
            }
            ctx.emit.delta(thinkingItem, 'thinking', event.delta)
          } else if (event.type === 'response.output_item.added') {
            if (event.item.type === 'message') textItem = null
            if (event.item.type === 'reasoning') thinkingItem = null
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            final = event.response
          } else if (event.type === 'response.failed') {
            throw new Error(event.response.error?.message ?? 'The request failed.')
          } else if (event.type === 'error') {
            throw new Error(event.message)
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        if (step === 0 && useReasoning && err instanceof OpenAI.BadRequestError) {
          useReasoning = false
          step -= 1
          continue
        }
        throw err
      }

      if (!final) throw new Error('The connection closed before the reply finished.')
      if (final.usage) {
        const cached = final.usage.input_tokens_details?.cached_tokens ?? 0
        const cost = tokenCost(final.model, {
          inputTokens: Math.max(0, final.usage.input_tokens - cached),
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: final.usage.output_tokens,
        })
        costUsd += cost ?? 0
        inputTokens += final.usage.input_tokens
        outputTokens += final.usage.output_tokens
        ctx.emit.cost(costUsd, false)
      }

      input.push(...(final.output as unknown as InputItem[]))
      const calls = final.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
      )
      if (calls.length === 0) break
      if (step === MAX_STEPS - 1) error = 'The agent stopped because it reached its step limit.'

      for (const call of calls) {
        let parsed: unknown
        try {
          parsed = JSON.parse(call.arguments || '{}')
        } catch {
          parsed = null
        }
        const { output } = await runToolCall(ctx, call.call_id, call.name, parsed)
        input.push({ type: 'function_call_output', call_id: call.call_id, output })
        if (ctx.signal.aborted) throw new Error('aborted')
      }
    }
  } catch (err) {
    error = ctx.signal.aborted ? 'Stopped.' : openaiErrorMessage(err)
  }

  // Keep the transcript for the next prompt, unless a tool call was left unanswered.
  const answered = new Set(
    input.filter((item) => 'type' in item && item.type === 'function_call_output').map((item) => (item as { call_id: string }).call_id),
  )
  const complete = input.every(
    (item) => !('type' in item) || item.type !== 'function_call' || answered.has((item as { call_id: string }).call_id),
  )
  if (complete) ctx.session.replay = input

  return { costUsd, inputTokens, outputTokens, error, estimated: false }
}
