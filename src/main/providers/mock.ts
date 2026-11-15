// Demo provider. It makes no network calls and costs nothing.
// Start the app with TWOFOLD_DEMO=1 to try the interface without API keys;
// the automated UI test uses it too.

import { estimateTokens } from '@shared/pricing'
import { EventLog, type TurnContext, type TurnResult } from './common'
import { LiveMeter } from './meter'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ARTIFACT = `Here is a small page you can open in the preview panel:

\`\`\`html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Demo counter</title>
<style>
  body { font: 16px system-ui; display: grid; place-items: center; height: 100vh; margin: 0; background: #f7f4ec; }
  button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 1px solid #c2571a; background: #c2571a; color: white; cursor: pointer; }
  p { text-align: center; }
</style>
</head>
<body>
  <div>
    <p>Clicked <strong id="n">0</strong> times</p>
    <button onclick="n.textContent = Number(n.textContent) + 1">Click me</button>
  </div>
</body>
</html>
\`\`\`

The panel on the right runs it in a sandbox.`

function reply(prompt: string, mode: string): string {
  if (/page|html|artifact|demo/i.test(prompt)) return ARTIFACT
  return (
    `This is **demo mode** in ${mode} mode, so no API call was made and nothing was charged.\n\n` +
    `You said:\n\n> ${prompt.slice(0, 300) || '(nothing)'}\n\n` +
    'With a real API key this reply would come from the model you picked, and the meter above ' +
    'would show what it cost:\n\n' +
    '1. Input tokens, billed when the request starts\n' +
    '2. Output tokens, counted as the answer streams\n' +
    '3. Tool fees, such as web searches\n\n' +
    '```ts\nconst total = input * inputRate + output * outputRate\n```\n'
  )
}

export async function runMockTurn(ctx: TurnContext): Promise<TurnResult> {
  const model = ctx.conversation.model
  const meter = new LiveMeter(model, ctx.emit.usage)
  const log = new EventLog(ctx.emit.event)
  const last = ctx.history[ctx.history.length - 1]
  const prompt = last?.text ?? ''
  const mode = ctx.conversation.provider === 'claude' ? 'Claude' : 'ChatGPT'
  const full = reply(prompt, mode)
  const historyChars = ctx.history.reduce((sum, m) => sum + m.text.length, 0) + ctx.system.length
  const inputTokens = estimateTokens(historyChars)
  let text = ''
  let thinking = ''

  meter.inputKnown(model, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })

  const thought = 'Demo mode: working out a canned reply.'
  for (const chunk of thought.match(/.{1,12}/g) ?? []) {
    if (ctx.signal.aborted) break
    thinking += chunk
    ctx.emit.thinking(chunk)
    meter.outputChars(chunk.length)
    await sleep(15)
  }

  if (ctx.conversation.tools.webSearch && !ctx.signal.aborted) {
    log.upsert({ id: 'demo-search', kind: 'web_search', title: 'Searching the web', status: 'running' })
    await sleep(250)
    log.patch('demo-search', { status: 'done', title: 'Searched the web', detail: prompt.slice(0, 80) })
  }

  for (const chunk of full.match(/[\s\S]{1,14}/g) ?? []) {
    if (ctx.signal.aborted) break
    text += chunk
    ctx.emit.text(chunk)
    meter.outputChars(chunk.length)
    await sleep(12)
  }

  if (ctx.signal.aborted) {
    return {
      text,
      thinking,
      events: log.events,
      citations: [],
      generated: [],
      usage: meter.finish(true),
      model,
      error: 'Stopped.',
    }
  }

  meter.requestFinished(
    model,
    {
      inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: estimateTokens(text.length + thinking.length),
    },
    { webSearches: ctx.conversation.tools.webSearch ? 1 : 0 },
  )
  return {
    text,
    thinking,
    events: log.events,
    citations: ctx.conversation.tools.webSearch ? [{ url: 'https://example.com/', title: 'Example source' }] : [],
    generated: [],
    usage: meter.finish(false),
    model,
  }
}
