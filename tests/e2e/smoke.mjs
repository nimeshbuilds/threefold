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

  await page.click('.sub-modal .btn:has-text("Update Claude Code")')
  await stepStatus(0, /Up to date/)
  const updated = (await step(0).textContent()) ?? ''
  check('the CLI is updated from inside the app', /Version 2\.1\.325, the newest\./.test(updated) && /Update complete\./.test(updated), updated.slice(0, 160))

  await page.click('.sub-modal .btn:has-text("Sign in with Claude")')
  await stepStatus(1, /Signed in · Max plan/)
  const signedIn = (await step(1).textContent()) ?? ''
  check(
    'signing in runs the CLI’s own sign-in and passes on its link',
    /claude\.ai\/oauth\/authorize/.test(signedIn) && /Login successful/.test(signedIn) && /never sees your password or any token/.test(signedIn),
    signedIn.slice(0, 160),
  )
  await page.click('.sub-modal .switch')
  check('the subscription can be switched on once the CLI is ready', (await page.getAttribute('.sub-modal .switch', 'aria-checked')) === 'true')
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

  await page.fill('.code-main .composer textarea', 'Now hit the LIMIT')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.permission', { timeout: 20000 })
  await page.click('.permission .btn.primary')
  const apiLine = (await (await codeNotice('Ran on your API key')).textContent()) ?? ''
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
    claudeCalls.map((call) => `${call.auth}:${call.resume ?? 'new'}`).join(' ') === 'plan:new plan:claude-session-1 api:claude-session-1',
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
  await page.click('.sub-modal .switch')
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
  await page.click('.handoff-menu .menu-item:has-text("Gemini")')
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
  check('the paste dialog names the skill', /threefolds/.test((await page.textContent('.handoff-modal')) ?? ''))
  check('nothing can be continued until a summary is pasted', await page.locator('.handoff-modal .btn.primary').isDisabled())
  await page.click('.handoff-modal .btn:has-text("Copy the prompt")')
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  check('the prompt for apps without Skills can be copied', /^Follow the instructions below/.test(copied) && /# Threefold handoff/.test(copied) && /end of handoff/.test(copied), copied.slice(0, 50))
  await page.fill(
    '.handoff-input',
    'Sure, here it is:\n\n# Threefold handoff\n\n**Title:** Budget review\n**From:** ChatGPT\n\n## Goal\nCut hosting costs by a third.\n\n--- end of handoff ---\nCopy this message.',
  )
  await shot('20-handoff-paste')
  await page.click('.handoff-modal .btn.primary')
  await page.waitForSelector('.handoff-card')
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
  check('conversations are saved to disk', saved.length === 11, `${saved.length} saved`)
  const ledger = fs.readFileSync(path.join(dataDir, 'data', 'ledger.jsonl'), 'utf8').trim().split('\n')
  check('every request is written to the spend ledger', ledger.length === 20, `${ledger.length} entries`)
  const coding = ledger.map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'code')
  check(
    'only the part of a coding session that ran on the API key is on the ledger',
    coding.length === 1 && coding[0].provider === 'claude' && coding[0].costUsd > 0,
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
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
