// End-to-end check of the real app in demo mode (no API keys, no network, no cost).
// Usage: pnpm build && node tests/e2e/smoke.mjs [screenshot-dir]
// Set THREEFOLD_APP to a packaged binary (dist/mac-arm64/Threefold.app/Contents/MacOS/Threefold)
// to run the same checks against the packaged app.
import fs from 'node:fs'
import http from 'node:http'
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

// Stand-ins for the Claude Code and Codex CLIs, so the subscription route in the Code tab
// can be driven without an account. Claude Code starts out of date and signed out.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-fake-cli-'))
const fakeState = path.join(fakeDir, 'state.json')
fs.writeFileSync(
  fakeState,
  JSON.stringify({
    claude: { version: '2.1.281', latest: '2.1.325', loggedIn: false, plan: 'max', limit: false, calls: [] },
    codex: { version: '0.156.1', latest: '0.169.0', loggedIn: true, plan: 'pro', limit: false, calls: [] },
  }),
)
for (const kind of ['claude', 'codex']) {
  const script = `#!/bin/sh\nFAKE_CLI_KIND=${kind} exec "${process.execPath}" "${path.resolve('tests/fixtures/fake-cli.mjs')}" "$@"\n`
  fs.writeFileSync(path.join(fakeDir, kind), script, { mode: 0o755 })
}
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-project-'))
// A stand-in home folder, so installing the threefolds skill never touches the real one.
// Claude Code "has been used" here; Codex and Gemini CLI have not.
const skillHome = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-skill-home-'))
fs.mkdirSync(path.join(skillHome, '.claude'))

// A stand-in for GitHub's "newest release" answer, so the update check can be driven.
// It starts out saying that this version is the newest.
const thisVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version
const feed = { version: thisVersion, asked: 0 }
const feedServer = http.createServer((request, response) => {
  if (request.url !== '/latest.json') return void response.writeHead(404).end()
  feed.asked += 1
  const tag = `v${feed.version}`
  const base = `http://127.0.0.1:${feedServer.address().port}/${tag}/`
  response.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      tag_name: tag,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/nimeshbuilds/threefold/releases/tag/${tag}`,
      assets: [
        { name: 'Threefold-mac-arm64.zip', size: 290131065, browser_download_url: `${base}Threefold-mac-arm64.zip` },
        { name: 'Threefold-mac-arm64.zip.sha256', size: 90, browser_download_url: `${base}Threefold-mac-arm64.zip.sha256` },
      ],
    }),
  )
})
await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve))

const packaged = process.env.THREEFOLD_APP
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }),
  env: {
    ...process.env,
    THREEFOLD_DEMO: '1',
    THREEFOLD_DATA_DIR: dataDir,
    ELECTRON_RENDERER_URL: '',
    THREEFOLD_CLAUDE_CLI: path.join(fakeDir, 'claude'),
    THREEFOLD_CODEX_CLI: path.join(fakeDir, 'codex'),
    THREEFOLD_CLI_LATEST: JSON.stringify({ claude: '2.1.325', chatgpt: '0.169.0' }),
    FAKE_CLI_STATE: fakeState,
    THREEFOLD_SKILL_HOME: skillHome,
    THREEFOLD_UPDATE_FEED: `http://127.0.0.1:${feedServer.address().port}/latest.json`,
  },
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
  const credit = (await page.textContent('.built-by')) ?? ''
  check('sidebar credits Nimesh and the NimeshBuilds org', /Built in public by Nimesh/.test(credit) && /NimeshBuilds on GitHub/.test(credit), credit)
  check('NimeshBuilds logo loads', await page.locator('.built-by img').evaluate((img) => img.complete && img.naturalWidth > 0))
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

  // ---- image generation (Gemini mode) ----
  await page.click('.composer .icon-btn[title="Tools and thinking"]')
  check('Gemini mode offers image generation', (await page.locator('.tool-item:has-text("Image generation")').count()) === 1)
  await page.click('.tool-item:has-text("Image generation")')
  await page.keyboard.press('Escape')
  await page.fill('.composer textarea', 'Draw a picture of a lighthouse')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  check('a generated image is shown with the reply', (await page.locator('.msg.assistant .generated-image img').count()) === 1)
  const imageLoaded = await page.locator('.msg.assistant .generated-image img').evaluate(
    (img) =>
      new Promise((resolve) => {
        if (img.complete) resolve(img.naturalWidth > 0)
        else {
          img.onload = () => resolve(true)
          img.onerror = () => resolve(false)
        }
      }),
  )
  check('the generated image loads from local storage', imageLoaded === true)
  await shot('10f-gemini-image')

  // ---- deep research (Claude mode) ----
  await page.click('.mode-switch button:has-text("Claude")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'claude')
  await page.click('.composer .icon-btn[title="Tools and thinking"]')
  check('Claude mode has no image generation toggle', (await page.locator('.tool-item:has-text("Image generation")').count()) === 0)
  await page.click('.tool-item:has-text("Deep research")')
  await page.keyboard.press('Escape')
  check(
    'deep research shows a pill and a note about time and cost',
    (await page.locator('.tool-pill.research').count()) === 1 &&
      /several minutes/.test((await page.textContent('.composer-note.research')) ?? ''),
  )
  await page.fill('.composer textarea', 'Research the state of solid-state batteries')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 20000 })
  check('the message is tagged as deep research', (await page.locator('.msg.user .research-tag').count()) === 1)
  check(
    'the reply is a research report with a research step',
    /research report/.test((await page.textContent('.msg.assistant .markdown')) ?? '') &&
      (await page.locator('.msg.assistant .event:has-text("Deep research")').count()) === 1,
  )
  check('deep research switches itself off after one message', (await page.locator('.tool-pill.research').count()) === 0)
  await shot('10g-research')

  // ---- deep research inside Threefold review ----
  await page.click('.side-btn:has-text("Threefold review")')
  await page.waitForSelector('.panel-bar')
  await page.click('.composer .icon-btn[title="Tools and thinking"]')
  await page.click('.tool-item:has-text("Deep research")')
  await page.keyboard.press('Escape')
  check(
    'Threefold explains what deep research does there',
    /reviewers can search the web/.test((await page.textContent('.composer-note.research')) ?? ''),
  )
  await page.fill('.composer textarea', 'Research the market for heat pumps')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant.streaming .step')
  await page.waitForSelector('.msg.assistant.streaming', { state: 'detached', timeout: 30000 })
  const researchSteps = await page.locator('.msg.assistant .step-head strong').allTextContents()
  check('a researched answer is still drafted, reviewed and rewritten', researchSteps.join(',') === 'Draft,Review,Final answer', researchSteps.join(','))
  await page.locator('.msg.assistant .step-head').nth(1).click()
  check('reviewers critique the research report', /rests on a single source/.test((await page.textContent('.msg.assistant .step-body')) ?? ''))
  await shot('10h-threefold-research')
  await page.click('.side-btn:has-text("New chat")')

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
  const about = (await page.textContent('.modal-body')) ?? ''
  check('about credits NimeshBuilds with the org link', /built by Nimesh under NimeshBuilds/.test(about) && /github\.com\/nimeshbuilds/.test(about))
  await shot('13b-about')
  check('about states independence from Anthropic, OpenAI and Google', /not made by, affiliated with or endorsed by Anthropic, OpenAI or\s+Google/.test((await page.textContent('.modal-body')) ?? ''))
  await page.click('.modal-close')

  // ---- code tab ----
  await page.click('.side-btn:has-text("Code")')
  await page.waitForSelector('.code-layout')
  await shot('14-code')
  check('code tab opens', true)

  // ---- coding on a subscription: update the CLI, sign in, run on the plan, fall back to the API key ----
  const step = (n) => page.locator('.sub-modal .sub-step').nth(n)
  const stepStatus = (n, pattern) =>
    page.waitForFunction(
      ([index, source]) => new RegExp(source).test(document.querySelectorAll('.sub-modal .sub-step .status')[index]?.textContent ?? ''),
      [n, pattern.source],
      { timeout: 15000 },
    )
  const codeNotice = (words) => page.waitForSelector(`.code-main .msg-error.muted:has-text("${words}")`, { timeout: 20000 })
  await page.click('.side-btn:has-text("New chat")')
  await page.click('.mode-switch button:has-text("Claude")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'claude')
  await page.click('.side-btn:has-text("Code")')
  await page.waitForSelector('.code-layout')
  check('the code tab offers to use a subscription', /Use subscription/.test((await page.textContent('.sub-button')) ?? ''))
  check('the code tab says what the subscription route does', /runs Claude Code on your plan first and falls back to your API key/.test((await page.textContent('.code-main')) ?? ''))
  await page.click('.sub-button')
  await page.waitForSelector('.sub-modal')
  await stepStatus(0, /Update available/)
  const lead = (await page.textContent('.sub-modal .lead')) ?? ''
  check(
    'the panel says the plan is used first and the API key after',
    /Your Claude plan is used first/.test(lead) && /carries on in the same session with your API key/.test(lead),
    lead,
  )
  const cliStep = (await step(0).textContent()) ?? ''
  check('the panel finds the CLI and sees that it is out of date', /Version 2\.1\.281\. The newest is 2\.1\.325\./.test(cliStep), cliStep)
  check('the panel shows the exact command an update runs', /claude update/.test(cliStep))
  check('the panel sees that the CLI is not signed in', /Not signed in/.test((await step(1).textContent()) ?? ''))
  check('the subscription cannot be switched on before setup is done', await page.locator('.sub-modal .switch').isDisabled())
  await shot('23-subscription-setup')

  // One button does everything that is left: here, sign in and switch on.
  const go = (await page.textContent('.sub-go')) ?? ''
  check('one button names everything that is left to do', /Sign in and switch on/.test(go), go)
  check('nothing in the panel sends the user to a terminal', !/terminal/i.test((await page.textContent('.sub-modal')) ?? ''))
  await page.click('.sub-go')
  await page.waitForSelector('.sub-done', { timeout: 15000 })
  const signedIn = (await step(1).textContent()) ?? ''
  check(
    'that one click runs the CLI’s own sign-in and passes on its link',
    /Signed in · Max plan/.test(signedIn) && /claude\.ai\/oauth\/authorize/.test(signedIn) && /Login successful/.test(signedIn) && /never sees your password or any token/.test(signedIn),
    signedIn.slice(0, 160),
  )
  check(
    'and switches the subscription on by itself',
    (await page.getAttribute('.sub-modal .switch', 'aria-checked')) === 'true' && /On\. New coding sessions use your Claude plan first/.test((await page.textContent('.sub-done')) ?? ''),
  )

  // Updating is offered, not required: this version works.
  await page.click('.sub-modal .btn:has-text("Update Claude Code")')
  await stepStatus(0, /Up to date/)
  const updated = (await step(0).textContent()) ?? ''
  check('the CLI is updated from inside the app', /Version 2\.1\.325, the newest\./.test(updated) && /Update complete\./.test(updated), updated.slice(0, 160))
  check('the panel says Claude Code still asks before acting', /still asks you before it edits a file or runs a command/.test((await step(2).textContent()) ?? ''))
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await shot('24-subscription-ready')
  await page.click('.sub-modal .btn:has-text("Done")')
  check('the code tab shows that the subscription comes first', /Subscription first/.test((await page.textContent('.sub-button')) ?? ''))
  check('the code tab describes the plan-first route', /New sessions run Claude Code on your Claude plan first/.test((await page.textContent('.code-main')) ?? ''))

  // The folder picker is a system dialog, so it is answered for the test.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, projectDir)
  await page.click('.code-sessions .btn.primary')
  await page.waitForSelector('.engine-tag')
  check('a new session runs through the CLI, plan first', /Claude Code · plan first/.test((await page.textContent('.engine-tag')) ?? ''))
  await page.fill('.code-main .composer textarea', 'Change draft to final in notes.txt')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.permission', { timeout: 20000 })
  check('Claude Code asks through Threefold before it edits a file', /Edit notes\.txt/.test((await page.textContent('.permission')) ?? ''))
  await shot('25-subscription-permission')
  await page.click('.permission .btn.primary')
  const planLine = (await (await codeNotice('Ran on your Claude plan')).textContent()) ?? ''
  check('the turn says it ran on the plan and was not billed to the API key', /Ran on your Claude plan \(Claude Opus 5\.5\)/.test(planLine) && /not billed to your API key/.test(planLine), planLine)
  check('the allowed edit is shown as done', (await page.locator('.code-main .event-done:has-text("Edit notes.txt")').count()) === 1)
  check('work on the plan adds nothing to the session’s API cost', /This session \$0\.00 on API/.test((await page.textContent('.code-page .cost-chip')) ?? ''))
  await shot('26-subscription-plan-run')

  // The sign-in runs out behind the app's back. The session says so, offers to fix it on the spot,
  // and meanwhile carries on with the API key.
  const expire = JSON.parse(fs.readFileSync(fakeState, 'utf8'))
  Object.assign(expire.claude, { loggedIn: false, expired: true })
  fs.writeFileSync(fakeState, JSON.stringify(expire))
  await page.fill('.code-main .composer textarea', 'One more change')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.permission', { timeout: 20000 })
  await page.click('.permission .btn.primary')
  await codeNotice('Ran on your API key')
  const expired = (await page.textContent('.code-main .msg-error.with-action')) ?? ''
  check(
    'an expired sign-in is named, and the session carries on with the API key',
    /Claude Code’s sign-in to your Claude plan has expired\. Carrying on with your API key\./.test(expired),
    expired,
  )
  check('the session offers to sign in right there', /Sign in/.test((await page.textContent('.code-main .msg-error.with-action .btn')) ?? ''))
  await shot('26b-subscription-sign-in-again')
  await page.click('.code-main .msg-error.with-action .btn')
  // The panel opens, signs in and closes again without another click.
  await page.waitForSelector('.sub-modal')
  await page.waitForSelector('.sub-modal', { state: 'detached', timeout: 15000 })
  check('signing in from the session needs one click and returns to it', JSON.parse(fs.readFileSync(fakeState, 'utf8')).claude.loggedIn === true)
  await page.fill('.code-main .composer textarea', 'Back on the plan')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.permission', { timeout: 20000 })
  await page.click('.permission .btn.primary')
  await page.waitForFunction(() => document.querySelectorAll('.code-main .msg-error.muted').length >= 4 && /Ran on your Claude plan/.test([...document.querySelectorAll('.code-main .msg-error.muted')].at(-1)?.textContent ?? ''), null, { timeout: 20000 })
  check('after signing in, the next turn is on the plan again', true)

  await page.fill('.code-main .composer textarea', 'Now hit the LIMIT')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.permission', { timeout: 20000 })
  await page.click('.permission .btn.primary')
  // This is the second turn that ends on the API key, so wait for the second such line.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.code-main .msg-error.muted')].filter((line) => /Ran on your API key/.test(line.textContent ?? '')).length === 2,
    null,
    { timeout: 20000 },
  )
  const apiLine = (await page.locator('.code-main .msg-error.muted:has-text("Ran on your API key")').last().textContent()) ?? ''
  const thread = (await page.textContent('.code-main .thread')) ?? ''
  check(
    'when the plan’s limit is reached it says so and carries on with the API key',
    /Your Claude plan’s usage limit is reached \(it resets at [^)]+\)\. Carrying on with your API key\./.test(thread),
  )
  check('the part on the API key shows what it cost', /Ran on your API key · \$0\.0\d+ ·/.test(apiLine), apiLine)
  check('the session’s API cost now counts that part', /This session \$0\.0[1-9]\d* on API/.test((await page.textContent('.code-page .cost-chip')) ?? ''))
  await shot('27-subscription-fallback')
  const claudeCalls = JSON.parse(fs.readFileSync(fakeState, 'utf8')).claude.calls
  check(
    'the plan run got no API key, and the fallback continued the same session with one',
    claudeCalls.map((call) => `${call.auth}:${call.resume ?? 'new'}`).join(' ') ===
      // first turn; expired sign-in then the key; signed in again; limit reached then the key
      'plan:new plan:claude-session-1 api:claude-session-1 plan:claude-session-1 plan:claude-session-1 api:claude-session-1',
    claudeCalls.map((call) => `${call.auth}:${call.resume ?? 'new'}`).join(' '),
  )

  // The same for ChatGPT mode, where the CLI is Codex.
  await page.click('.side-btn:has-text("New chat")')
  await page.click('.mode-switch button:has-text("ChatGPT")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'chatgpt')
  await page.click('.side-btn:has-text("Code")')
  await page.click('.sub-button')
  await page.waitForSelector('.sub-modal')
  await stepStatus(1, /Signed in/)
  check('Codex is found already signed in with ChatGPT', /Codex is signed in with your ChatGPT plan/.test((await step(1).textContent()) ?? ''))
  check('the panel says how Codex differs: a sandbox, and no asking', /Codex does not ask before each step/.test((await step(2).textContent()) ?? ''))
  // Codex is installed and signed in, so all that is left is to switch it on.
  check('with nothing else to do, the one button just switches it on', /^\s*Switch on\s*$/.test((await page.textContent('.sub-go')) ?? ''))
  await page.click('.sub-go')
  await page.waitForSelector('.sub-done')
  await page.click('.sub-modal .btn:has-text("Done")')
  await page.click('.code-sessions .btn.primary')
  await page.waitForSelector('.engine-tag')
  await page.fill('.code-main .composer textarea', 'Change draft to final in notes.txt')
  await page.keyboard.press('Enter')
  await codeNotice('Ran on your ChatGPT plan')
  const codexThread = (await page.textContent('.code-main .thread')) ?? ''
  check(
    'Codex runs on the plan in its sandbox and shows its steps',
    /Codex is working in its own sandbox/.test(codexThread) && /Run: ls -la/.test(codexThread) && /Change notes\.txt/.test(codexThread) && /Done: notes\.txt now says final\./.test(codexThread),
  )
  await shot('28-codex-plan-run')

  // ---- automatic fallback: a provider that is low on credit hands the chat to another ----
  const answered = () => page.waitForSelector('.msg.assistant:not(.streaming) .usage-line', { timeout: 20000 })
  await page.click('.side-btn:has-text("New chat")')
  await page.click('.mode-switch button:has-text("Claude")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'claude')
  await page.locator('.chat-row:has-text("Explain what the cost meter")').click()
  await page.waitForSelector('.msg.assistant')
  check('nothing warns about credit while there is plenty', (await page.locator('.composer-note.fallback').count()) === 0)
  check('a chat with history can be handed off by hand', (await page.locator('.handoff-button').count()) === 1)

  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("Credits")')
  const fallbackSwitch = page.locator('.fallback-settings .switch')
  check('automatic fallback is off until it is switched on', (await fallbackSwitch.getAttribute('aria-checked')) === 'false')
  await fallbackSwitch.click()
  await page.waitForSelector('.fallback-settings .seg')
  check('the switch shows that fallback is on', (await fallbackSwitch.getAttribute('aria-checked')) === 'true' && /\bon\b/.test((await fallbackSwitch.getAttribute('class')) ?? ''))
  check('fallback switches at 85% unless changed', (await page.locator('.fallback-settings .seg button.active:has-text("85%")').count()) === 1)
  const fallbackText = (await page.textContent('.fallback-settings')) ?? ''
  check(
    'fallback settings say that the chat is sent to the new provider and who bills the summary',
    /conversation so far is sent to the provider you switch to/.test(fallbackText) && /billed by that provider/.test(fallbackText),
  )
  // Pretend Claude's monthly credit is nearly gone: set the grant so that exactly 90% of it is spent.
  const spentSoFar = await page.evaluate(() => window.threefold.usage.summary())
  await page.locator('.credit-fields').first().locator('input[type="number"]').first().fill((spentSoFar.claude.spentUsd / 0.9).toFixed(8))
  await page.locator('.fallback-settings').scrollIntoViewIfNeeded()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await shot('16-fallback-settings')
  await page.click('.modal-close')

  await page.waitForSelector('.composer-note.fallback')
  const warning = (await page.textContent('.composer-note.fallback')) ?? ''
  check(
    'the message box says beforehand that the next message will move',
    /Claude credit is (89|90)% used/.test(warning) && /continues in ChatGPT/.test(warning) && /handoff summary/.test(warning) && /Stay on Claude/.test(warning),
    warning,
  )
  await shot('17-fallback-notice')
  await page.fill('.composer textarea', 'And what does the dot mean?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.handoff-card.writing')
  const writing = (await page.textContent('.handoff-card.writing')) ?? ''
  check(
    'the chat shows that a summary is being written, and by which model',
    /Moving this chat to ChatGPT/.test(writing) && /GPT-6\.1 Sol is writing a handoff summary/.test(writing),
    writing,
  )
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'chatgpt', null, { timeout: 20000 })
  await page.waitForSelector('.handoff-card:not(.writing)')
  await answered()
  check('a chat that moved between providers is marked as a handoff inside Threefold', (await page.textContent('.handoff-card .handoff-kind')) === 'Handoff inside Threefold')
  const card = (await page.textContent('.handoff-card')) ?? ''
  check(
    'the new chat says where it came from, why, and what the summary cost',
    /Continued from Claude/.test(card) && /credit was (89|90)% used/.test(card) && /GPT-6\.1 Sol wrote a summary/.test(card) && /for \$0\.\d+/.test(card),
    card,
  )
  check('the message is answered by the new provider', /GPT-6\.1 Sol/.test((await page.textContent('.msg.assistant .usage-line')) ?? ''))
  check('the new model picks up from the summary', /Picking up from the handoff summary/.test((await page.textContent('.msg.assistant .markdown')) ?? ''))
  check('the message that was being sent moved with the chat', /And what does the dot mean\?/.test((await page.textContent('.msg.user')) ?? ''))
  check('the chat keeps its title in the new mode', (await page.locator('.chat-row.active:has-text("Explain what the cost meter")').count()) === 1)
  await page.click('.handoff-actions button:has-text("Read the summary")')
  const summaryText = (await page.textContent('.handoff-summary')) ?? ''
  check('the summary can be read in the chat', /Threefold handoff/.test(summaryText) && /Explain what the cost meter shows/.test(summaryText), summaryText.slice(0, 60))
  await shot('19-fallback-continued')

  await page.click('.handoff-actions button:has-text("Open the original chat")')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'claude')
  await page.waitForSelector('.continued-note')
  check('the original chat points to where it continues', /continues in ChatGPT/.test((await page.textContent('.continued-note')) ?? ''))
  check('the original chat is left as it was', (await page.locator('.msg.user').count()) === 2)

  // One chat can be told to stay on its provider.
  await page.locator('.chat-row:has-text("Research the state")').click()
  await page.waitForSelector('.composer-note.fallback')
  await page.click('.composer-note.fallback button:has-text("Stay on Claude")')
  await page.waitForSelector('.composer-note.fallback', { state: 'detached' })
  const repliesBefore = await page.locator('.msg.assistant:not(.streaming)').count()
  await page.fill('.composer textarea', 'Say that in one line')
  await page.keyboard.press('Enter')
  await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant:not(.streaming)').length > n, repliesBefore, { timeout: 20000 })
  check(
    'a chat told to stay keeps answering on its own provider',
    (await page.getAttribute('html', 'data-mode')) === 'claude' && (await page.locator('.handoff-card').count()) === 0,
  )

  // A brand-new chat has nothing to summarise: it simply starts where there is credit.
  await page.click('.side-btn:has-text("New chat")')
  await page.waitForSelector('.composer-note.fallback')
  check('a new chat says it will start elsewhere', /This chat will start in ChatGPT/.test((await page.textContent('.composer-note.fallback')) ?? ''))
  await page.fill('.composer textarea', 'A fresh question')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'chatgpt', null, { timeout: 20000 })
  await answered()
  check(
    'a new chat starts with the provider that has credit, with no summary',
    /GPT-6\.1 Sol/.test((await page.textContent('.msg.assistant .usage-line')) ?? '') && (await page.locator('.handoff-card').count()) === 0,
  )

  // ---- handing a chat off by hand ----
  await page.click('.handoff-button')
  const handoffMenu = (await page.textContent('.handoff-menu .menu')) ?? ''
  check('hand off lists the other providers and who bills the summary', /Gemini/.test(handoffMenu) && /Claude/.test(handoffMenu) && /billed by Google/.test(handoffMenu), handoffMenu)
  check(
    'the menu keeps the two kinds of handoff apart',
    /Inside Threefold · continue this chat in/.test(handoffMenu) && /From outside Threefold/.test(handoffMenu) && /Bring a chat in from another app/.test(handoffMenu),
  )
  await page.click('.handoff-menu .menu-item:has(strong:text-is("Gemini"))')
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'gemini', null, { timeout: 20000 })
  await page.waitForSelector('.handoff-card:not(.writing)')
  const manualCard = (await page.textContent('.handoff-card')) ?? ''
  check(
    'a manual handoff opens a new chat that starts from the summary',
    /Continued from ChatGPT/.test(manualCard) && /Gemini 4 Hydrogen wrote a summary/.test(manualCard) && (await page.locator('.msg').count()) === 0,
    manualCard,
  )
  check('the message box invites the user to carry on', /continue/.test((await page.getAttribute('.composer textarea', 'placeholder')) ?? ''))

  // ---- continuing a chat from another app: paste a handoff written by the threefolds skill ----
  await page.click('.side-btn:has-text("New chat")')
  await page.click('.link-btn')
  await page.waitForSelector('.handoff-modal')
  const pasteDialog = (await page.textContent('.handoff-modal')) ?? ''
  check('the paste dialog names the skill', /threefolds/.test(pasteDialog))
  check(
    'the paste dialog says it is for chats from outside, and where the other kind lives',
    (await page.textContent('.handoff-modal .handoff-kind')) === 'Handoff from outside Threefold' && /use Hand off at the top of that chat/.test(pasteDialog),
  )
  check('nothing can be continued until a summary is pasted', await page.locator('.handoff-modal .btn.primary').isDisabled())
  await page.click('.handoff-modal .btn:has-text("Copy the prompt")')
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(
    'the prompt for apps without Skills can be copied, and starts with the check',
    /^Follow the instructions below for this conversation, right now\.\n\n## Step 1: look for Threefold first/.test(copied) && /# Threefold handoff/.test(copied) && /end of handoff/.test(copied) && !/Installing Threefold/.test(copied),
    copied.slice(0, 50),
  )
  await page.fill(
    '.handoff-input',
    'Sure, here it is:\n\n# Threefold handoff\n\n**Title:** Budget review\n**From:** ChatGPT\n\n## Goal\nCut hosting costs by a third.\n\n--- end of handoff ---\nCopy this message.',
  )
  await shot('20-handoff-paste')
  await page.click('.handoff-modal .btn.primary')
  await page.waitForSelector('.handoff-card')
  check('a chat brought in from another app is marked as a handoff from outside', (await page.textContent('.handoff-card .handoff-kind')) === 'Handoff from outside Threefold')
  const pastedCard = (await page.textContent('.handoff-card')) ?? ''
  check(
    'a pasted handoff becomes a chat with its title and origin',
    /Budget review/.test((await page.textContent('.topbar-title')) ?? '') && /Continued from ChatGPT/.test(pastedCard) && /You pasted this handoff summary/.test(pastedCard),
    pastedCard,
  )
  await page.click('.handoff-actions button:has-text("Read the summary")')
  const pastedSummary = (await page.textContent('.handoff-summary')) ?? ''
  check('only the handoff itself is kept from what was pasted', /Cut hosting costs/.test(pastedSummary) && !/Sure, here it is/.test(pastedSummary) && !/Copy this message/.test(pastedSummary))
  await page.fill('.composer textarea', 'continue')
  await page.keyboard.press('Enter')
  await answered()
  check('the reply builds on the pasted summary', /Picking up from the handoff summary/.test((await page.textContent('.msg.assistant .markdown')) ?? ''))
  await shot('21-handoff-pasted-chat')

  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("Import history")')
  const importTab = (await page.textContent('.modal-body')) ?? ''
  check('import settings offer the handoff route before the exports', /No export needed/.test(importTab) && /\/threefolds/.test(importTab) && importTab.indexOf('No export needed') < importTab.indexOf('Claude history'))
  await shot('22-import-handoff')
  await page.click('.modal-close')

  // ---- a handoff passed in from outside: the skill saves a file, then opens a link ----
  const inbox = path.join(dataDir, 'inbox')
  check('the app keeps a private inbox folder for handoffs', fs.existsSync(inbox) && (fs.statSync(inbox).mode & 0o777) === 0o700)
  // macOS delivers a link opened from outside as this event.
  const openLink = (url) =>
    app.evaluate(({ app: electronApp }, link) => {
      electronApp.emit('open-url', { preventDefault() {} }, link)
    }, url)
  const chooseFromMenu = (label) =>
    app.evaluate(({ Menu }, text) => {
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File')
      file.submenu.items.find((item) => item.label.startsWith(text)).click()
    }, label)
  const savedChats = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'conversations-index.json'), 'utf8')).length
  const chatsBefore = savedChats()
  const waiting = path.join(inbox, 'handoff-20261115-101500.md')
  const billing =
    '# Threefold handoff\n\n- **Title:** Billing migration\n- **From:** Gemini 3.5 Pro\n\n## Goal\nMove billing to the new schema.\n\n--- end of handoff ---\n'
  // Start somewhere else, so that landing in the sender's mode means something.
  await page.click('.mode-switch button:has-text("Claude")')
  await page.click('.side-btn:has-text("New chat")')
  const addressBefore = page.url()
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), billing)
  await openLink('threefold://artifact/anything')
  await openLink('threefold://file/keys.json')
  await openLink('threefold://settings?from=gemini')
  await openLink('https://example.com/')
  await page.waitForTimeout(1200)
  check(
    'links other than the handoff link are ignored, even with a handoff on the clipboard',
    (await page.locator('.modal').count()) === 0 && page.url() === addressBefore,
  )
  await app.evaluate(({ clipboard }) => clipboard.writeText('nothing to see'))
  fs.writeFileSync(waiting, billing)

  await openLink('threefold://handoff?from=gemini&text=this+part+of+a+link+is+ignored')
  await page.waitForSelector('.incoming-modal')
  const incomingText = (await page.textContent('.incoming-modal')) ?? ''
  check(
    'an incoming handoff is shown first, not acted on',
    /A handoff is waiting/.test(incomingText) && /Billing migration/.test(incomingText) && /Nothing has been started or sent/.test(incomingText),
  )
  check(
    'it says who it claims to be from, who wrote it and how it arrived',
    /Says it is fromGemini · summary written by Gemini 3\.5 Pro/.test(incomingText) && /inbox folder/.test(incomingText) && /macOS does not tell Threefold which app sent/.test(incomingText),
    incomingText.slice(0, 260),
  )
  const shown = (await page.textContent('.incoming-text')) ?? ''
  check('the whole handoff can be read before deciding, and nothing from the link is in it', /Move billing to the new schema/.test(shown) && !/ignored/.test(shown))
  check(
    'the mode that matches the sender is preselected',
    (await page.textContent('.incoming-pick .seg button.active')) === 'Gemini' && /Continue in Gemini/.test((await page.textContent('.incoming-modal .btn.primary')) ?? ''),
  )
  check('the file leaves the inbox once it has been read', fs.readdirSync(inbox).length === 0)
  check('no chat exists until the user continues', savedChats() === chatsBefore && (await page.getAttribute('html', 'data-mode')) === 'claude')
  await page.waitForSelector('.toast', { state: 'detached', timeout: 9000 })
  await shot('23-incoming-handoff')

  await page.keyboard.press('Escape')
  await page.waitForSelector('.incoming-modal', { state: 'detached' })
  await chooseFromMenu('Continue from a Handoff')
  await page.waitForSelector('.incoming-modal')
  check('closing the dialog keeps the handoff, and the File menu brings it back', /Billing migration/.test((await page.textContent('.incoming-modal')) ?? ''))
  await page.click('.incoming-modal .btn.primary')
  await page.waitForSelector('.handoff-card')
  const receivedCard = (await page.textContent('.handoff-card')) ?? ''
  check(
    'continuing opens a chat in the chosen mode, marked as passed in',
    (await page.getAttribute('html', 'data-mode')) === 'gemini' &&
      /Billing migration/.test((await page.textContent('.topbar-title')) ?? '') &&
      /Continued from Gemini 3\.5 Pro/.test(receivedCard) &&
      /passed in from another app, and you accepted it/.test(receivedCard) &&
      savedChats() === chatsBefore + 1,
    receivedCard,
  )
  await page.fill('.composer textarea', 'continue')
  await page.keyboard.press('Enter')
  await answered()
  check('the reply builds on the handoff that was passed in', /Picking up from the handoff summary/.test((await page.textContent('.msg.assistant .markdown')) ?? ''))

  // ---- the same link from a chat app in the browser: the handoff is on the clipboard ----
  await app.evaluate(
    ({ clipboard }, text) => clipboard.writeText(text),
    'Here it is:\n\n# Threefold handoff\n\n- **Title:** Trip plan\n- **From:** ChatGPT\n\n## Goal\nFour days in Lisbon.\n\n--- end of handoff ---\nCopy this message, then open the link.',
  )
  await openLink('threefold://handoff?from=claude')
  await page.waitForSelector('.incoming-modal')
  const clipText = (await page.textContent('.incoming-modal')) ?? ''
  check('a copied handoff is picked up from the clipboard', /From your clipboard/.test(clipText) && /Trip plan/.test(clipText) && !/Copy this message/.test((await page.textContent('.incoming-text')) ?? ''))
  check(
    'a sender that does not match the summary is pointed out',
    /The sender says Claude, but the summary says it was written by ChatGPT/.test((await page.textContent('.incoming-warn')) ?? ''),
  )
  await page.click('.incoming-pick .seg button:has-text("ChatGPT")')
  check('the user can pick a different mode', /Continue in ChatGPT/.test((await page.textContent('.incoming-modal .btn.primary')) ?? ''))
  await shot('24-incoming-clipboard')
  await page.click('.incoming-modal .btn:has-text("Discard")')
  await page.waitForSelector('.incoming-modal', { state: 'detached' })
  check('discarding starts nothing', savedChats() === chatsBefore + 1)

  await app.evaluate(({ clipboard }) => clipboard.writeText('just some notes, not a handoff'))
  await openLink('threefold://handoff')
  await page.waitForSelector('.handoff-input')
  check(
    'a link with nothing waiting opens the empty paste box and says so, and the discarded handoff is gone',
    /none was waiting/.test((await page.textContent('.toast')) ?? '') && (await page.inputValue('.handoff-input')) === '' && (await page.locator('.incoming-modal').count()) === 0,
  )
  await page.click('.modal-close')

  // ---- a handoff that was saved but never announced (a sandbox may refuse to open links) ----
  fs.writeFileSync(
    path.join(inbox, 'handoff-20261116-090000.md'),
    '# Threefold handoff\n\n- **Title:** Saved, not announced\n- **From:** Codex (GPT-6)\n\n## Goal\nShow up when the user comes back.\n\n--- end of handoff ---\n',
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))
  await page.waitForSelector('.incoming-modal', { timeout: 8000 })
  const savedText = (await page.textContent('.incoming-modal')) ?? ''
  check(
    'a handoff saved without a link is shown when the user comes back to the app',
    /Saved, not announced/.test(savedText) && /Not stated by the sender · summary written by Codex \(GPT-6\)/.test(savedText),
    savedText.slice(60, 260),
  )
  check('its mode is worked out from who wrote the summary', (await page.textContent('.incoming-pick .seg button.active')) === 'ChatGPT')
  await page.click('.incoming-modal .btn:has-text("Discard")')
  await page.waitForSelector('.incoming-modal', { state: 'detached' })

  // ---- the same with nothing else happening: the app notices the file by itself ----
  fs.writeFileSync(
    path.join(inbox, 'handoff-20261116-093000-claude.md'),
    '# Threefold handoff\n\n- **Title:** Noticed by itself\n- **From:** Claude Opus 5\n\n## Goal\nAppear the moment the file is saved.\n\n--- end of handoff ---\n',
  )
  await page.waitForSelector('.incoming-modal', { timeout: 8000 })
  const noticed = (await page.textContent('.incoming-modal')) ?? ''
  check(
    'a handoff saved while the app is open appears by itself, with the sender from the file’s name',
    /Noticed by itself/.test(noticed) && /Says it is fromClaude · summary written by Claude Opus 5/.test(noticed) && (await page.textContent('.incoming-pick .seg button.active')) === 'Claude',
    noticed.slice(60, 240),
  )
  await page.click('.incoming-modal .btn:has-text("Discard")')
  await page.waitForSelector('.incoming-modal', { state: 'detached' })

  // ---- settings: installing the threefolds skill ----
  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("Handoff skill")')
  const claudeRow = page.locator('.skill-row[data-target="claude-code"]')
  await claudeRow.waitFor()
  const kinds = await page.locator('.handoff-kind-card .handoff-kind').allTextContents()
  check('settings explain the two kinds of handoff side by side', kinds.join(' | ') === 'Handoff inside Threefold | Handoff from outside Threefold', kinds.join(' | '))
  const claudeRowText = (await claudeRow.textContent()) ?? ''
  check(
    'the skill tab shows where each coding tool stands',
    /Not installed/.test(claudeRowText) &&
      /~\/\.claude\/skills\/threefolds\/SKILL\.md/.test(claudeRowText) &&
      /Codex was not found on this Mac/.test((await page.textContent('.skill-row[data-target="codex"]')) ?? '') &&
      /Gemini CLI was not found on this Mac/.test((await page.textContent('.skill-row[data-target="gemini-cli"]')) ?? ''),
    claudeRowText,
  )
  await claudeRow.locator('.btn:has-text("Install")').click()
  await page.waitForFunction(() => document.querySelector('.skill-row[data-target="claude-code"] .status')?.textContent === 'Installed')
  const skillFile = path.join(skillHome, '.claude/skills/threefolds/SKILL.md')
  check(
    'one click installs the published skill file for Claude Code',
    fs.readFileSync(skillFile, 'utf8') === fs.readFileSync(path.resolve('skills/threefolds/SKILL.md'), 'utf8'),
  )
  check('only the chosen tool is touched', !fs.existsSync(path.join(skillHome, '.agents')) && !fs.existsSync(path.join(skillHome, '.gemini')))
  check('the app says how to run it', /Type \/threefolds in any Claude Code session/.test((await page.textContent('.toast')) ?? ''))
  const examples = await page.locator('.skill-example code').allTextContents()
  check(
    'each provider has commands to try',
    examples.length === 9 && examples.includes('/threefolds') && examples.includes('$threefolds') && examples.some((text) => /pass this chat to Threefold/.test(text)),
    examples.join(' | '),
  )
  await page.locator('.skill-example', { hasText: '$threefolds then pass it to Threefold' }).click()
  check('a command can be copied with a click', (await app.evaluate(({ clipboard }) => clipboard.readText())) === '$threefolds then pass it to Threefold')
  await page.click('.skill-group[data-provider="gemini"] .btn:has-text("Copy the install message")')
  const installMessage = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(
    'chat apps get a message that creates the skill',
    /^Create a skill named "threefolds"/.test(installMessage) && /# Threefold handoff/.test(installMessage) && /Step 3: pass it on/.test(installMessage),
    installMessage.slice(0, 60),
  )
  await page.click('.skill-group[data-provider="claude"] .btn:has-text("Save the ZIP")')
  await page.waitForFunction(() => /Saved threefolds\.zip/.test(document.querySelector('.toast')?.textContent ?? ''))
  check('the ZIP for the Claude app is saved without a download', fs.statSync(path.join(skillHome, 'threefolds.zip')).size > 1000)
  await page.locator('.modal-body').evaluate((element) => element.scrollTo(0, 0))
  await shot('25-skill-tab')
  await claudeRow.locator('.btn:has-text("Remove")').click()
  await page.waitForFunction(() => document.querySelector('.skill-row[data-target="claude-code"] .status')?.textContent === 'Not installed')
  check('the skill can be taken out again', !fs.existsSync(skillFile) && !fs.existsSync(path.dirname(skillFile)))
  await page.click('.modal-close')

  // ---- updates: the check, the button and the dialog (nothing is installed here) ----
  check('the app asked for the newest release by itself, and shows no update when there is none', feed.asked >= 1 && (await page.locator('.update-pill').count()) === 0, `${feed.asked} request(s)`)
  check(
    'the app menu has Check for Updates',
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.some((item) => item.label.startsWith('Check for Updates'))),
  )
  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("About")')
  await page.waitForSelector('.update-settings')
  const autoSwitch = page.locator('.update-settings .switch')
  check('looking for updates is on, and says what it sends', (await autoSwitch.getAttribute('aria-checked')) === 'true' && /Nothing about you or your chats is sent/.test((await page.textContent('.update-settings')) ?? ''))
  await autoSwitch.click()
  await page.waitForFunction(() => document.querySelector('.update-settings .switch')?.getAttribute('aria-checked') === 'false')
  check('it can be switched off', JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'settings.json'), 'utf8')).updates.auto === false)
  await autoSwitch.click()
  await page.waitForFunction(() => document.querySelector('.update-settings .switch')?.getAttribute('aria-checked') === 'true')
  await page.click('.update-settings .btn:has-text("Check now")')
  await page.waitForFunction(() => /is the newest version/.test(document.querySelector('.update-row')?.textContent ?? ''))
  check('a check with nothing newer says so', new RegExp(`Threefold ${thisVersion.replace(/\./g, '\\.')} is the newest version`).test((await page.textContent('.update-row')) ?? ''))

  feed.version = '99.0.0'
  await page.click('.update-settings .btn:has-text("Check now")')
  await page.waitForSelector('.update-modal')
  const updateDialog = (await page.textContent('.update-modal')) ?? ''
  check(
    'a newer release opens the update dialog with both versions and the size',
    /Threefold 99\.0\.0 is available/.test(updateDialog) && updateDialog.includes(`You have ${thisVersion}`) && /290 MB/.test(updateDialog) && /See what is new/.test(updateDialog),
    updateDialog.slice(0, 120),
  )
  if (packaged) {
    check(
      'the installed app offers to update itself with one click, and says what will happen',
      (await page.locator('.update-modal .btn.primary:has-text("Update and restart")').count()) === 1 && /checks the download against the checksum/.test(updateDialog) && /old copy goes to the Trash/.test(updateDialog),
    )
  } else {
    check(
      'a copy run from the source is sent to the download page instead',
      /runs from the source code/.test(updateDialog) && (await page.locator('.update-modal .btn.primary:has-text("Open the download page")').count()) === 1,
    )
  }
  await page.waitForSelector('.toast', { state: 'detached', timeout: 9000 })
  await shot('26-update-dialog')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.update-modal', { state: 'detached' })
  check('the sidebar shows an update button while one is on offer', /Update to 99\.0\.0/.test((await page.textContent('.update-pill')) ?? ''))
  await shot('27-update-button')
  await page.click('.update-pill')
  await page.waitForSelector('.update-modal')
  check('the button opens the dialog again', true)
  await page.keyboard.press('Escape')
  feed.version = thisVersion
  await page.click('.user-row')
  await page.click('.modal-nav .side-btn:has-text("About")')
  await page.click('.update-settings .btn:has-text("Update…")')
  await page.keyboard.press('Escape')
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label.startsWith('Check for Updates')).click())
  await page.waitForSelector('.update-pill', { state: 'detached' })
  check('the button goes away once the installed version is the newest again', true)

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
  check('conversations are saved to disk', saved.length === 12, `${saved.length} saved`)
  const ledger = fs.readFileSync(path.join(dataDir, 'data', 'ledger.jsonl'), 'utf8').trim().split('\n')
  check('every request is written to the spend ledger', ledger.length === 22, `${ledger.length} entries`)
  const coding = ledger.map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'code')
  check(
    'only the part of a coding session that ran on the API key is on the ledger',
    coding.length === 2 && coding.every((entry) => entry.provider === 'claude' && entry.costUsd > 0),
    coding.map((entry) => `${entry.provider}:${entry.costUsd}`).join(','),
  )
  const summaries = ledger.map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'handoff')
  check(
    'each handoff summary is billed to the provider the chat moved to',
    summaries.map((entry) => entry.provider).join(',') === 'chatgpt,gemini' && summaries.every((entry) => entry.costUsd > 0),
    summaries.map((entry) => `${entry.provider}:${entry.costUsd}`).join(','),
  )
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
  fs.rmSync(fakeDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(skillHome, { recursive: true, force: true })
  feedServer.close()
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
