// A check of "Use subscription" with the real Claude Code and Codex, in the
// real app, on a throwaway profile.
//
// It needs a person. When a CLI is not signed in, the app's own button starts
// the CLI's sign-in, which opens its maker's page in the browser, and someone
// has to approve it there. This script types nothing into that page.
//
// No API key is involved, so nothing can be billed to one. It sends one small
// prompt to each plan that is signed in.
//
// Usage: pnpm build && node tests/live/subscription-real.mjs [screenshot-dir]
// Set THREEFOLD_APP to a packaged binary to check the packaged app instead.
// REAL_WAIT_MIN (default 6) is how long it waits for the sign-in to be approved.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.argv[2] ?? 'tests/live/screenshots')
fs.mkdirSync(shots, { recursive: true })
const waitMs = Number(process.env.REAL_WAIT_MIN ?? 6) * 60_000
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-real-'))
const report = {}
const say = (line) => console.log(line)

// What an app opened from the Finder gets: no shell profile, nothing from this terminal.
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  SHELL: process.env.SHELL ?? '/bin/zsh',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  THREEFOLD_DATA_DIR: dataDir,
  ELECTRON_RENDERER_URL: '',
}

const packaged = process.env.THREEFOLD_APP
const app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }), env })
const page = await app.firstWindow()
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) })
const text = async (selector) => ((await page.locator(selector).count()) ? ((await page.locator(selector).first().textContent()) ?? '') : '')
const hideEmail = (value) => value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<email>')

async function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `threefold-real-${name}-`))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'This is a draft.\n')
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, dir)
  return dir
}

/** Opens the panel for the current mode and does whatever its one button offers. True when it ends switched on. */
async function setUp(label) {
  const out = (report[label] = {})
  await page.click('.side-btn:has-text("Code")')
  await page.waitForSelector('.code-layout')
  await page.click('.sub-button')
  await page.waitForSelector('.sub-modal')
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('.sub-modal .sub-step .status')?.textContent ?? 'Checking'), null, { timeout: 30000 })
  const statuses = await page.locator('.sub-modal .sub-step .status').allTextContents()
  out.found = { cli: statuses[0], account: statuses[1], use: statuses[2], line: hideEmail(await text('.sub-modal .sub-step .sub-line')) }
  out.button = (await text('.sub-go')).trim()
  say(`[${label}] CLI: ${statuses[0]} · account: ${statuses[1]} · button: "${out.button}"`)
  await shot(`${label}-1-panel`)
  if (await page.locator('.sub-done').count()) return true

  await page.click('.sub-go')
  if (/sign in/i.test(out.button)) {
    await page.waitForSelector('.sub-signin', { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(4000)
    // The start of what the CLI printed says whether it opened the browser itself.
    out.signInOutput = hideEmail(((await page.locator('.sub-modal .cli-log').last().textContent()) ?? '').replace(/https?:\/\/\S+/g, '<link>')).slice(0, 500)
    out.linkOffered = (await page.locator('.sub-signin .btn:has-text("Open the sign-in page")').count()) === 1
    await shot(`${label}-2-signing-in`)
    say(`[${label}] The sign-in page should be open in the browser. Waiting up to ${waitMs / 60000} minutes for it to be approved…`)
  }
  const done = await page.waitForSelector('.sub-done', { timeout: waitMs }).then(() => true, () => false)
  out.switchedOn = done
  out.after = await page.locator('.sub-modal .sub-step .status').allTextContents()
  await shot(`${label}-3-after-setup`)
  if (!done) {
    // Leave nothing half-done behind.
    if (await page.locator('.sub-setup .btn:has-text("Cancel")').count()) await page.click('.sub-setup .btn:has-text("Cancel")')
    await page.waitForTimeout(800)
  }
  await page.click('.sub-modal .btn:has-text("Done")')
  return done
}

/** Opens a project, sends one small prompt, allows what is asked, and records what happened. */
async function runOnce(label, planWords) {
  const out = report[label]
  const dir = await project(label)
  await page.click('.code-sessions .btn.primary')
  await page.waitForSelector('.engine-tag')
  out.engine = await text('.engine-tag')
  await page.fill('.code-main .composer textarea', 'In notes.txt, change the word "draft" to "final". Do nothing else, and reply with one short sentence.')
  const started = Date.now()
  await page.keyboard.press('Enter')
  await page.waitForSelector('.send-btn.stop', { timeout: 15000 })
  out.asked = []
  const deadline = Date.now() + 5 * 60_000
  while (await page.locator('.send-btn.stop').count()) {
    if (await page.locator('.permission').count()) {
      out.asked.push((await text('.permission .permission-head')).replace(/\s+/g, ' ').trim())
      if (out.asked.length === 1) await shot(`${label}-4-asked`)
      await page.click('.permission .btn.primary')
    }
    if (Date.now() > deadline) {
      out.timedOut = true
      await page.click('.send-btn.stop')
      break
    }
    await page.waitForTimeout(400)
  }
  out.seconds = Math.round((Date.now() - started) / 1000)
  out.notices = (await page.locator('.code-main .msg-error').allTextContents()).map((line) => hideEmail(line.replace(/\s+/g, ' ').trim()))
  out.tools = (await page.locator('.code-main .event .event-head').allTextContents()).map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 90))
  out.reply = (await page.locator('.code-main .msg.assistant').allTextContents()).map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 160))
  out.fileAfter = fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')
  out.cost = await text('.code-page .cost-chip')
  out.ranOnPlan = out.notices.some((line) => line.includes(planWords))
  await shot(`${label}-5-run`)
  fs.rmSync(dir, { recursive: true, force: true })
  say(`[${label}] ${out.ranOnPlan ? 'ran on the plan' : 'did NOT run on the plan'} in ${out.seconds}s · file now: ${JSON.stringify(out.fileAfter)}`)
}

try {
  await page.waitForSelector('.onboarding', { timeout: 20000 })
  await page.fill('.welcome input', 'Sam')
  for (let i = 0; i < 10 && (await page.locator('.onboarding').count()); i++) {
    await page.click('.onboarding-foot .btn.primary')
    await page.waitForTimeout(250)
  }
  await page.waitForSelector('.onboarding', { state: 'detached', timeout: 10000 })

  // REAL_ONLY=claude or REAL_ONLY=codex checks just that one.
  const only = process.env.REAL_ONLY
  if (only !== 'codex') {
    await page.click('.mode-switch button:has-text("Claude")')
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'claude')
    if (await setUp('claude')) await runOnce('claude', 'Ran on your Claude plan')
  }
  if (only !== 'claude') {
    await page.click('.side-btn:has-text("New chat")')
    await page.click('.mode-switch button:has-text("ChatGPT")')
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'chatgpt')
    if (await setUp('codex')) await runOnce('codex', 'Ran on your ChatGPT plan')
  }

  const ledger = path.join(dataDir, 'data', 'ledger.jsonl')
  report.ledgerEntries = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
  report.apiKeysSaved = fs.existsSync(path.join(dataDir, 'keys.json'))
} catch (error) {
  report.error = String(error).split('\n')[0]
  await shot('failure').catch(() => {})
} finally {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 1))
