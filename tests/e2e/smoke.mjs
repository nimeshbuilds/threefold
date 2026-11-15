// End-to-end check of the real app in demo mode (no API keys, no network, no cost).
// Usage: pnpm build && node tests/e2e/smoke.mjs [screenshot-dir]
// Set THREEFOLD_APP to a packaged binary (dist/mac-arm64/Threefold.app/Contents/MacOS/Threefold)
// to run the same checks against the packaged app.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.argv[2] ?? 'tests/e2e/screenshots')
fs.mkdirSync(shots, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-e2e-'))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const packaged = process.env.THREEFOLD_APP
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }),
  env: { ...process.env, THREEFOLD_DEMO: '1', THREEFOLD_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })

try {
  // ---- first-run wizard ----
  await page.waitForSelector('.onboarding', { timeout: 15000 })
  check('wizard opens on first run', true)
  await page.fill('.welcome input', 'Sam')
  await shot('01-welcome')
  await page.click('.onboarding-foot .btn.primary')
  await page.waitForSelector('.key-setup')
  check('Claude key step shows three numbered steps', (await page.locator('.key-setup .steps li').count()) === 3)
  await shot('02-key-setup')
  await page.click('.onboarding-foot .btn.primary')
  await page.click('.onboarding-foot .btn.primary')
  await page.waitForSelector('.key-setup h3:has-text("Gemini mode")')
  check('wizard has a Gemini step', true)
  await page.click('.onboarding-foot .btn.primary')
  await page.waitForSelector('.credit-fields')
  check('credits step covers all three providers', (await page.locator('.credit-fields').count()) === 3)
  await page.locator('.credit-fields').first().locator('.seg button', { hasText: '$200' }).click()
  await shot('03-credits')
  await page.click('.onboarding-foot .btn.primary')
  await page.click('.onboarding-foot .btn.primary')
  await page.waitForSelector('.onboarding', { state: 'detached' })

  // ---- Claude mode: empty state ----
  await page.waitForSelector('.empty h1')
  const greeting = await page.textContent('.empty h1')
  check('greeting uses the name from the wizard', /Sam/.test(greeting ?? ''), greeting ?? '')
  check('starts in Claude mode', (await page.getAttribute('html', 'data-mode')) === 'claude')
  check('meter shows the $200 credit grant', /\$200/.test((await page.textContent('.meter')) ?? ''))
  await shot('04-claude-empty')

  // ---- send a message and watch the cost move ----
  await page.fill('.composer textarea', 'Explain what the cost meter shows')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming')
  await page.waitForFunction(() => /≈/.test(document.querySelector('.cost-chip')?.textContent ?? ''), null, { timeout: 8000 })
  const liveChip = await page.textContent('.cost-chip')
  check('chat cost shows a live estimate while streaming', /≈ \$/.test(liveChip ?? ''), liveChip ?? '')
  check('sidebar meter is live while streaming', (await page.locator('.meter .dot').count()) === 1)
  await shot('05-claude-streaming')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  const finalChip = await page.textContent('.cost-chip')
  check('chat cost settles to an exact figure', /This chat \$\d/.test(finalChip ?? '') && !/≈/.test(finalChip ?? ''), finalChip ?? '')
  const usageLine = await page.textContent('.msg.assistant .usage-line')
  check('reply shows model, tokens and cost', /Claude Opus 5\.5/.test(usageLine ?? '') && /in ·/.test(usageLine ?? ''), usageLine ?? '')
  check('reply rendered markdown with a code block', (await page.locator('.msg.assistant .code-block').count()) >= 1)
  check('chat appears in the sidebar', (await page.locator('.chat-row').count()) === 1)
  const meterAfter = await page.textContent('.meter')
  check('meter counts the finished turn', !/\$0\.00 /.test(meterAfter ?? ''), meterAfter ?? '')
  await shot('06-claude-reply')

  // ---- artifact panel ----
  await page.fill('.composer textarea', 'Make me a demo page')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.artifact-card', { timeout: 15000 })
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  await page.click('.artifact-card')
  await page.waitForSelector('.artifact-frame')
  const frame = page.frameLocator('.artifact-frame')
  // Wait for each click to register, so a slow first paint cannot swallow one.
  await frame.locator('button').click()
  await frame.locator('#n', { hasText: '1' }).waitFor({ timeout: 5000 }).catch(() => {})
  // From here on the page must stay put: a reload would reset the counter.
  let frameLoads = 0
  page.on('framenavigated', (f) => {
    if (f.url().includes('artifact/')) frameLoads += 1
  })
  await frame.locator('button').click()
  await frame.locator('#n', { hasText: '2' }).waitFor({ timeout: 5000 }).catch(() => {})
  const clicks = await frame.locator('#n').textContent()
  check('artifact preview is not reloaded while in use', frameLoads === 0, `${frameLoads} reloads`)
  check('artifact preview runs its script in the sandbox', clicks === '2', `counter=${clicks}`)
  const sandbox = await page.getAttribute('.artifact-frame', 'sandbox')
  check('artifact frame has no same-origin access', !(sandbox ?? '').includes('allow-same-origin'), sandbox ?? '')
  await shot('07-artifact')
  await page.click('.artifact-head .icon-btn[title="Close"]')

  // ---- tools menu ----
  await page.click('.composer .icon-btn[title="Tools and thinking"]')
  await page.click('.tool-item:has-text("Web search")')
  await page.keyboard.press('Escape')
  check('web search pill appears when enabled', (await page.locator('.tool-pill:has-text("Search")').count()) === 1)

  // ---- ChatGPT mode ----
  await page.click('.mode-switch button:has-text("ChatGPT")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'chatgpt')
  check('ChatGPT mode has its own empty chat list', (await page.locator('.chat-row').count()) === 0)
  check('model picker moves to the top bar in ChatGPT mode', (await page.locator('.topbar .model-button').count()) === 1)
  await shot('08-chatgpt-empty')
  await page.click('.topbar .model-button')
  await page.waitForSelector('.model-item')
  check('model menu lists GPT models with prices', /GPT-6\.1 Sol/.test((await page.textContent('.menu')) ?? '') && /\$2 in/.test((await page.textContent('.menu')) ?? ''))
  await shot('09-chatgpt-models')
  await page.keyboard.press('Escape')
  await page.fill('.composer textarea', 'Hello from ChatGPT mode')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  const gptUsage = await page.textContent('.msg.assistant .usage-line')
  check('ChatGPT reply is priced on a GPT model', /GPT-6\.1 Sol/.test(gptUsage ?? ''), gptUsage ?? '')
  await shot('10-chatgpt-reply')

  // ---- Gemini mode ----
  await page.click('.mode-switch button:has-text("Gemini")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'gemini')
  check('Gemini mode has its own empty chat list', (await page.locator('.chat-row').count()) === 0)
  check('Gemini model picker sits in the composer', /Gemini 4 Hydrogen/.test((await page.textContent('.composer .model-button')) ?? ''))
  await page.fill('.composer textarea', 'Hello from Gemini mode')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  const geminiUsage = await page.textContent('.msg.assistant .usage-line')
  check('Gemini reply is priced on a Gemini model', /Gemini 4 Hydrogen/.test(geminiUsage ?? ''), geminiUsage ?? '')
  check('sidebar meter switches to Gemini spend', /Gemini API spend/.test((await page.textContent('.meter')) ?? ''))
  await shot('10b-gemini-reply')

  // ---- Threefold review tab ----
  await page.click('.side-btn:has-text("Threefold review")')
  await page.waitForSelector('.panel-bar')
  const notice = (await page.textContent('.panel-notice')) ?? ''
  check('opening the tab explains that every model bills', /every model you pick bills you/.test(notice), notice.slice(0, 90))
  check('notice names the answering model and both reviewers', /Gemini 4 Hydrogen/.test(notice) && /Claude Opus 5\.5/.test(notice) && /GPT-6\.1 Sol/.test(notice))
  check('notice counts the requests per provider', /4 API requests/.test(notice) && /Google for 2/.test(notice) && /Anthropic for 1/.test(notice) && /OpenAI for 1/.test(notice))
  check('reviewers default to the other connected providers', (await page.locator('.panel-bar .panel-chip:not(.answering):not(.add)').count()) === 2)
  check('Threefold tab keeps its own chat list', (await page.locator('.chat-row').count()) === 0)
  await shot('10c-threefold-notice')
  await page.click('.panel-notice .btn.primary')
  check('notice goes away once acknowledged', (await page.locator('.panel-notice').count()) === 0)
  check('a billing reminder stays under the composer', /Each message is billed by/.test((await page.textContent('.panel-billing')) ?? ''))

  await page.fill('.composer textarea', 'Is a tomato a fruit?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming .step')
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant.streaming .step').length >= 3, null, { timeout: 15000 })
  check('reviews start once the draft is done', true)
  await shot('10d-threefold-running')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 30000 })
  const stepLabels = await page.locator('.msg.assistant .step-head strong').allTextContents()
  check('answer shows draft, two reviews and the final step', stepLabels.join(',') === 'Draft,Review,Review,Final answer', stepLabels.join(','))
  const stepModels = await page.locator('.msg.assistant .step-model').allTextContents()
  check('each step names its model', stepModels.join(',') === 'Gemini 4 Hydrogen,Claude Opus 5.5,GPT-6.1 Sol,Gemini 4 Hydrogen', stepModels.join(','))
  check('main answer is the final rewrite', /final answer/i.test((await page.textContent('.msg.assistant .markdown')) ?? ''))
  const stepCosts = (await page.locator('.msg.assistant .step-cost').allTextContents()).map((t) => Number(t.replace(/[^0-9.]/g, '')))
  const totalText = (await page.textContent('.msg.assistant .usage-line strong')) ?? ''
  const total = Number(totalText.replace(/[^0-9.]/g, ''))
  const summed = stepCosts.reduce((a, b) => a + b, 0)
  check('message cost is the sum of its four steps', stepCosts.length === 4 && Math.abs(total - summed) < 0.0004, `${totalText} vs ${summed.toFixed(4)}`)
  await page.locator('.msg.assistant .step-head').nth(1).click()
  check('a review can be opened and read', /Two things to fix/.test((await page.textContent('.msg.assistant .step-body')) ?? ''))
  check('the reviewed chat is listed in the Threefold tab', (await page.locator('.chat-row').count()) === 1)
  await shot('10e-threefold-done')
  await page.locator('.panel-bar .panel-chip:not(.answering):not(.add) button').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.panel-bar .panel-chip:not(.answering):not(.add)').length === 1)
  check('a reviewer can be removed', /1 request\)/.test((await page.textContent('.panel-billing')) ?? ''))
  await page.click('.side-btn:has-text("New chat")')
  check('reviewed chats stay out of the ordinary chat list', (await page.locator('.chat-row').count()) === 1)

  // ---- projects ----
  await page.click('.side-btn:has-text("Projects")')
  await page.fill('.page-body .input', 'Launch plan')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.project-name')
  await page.fill('.input.area', 'Always answer in one sentence.')
  await page.click('h3:has-text("Files")')
  await shot('11-project')
  await page.click('.btn:has-text("New chat in project")')
  await page.waitForSelector('.crumb:has-text("Launch plan")')
  check('new chat is attached to the project', true)

  // ---- settings: spend, memory, about ----
  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("Spend")')
  await page.waitForSelector('.usage-block')
  const spend = await page.textContent('.modal-body')
  check('spend tab breaks cost down by model for all three providers', /Claude Opus 5\.5/.test(spend ?? '') && /GPT-6\.1 Sol/.test(spend ?? '') && /Gemini 4 Hydrogen/.test(spend ?? ''))
  await shot('12-spend')
  await page.click('.modal-nav .side-btn:has-text("Memory")')
  await page.fill('.modal-body .key-row .input', 'Prefers short answers')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.memory-list li')
  check('a memory can be added', (await page.locator('.memory-list li').count()) === 1)
  await page.click('.modal-nav .side-btn:has-text("API keys")')
  await shot('13-keys')
  await page.click('.modal-nav .side-btn:has-text("About")')
  check('about states independence from Anthropic, OpenAI and Google', /not made by, affiliated with or endorsed by Anthropic, OpenAI or\s+Google/.test((await page.textContent('.modal-body')) ?? ''))
  await page.click('.modal-close')

  // ---- code tab ----
  await page.click('.side-btn:has-text("Code")')
  await page.waitForSelector('.code-layout')
  await shot('14-code')
  check('code tab opens', true)

  // ---- dark theme ----
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.click('.side-btn:has-text("New chat")')
  await page.click('.mode-switch button:has-text("Claude")')
  await page.locator('.chat-row').first().click()
  await page.waitForSelector('.msg.assistant')
  check('follows the system dark theme', (await page.getAttribute('html', 'data-theme')) === 'dark')
  await shot('15-claude-dark')

  // ---- persistence ----
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'conversations-index.json'), 'utf8'))
  check('conversations are saved to disk', saved.length === 4, `${saved.length} saved`)
  const ledger = fs.readFileSync(path.join(dataDir, 'data', 'ledger.jsonl'), 'utf8').trim().split('\n')
  check('every request is written to the spend ledger', ledger.length === 8, `${ledger.length} entries`)
  const providersBilled = new Set(ledger.map((line) => JSON.parse(line).provider))
  check('the reviewed turn is billed under each provider', providersBilled.size === 3, [...providersBilled].join(','))
  check('no API key file was written in demo mode', !fs.existsSync(path.join(dataDir, 'keys.json')))
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  await shot('failure').catch(() => {})
  check('ran to completion', false, String(error).split('\n')[0])
  if (errors.length) console.log('console errors:', errors.slice(0, 5))
} finally {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
