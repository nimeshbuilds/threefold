// A real self-update of the packaged app, on throwaway copies.
//
// Part 1 uses a stand-in for GitHub on this Mac: a copy of the packaged app is
// told that version 99.0.0 exists, and clicks "Update and restart". The app
// downloads the new copy, checks it, closes, and its helper swaps it in. The
// test then opens the swapped copy and reads its version.
//
// Part 2 (UPDATE_REAL_GITHUB=1) does the same against the real release page on
// GitHub: a copy that is told it is an older version updates itself to
// whatever the newest published release is. That downloads about 290 MB.
//
// Both run in demo mode on a throwaway profile. The copies being updated live
// in a temporary folder, the "Trash" is a folder beside them, and the swapped
// copy is not reopened by the helper, so nothing here touches an installed
// Threefold, the real Trash or the real profile.
//
// Usage: pnpm dist && node tests/live/update-real.mjs [screenshot-dir]

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const built = path.resolve(process.env.THREEFOLD_BUNDLE ?? 'dist/mac-arm64/Threefold.app')
if (!fs.existsSync(path.join(built, 'Contents/MacOS/Threefold'))) {
  console.error(`No packaged app at ${built}. Run "pnpm dist" first.`)
  process.exit(1)
}
const shots = path.resolve(process.argv[2] ?? 'tests/live/screenshots')
fs.mkdirSync(shots, { recursive: true })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-selfupdate-'))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const versionOf = (app) => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const copyApp = (to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  execFileSync('ditto', [built, to])
  return to
}
const builtVersion = versionOf(built)

/** Opens a copy, clicks through the first-run wizard, and returns the app and its window. */
async function open(appPath, env) {
  const app = await electron.launch({
    executablePath: path.join(appPath, 'Contents/MacOS/Threefold'),
    args: [],
    env: { ...process.env, THREEFOLD_DEMO: '1', ELECTRON_RENDERER_URL: '', ...env },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app, .onboarding', { timeout: 20000 })
  if (await page.locator('.onboarding').count()) {
    for (let step = 0; step < 6; step++) await page.click('.onboarding-foot .btn.primary')
    await page.waitForSelector('.onboarding', { state: 'detached' })
  }
  return { app, page }
}

/** Clicks the update button and "Update and restart", then waits for the swap to be over. */
async function updateItself(name, installed, env, expectVersion) {
  const dataDir = path.join(root, `${name}-profile`)
  const trash = path.join(root, `${name}-trash`)
  const before = versionOf(installed)
  const { app, page } = await open(installed, { THREEFOLD_DATA_DIR: dataDir, THREEFOLD_UPDATE_NO_RELAUNCH: '1', THREEFOLD_UPDATE_TRASH: trash, ...env })
  let closed = false
  app.on('close', () => (closed = true))
  try {
    await page.waitForSelector('.update-pill', { timeout: 30000 })
    const pill = (await page.textContent('.update-pill')) ?? ''
    check(`${name}: the update button appears by itself`, /Update to \d+\.\d+\.\d+/.test(pill), pill)
    await page.click('.update-pill')
    await page.waitForSelector('.update-modal')
    await page.screenshot({ path: path.join(shots, `update-${name}-dialog.png`) })
    await page.click('.update-modal .btn.primary:has-text("Update and restart")')
    // The download, the checks, and then the app closes by itself.
    const seen = new Set()
    for (let i = 0; i < 3000 && !closed; i++) {
      const text = await page.textContent('.update-progress').catch(() => null)
      if (text) seen.add(text.replace(/ · .*/, '').replace('…', ''))
      const error = await page.textContent('.update-note.error').catch(() => null)
      if (error) throw new Error(`the app reported: ${error}`)
      await sleep(100)
    }
    check(`${name}: it shows the download and the checks, then closes by itself`, closed && seen.has('Downloading'), [...seen].join(', '))
  } catch (error) {
    check(`${name}: the update ran to the end`, false, String(error).split('\n')[0])
    await app.close().catch(() => {})
    return null
  }
  // The helper swaps once the app has gone.
  let after = before
  for (let i = 0; i < 150 && after === before; i++) {
    await sleep(200)
    after = versionOf(installed)
  }
  check(`${name}: the app in place is now the new version`, after !== before && (!expectVersion || after === expectVersion), `${before} -> ${after}`)
  check(`${name}: the new copy has an intact seal`, spawnSync('codesign', ['--verify', '--deep', '--strict', installed]).status === 0)
  const retired = fs.existsSync(trash) ? fs.readdirSync(trash) : []
  // The old copy is named after the version the app believed it was, which part 2 overrides.
  const believed = env.THREEFOLD_UPDATE_CURRENT ?? before
  check(
    `${name}: the old copy is in the Trash folder, whole`,
    retired.length === 1 && new RegExp(`^Threefold ${believed.replace(/\./g, '\\.')} \\(replaced \\d{8}-\\d{6}\\)\\.app$`).test(retired[0]) && versionOf(path.join(trash, retired[0])) === before,
    retired.join(', '),
  )
  check(`${name}: the helper recorded success`, fs.readFileSync(path.join(dataDir, 'updates', 'result.txt'), 'utf8').trim() === 'ok')
  return { dataDir, after }
}

// ---------- part 1: a stand-in for GitHub ----------
try {
  const installed = copyApp(path.join(root, 'local/Applications/Threefold.app'))
  // The "release": the same app with a higher version number, sealed again and zipped as a release is.
  const next = copyApp(path.join(root, 'local/release/Threefold.app'))
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    execFileSync('plutil', ['-replace', key, '-string', '99.0.0', path.join(next, 'Contents/Info.plist')])
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', next], { stdio: 'ignore' })
  const served = path.join(root, 'local/served/v99.0.0')
  fs.mkdirSync(served, { recursive: true })
  const zip = path.join(served, 'Threefold-mac-arm64.zip')
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', next, zip])
  const digest = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
  fs.writeFileSync(`${zip}.sha256`, `${digest}  Threefold-mac-arm64.zip\n`)

  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}/`
    if (request.url === '/latest.json') {
      return void response.writeHead(200).end(
        JSON.stringify({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/nimeshbuilds/threefold/releases/tag/v99.0.0',
          assets: ['Threefold-mac-arm64.zip', 'Threefold-mac-arm64.zip.sha256'].map((name) => ({
            name,
            size: fs.statSync(path.join(served, name)).size,
            browser_download_url: `${base}v99.0.0/${name}`,
          })),
        }),
      )
    }
    const file = path.join(root, 'local/served', decodeURIComponent(request.url ?? ''))
    if (!file.startsWith(served) || !fs.existsSync(file)) return void response.writeHead(404).end()
    response.writeHead(200, { 'content-length': fs.statSync(file).size })
    fs.createReadStream(file).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const done = await updateItself('local', installed, { THREEFOLD_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/latest.json` }, '99.0.0')
  if (done) {
    // Open the swapped copy on the same profile, as the helper would have, and ask it what it is.
    // The stand-in release only had its bundle's version raised; the version the app reads from
    // inside itself is still the built one, so it is told its new number here. A real release has both.
    const { app, page } = await open(installed, {
      THREEFOLD_DATA_DIR: done.dataDir,
      THREEFOLD_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/latest.json`,
      THREEFOLD_UPDATE_CURRENT: '99.0.0',
    })
    try {
      await page.waitForSelector('.toast', { timeout: 10000 })
      const toast = (await page.textContent('.toast')) ?? ''
      check('local: the new copy opens and says it was updated', toast.includes(`updated from ${builtVersion} to 99.0.0`), toast)
      await page.click('.user-row')
      await page.click('.modal-nav .side-btn:has-text("About")')
      const about = (await page.textContent('.modal-body')) ?? ''
      check('local: it reports the new version and offers no further update', /Threefold 99\.0\.0/.test(about) && (await page.locator('.update-pill').count()) === 0)
      check('local: the download was cleared away', !fs.existsSync(path.join(done.dataDir, 'updates')))
      await page.screenshot({ path: path.join(shots, 'update-local-after.png') })
    } finally {
      await app.close()
    }
  }
  server.close()
} catch (error) {
  check('part 1 ran to completion', false, String(error).split('\n')[0])
}

// ---------- part 2: the real release page on GitHub ----------
if (process.env.UPDATE_REAL_GITHUB === '1') {
  try {
    const installed = copyApp(path.join(root, 'github/Applications/Threefold.app'))
    const pretend = process.env.UPDATE_PRETEND_VERSION ?? '0.0.1'
    // The copy keeps its real version on disk; it is only told that it is older, so that the newest release counts as an update.
    const done = await updateItself('github', installed, { THREEFOLD_UPDATE_FEED: 'default', THREEFOLD_UPDATE_CURRENT: pretend })
    if (done) console.log(`      the copy is now the published release ${done.after}`)
  } catch (error) {
    check('part 2 ran to completion', false, String(error).split('\n')[0])
  }
} else {
  console.log('SKIP  the same against the real GitHub release page (set UPDATE_REAL_GITHUB=1; downloads about 290 MB)')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
