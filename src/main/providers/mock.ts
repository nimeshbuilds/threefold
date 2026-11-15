// Demo provider. It makes no network calls and costs nothing.
// Start the app with THREEFOLD_DEMO=1 to try the interface without API keys;
// the automated UI test uses it too.

import zlib from 'node:zlib'
import { IMAGE_PROVIDERS, type Attachment } from '@shared/types'
import { estimateTokens } from '@shared/pricing'
import { REVIEWER_SYSTEM, REVISION_OPENING } from '../panel'
import { EventLog, isResearch, type TurnContext, type TurnResult } from './common'
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

const REVIEW = `Mostly right. Two things to fix:

1. The second step skips an edge case: say what happens when the list is empty.
2. The closing claim is stronger than the evidence given. Soften it or add a source.`

const FINAL = `Here is the **final answer**, revised after review (demo mode, so nothing was charged).

- The empty-list case is now covered.
- The closing claim is stated with the right amount of confidence.

In a real Threefold chat this text comes from your answering model, after it has read every review.`

const REPORT = `## Summary

This is a **demo research report**, so no searches were run and nothing was charged.

## Findings

1. With a real key, this section holds what the model found, with specific facts, figures and dates.
2. Every claim carries an inline citation, like this one [example.com](https://example.com/).
3. Anything that could not be confirmed is called out plainly.

## What a real run does

A deep research run plans its questions, searches widely, reads primary sources and cross-checks them before writing. It usually takes several minutes and costs more than a normal message.`

const REVIEW_OF_REPORT = `The report is sound overall. Two things to fix:

1. Finding 2 rests on a single source. Add a second, independent one.
2. The summary states a figure that the findings do not support. Correct it or cite it.`

/** A small solid-colour PNG, standing in for a generated image in demo mode. */
function demoPng(): Buffer {
  const size = 96
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) row.set([0xc2, 0x57, 0x1a], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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
  const mode = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }[ctx.conversation.provider]
  const research = isResearch(ctx.history)
  const reviewing = ctx.system.startsWith(REVIEWER_SYSTEM)
  const wantsImage =
    ctx.conversation.tools.imageGen && IMAGE_PROVIDERS.includes(ctx.conversation.provider) && /image|picture|draw|logo/i.test(prompt)
  const generated: Attachment[] = []
  const full = reviewing
    ? ctx.system === REVIEWER_SYSTEM
      ? REVIEW
      : REVIEW_OF_REPORT
    : prompt.startsWith(REVISION_OPENING)
      ? FINAL
      : research
        ? REPORT
        : wantsImage
          ? 'Here is the image you asked for (a plain placeholder, because this is demo mode).'
          : reply(prompt, mode)
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

  if (research && !ctx.signal.aborted) {
    log.upsert({ id: 'research', kind: 'research', title: 'Deep research', detail: 'Demo run: nothing is searched.', status: 'running' })
    await sleep(350)
    log.patch('research', { status: 'done', title: 'Deep research · under a minute' })
  }

  if ((ctx.conversation.tools.webSearch || research) && !ctx.signal.aborted) {
    log.upsert({ id: 'demo-search', kind: 'web_search', title: 'Searching the web', status: 'running' })
    await sleep(250)
    log.patch('demo-search', { status: 'done', title: 'Searched the web', detail: prompt.slice(0, 80) })
  }

  if (wantsImage && !ctx.signal.aborted) {
    log.upsert({ id: 'demo-image', kind: 'image', title: 'Creating an image', status: 'running' })
    await sleep(250)
    generated.push(ctx.store.saveAttachment('demo-image.png', demoPng()))
    log.patch('demo-image', { status: 'done', title: 'Created an image', detail: prompt.slice(0, 120) })
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
    { webSearches: ctx.conversation.tools.webSearch || research ? 1 : 0 },
  )
  return {
    text,
    thinking,
    events: log.events,
    citations:
      ctx.conversation.tools.webSearch || research ? [{ url: 'https://example.com/', title: 'Example source' }] : [],
    generated,
    usage: meter.finish(false),
    model,
  }
}
