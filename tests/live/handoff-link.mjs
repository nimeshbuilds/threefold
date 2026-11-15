// A check that macOS really delivers a threefold://handoff link to the packaged
// app: once while the app is running, and once when the link has to start it.
//
// The end-to-end suite sends the app the same event macOS would. This goes one
// step further and asks macOS to open the link, the way the threefolds skill
// does with `open "threefold://handoff?from=…"`.
//
// It runs in demo mode on a throwaway profile: no keys, no network, no cost.
// The link is sent to this build by path (open -a), so it does not matter which
// copy of Threefold macOS would pick for the link on its own. The last line
// reports which copy that is.
//
// Usage: pnpm dist && node tests/live/handoff-link.mjs [screenshot-dir]

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, chromium } from 'playwright-core'

const bundle = path.resolve(process.env.THREEFOLD_BUNDLE ?? 'dist/mac-arm64/Threefold.app')
const binary = path.join(bundle, 'Contents/MacOS/Threefold')
if (!fs.existsSync(binary)) {
  console.error(`No packaged app at ${bundle}. Run "pnpm dist" first.`)
  process.exit(1)
}
const shots = path.resolve(process.argv[2] ?? 'tests/live/screenshots')
fs.mkdirSync(shots, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-link-'))
const inbox = path.join(dataDir, 'inbox')
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}
const handoff = (title, from) =>
  `# Threefold handoff\n\n- **Title:** ${title}\n- **From:** ${from}\n\n## Goal\nCheck that a real link reaches the app.\n\n--- end of handoff ---\n`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- the app declares the link ----
const plist = execFileSync('plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' })
const schemes = JSON.parse(plist).flatMap((type) => type.CFBundleURLSchemes ?? [])
check('the packaged app declares the threefold:// link to macOS', schemes.length === 1 && schemes[0] === 'threefold', schemes.join(','))

const env = { ...process.env, THREEFOLD_DEMO: '1', THREEFOLD_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' }

// ---- 1. the app is running, and macOS is asked to open the link ----
const app = await electron.launch({ executablePath: binary, args: [], env })
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.onboarding', { timeout: 20000 })
  for (let step = 0; step < 6; step++) await page.click('.onboarding-foot .btn.primary')
  await page.waitForSelector('.onboarding', { state: 'detached' })

  fs.writeFileSync(path.join(inbox, 'handoff-20261115-120000.md'), handoff('Sent while running', 'Claude Opus 5.5'))
  // Links that are not the handoff link first: they must do nothing.
  spawnSync('open', ['-g', '-a', bundle, 'threefold://artifact/anything'])
  spawnSync('open', ['-g', '-a', bundle, 'threefold://file/keys.json'])
  await sleep(1500)
  check('other threefold:// links from macOS are ignored', (await page.locator('.modal').count()) === 0 && fs.readdirSync(inbox).length === 1)

  const sent = spawnSync('open', ['-g', '-a', bundle, 'threefold://handoff?from=claude'], { encoding: 'utf8' })
  check('macOS accepts the link for this app', sent.status === 0, sent.stderr.trim())
  await page.waitForSelector('.incoming-modal', { timeout: 15000 })
  const text = (await page.textContent('.incoming-modal')) ?? ''
  check('the running app shows the handoff that macOS delivered', /Sent while running/.test(text) && /Says it is fromClaude/.test(text), text.slice(0, 120))
  check('the file has left the inbox', fs.readdirSync(inbox).length === 0)
  await page.screenshot({ path: path.join(shots, 'link-running.png') })
  await page.click('.incoming-modal .btn.primary')
  await page.waitForSelector('.handoff-card')
  check('continuing lands in the sender’s mode', (await page.getAttribute('html', 'data-mode')) === 'claude' && /Sent while running/.test((await page.textContent('.topbar-title')) ?? ''))
} catch (error) {
  check('part 1 ran to completion', false, String(error).split('\n')[0])
} finally {
  await app.close()
}

// ---- 2. the app is not running: the link starts it ----
const port = 9400 + Math.floor(Math.random() * 400)
fs.writeFileSync(path.join(inbox, 'handoff-20261115-130000.md'), handoff('Sent to a closed app', 'Gemini 3.5 Pro'))
const started = spawnSync(
  'open',
  ['-n', '-a', bundle, '--env', 'THREEFOLD_DEMO=1', '--env', `THREEFOLD_DATA_DIR=${dataDir}`, 'threefold://handoff?from=gemini', '--args', `--remote-debugging-port=${port}`],
  { encoding: 'utf8' },
)
check('macOS starts the app for the link', started.status === 0, started.stderr.trim())
let browser = null
try {
  for (let attempt = 0; attempt < 40 && !browser; attempt++) {
    await sleep(500)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null)
  }
  if (!browser) throw new Error('the app did not come up')
  let page = null
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages())[0] ?? null
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('the app opened no window')
  await page.waitForSelector('.incoming-modal', { timeout: 20000 })
  const text = (await page.textContent('.incoming-modal')) ?? ''
  check('an app started by the link shows the handoff as soon as it opens', /Sent to a closed app/.test(text) && /Says it is fromGemini/.test(text), text.slice(0, 120))
  check('the mode of the sender is preselected', (await page.textContent('.incoming-pick .seg button.active')) === 'Gemini')
  check('the file has left the inbox', fs.readdirSync(inbox).length === 0)
  await page.screenshot({ path: path.join(shots, 'link-cold-start.png') })
} catch (error) {
  check('part 2 ran to completion', false, String(error).split('\n')[0])
} finally {
  await browser?.close().catch(() => {})
  // Stop only the copy this script started, found by the port it was given.
  spawnSync('pkill', ['-f', `remote-debugging-port=${port}`])
  await sleep(800)
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ---- which copy of the app macOS would open for the link by itself ----
const handler = spawnSync(
  'osascript',
  ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("threefold://handoff")); u.isNil() ? "none" : u.path.js'],
  { encoding: 'utf8' },
)
console.log(`\nmacOS opens threefold:// links with: ${handler.stdout.trim() || handler.stderr.trim()}`)

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
