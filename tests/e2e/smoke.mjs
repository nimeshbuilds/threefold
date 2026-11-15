// End-to-end check of the real app in demo mode (no API keys, no network, no cost).
// Usage: pnpm build && node tests/e2e/smoke.mjs [screenshot-dir]
// Set TWOFOLD_APP to a packaged binary (dist/mac-arm64/Twofold.app/Contents/MacOS/Twofold)
// to run the same checks against the packaged app.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.argv[2] ?? 'tests/e2e/screenshots')
fs.mkdirSync(shots, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twofold-e2e-'))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const packaged = process.env.TWOFOLD_APP
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }),
  env: { ...process.env, TWOFOLD_DEMO: '1', TWOFOLD_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
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
  await page.waitForSelector('.credit-fields')
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
  await frame.locator('button').click()
  await frame.locator('button').click()
  const clicks = await frame.locator('#n').textContent()
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
  check('spend tab breaks cost down by model', /Claude Opus 5\.5/.test(spend ?? '') && /GPT-6\.1 Sol/.test(spend ?? ''))
  await shot('12-spend')
  await page.click('.modal-nav .side-btn:has-text("Memory")')
  await page.fill('.modal-body .key-row .input', 'Prefers short answers')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.memory-list li')
  check('a memory can be added', (await page.locator('.memory-list li').count()) === 1)
  await page.click('.modal-nav .side-btn:has-text("API keys")')
  await shot('13-keys')
  await page.click('.modal-nav .side-btn:has-text("About")')
  check('about states independence from Anthropic and OpenAI', /not made by, affiliated with or endorsed by/.test((await page.textContent('.modal-body')) ?? ''))
  await page.click('.modal-close')

  // ---- code tab ----
  await page.click('.side-btn:has-text("Code")')
  await page.waitForSelector('.code-layout')
  await shot('14-code')
  check('code tab opens', true)

  // ---- dark theme ----
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.click('.mode-switch button:has-text("Claude")')
  await page.locator('.chat-row').first().click()
  await page.waitForSelector('.msg.assistant')
  check('follows the system dark theme', (await page.getAttribute('html', 'data-theme')) === 'dark')
  await shot('15-claude-dark')

  // ---- persistence ----
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'conversations-index.json'), 'utf8'))
  check('conversations are saved to disk', saved.length === 2, `${saved.length} saved`)
  const ledger = fs.readFileSync(path.join(dataDir, 'data', 'ledger.jsonl'), 'utf8').trim().split('\n')
  check('every turn is written to the spend ledger', ledger.length === 3, `${ledger.length} entries`)
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
