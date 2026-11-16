// One-click updates: which releases are listened to, what a download has to
// pass before it is installed, and that the swap really swaps (or puts the old
// copy back). The app-building parts use the Mac's own tools on a tiny stand-in app.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_BUNDLE_ID,
  UPDATE_ASSET,
  UPDATE_CHECKSUM,
  UPDATE_DOWNLOAD_BASE,
  bundlePathOf,
  isNewer,
  parseChecksumFile,
  parseVersion,
  pickRelease,
  updateBlocker,
  type UpdateState,
} from '@shared/update'
import { SWAP_SCRIPT, Updater, type UpdaterOptions } from '../src/main/updater'

// ---------- versions and GitHub's description of a release ----------

const HASH = 'a'.repeat(64)
function github(tag = 'v0.9.0', patch: Record<string, unknown> = {}, base = UPDATE_DOWNLOAD_BASE): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/nimeshbuilds/threefold/releases/tag/${tag}`,
    published_at: '2026-11-16T10:00:00Z',
    body: 'Release notes that the app never acts on.',
    assets: [
      { name: 'SKILL.md', size: 9000, browser_download_url: `${base}${tag}/SKILL.md` },
      { name: UPDATE_ASSET, size: 290_000_000, digest: `sha256:${HASH}`, browser_download_url: `${base}${tag}/${UPDATE_ASSET}` },
      { name: UPDATE_CHECKSUM, size: 90, browser_download_url: `${base}${tag}/${UPDATE_CHECKSUM}` },
    ],
    ...patch,
  }
}

describe('version numbers', () => {
  it('reads plain versions only', () => {
    expect(parseVersion('0.8.1')).toEqual([0, 8, 1])
    expect(parseVersion('v12.0.3')).toEqual([12, 0, 3])
    for (const bad of ['0.8', '0.8.1-beta', '0.8.1.2', 'latest', '', '1.2.x', ' v1.2.3 extra', undefined, 3]) expect(parseVersion(bad)).toBeNull()
  })

  it('knows which of two is newer, number by number', () => {
    expect(isNewer('0.8.0', '0.7.9')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.8.0', '0.8.0')).toBe(false)
    expect(isNewer('0.7.9', '0.8.0')).toBe(false)
    // Something that is not a version is never "newer".
    expect(isNewer('99.0.0-rc1', '0.1.0')).toBe(false)
    expect(isNewer('1.0.0', 'unknown')).toBe(false)
  })
})

describe('reading a release from GitHub', () => {
  it('takes the version, both files and the notes page', () => {
    expect(pickRelease(github())).toEqual({
      version: '0.9.0',
      tag: 'v0.9.0',
      notesUrl: 'https://github.com/nimeshbuilds/threefold/releases/tag/v0.9.0',
      zipUrl: `${UPDATE_DOWNLOAD_BASE}v0.9.0/${UPDATE_ASSET}`,
      checksumUrl: `${UPDATE_DOWNLOAD_BASE}v0.9.0/${UPDATE_CHECKSUM}`,
      sizeBytes: 290_000_000,
      digest: HASH,
      publishedAt: '2026-11-16T10:00:00Z',
    })
  })

  it('ignores drafts, pre-releases and tags that are not plain versions', () => {
    expect(pickRelease(github('v0.9.0', { draft: true }))).toBeNull()
    expect(pickRelease(github('v0.9.0', { prerelease: true }))).toBeNull()
    expect(pickRelease(github('v0.9.0-beta.1'))).toBeNull()
    expect(pickRelease(github('nightly'))).toBeNull()
    for (const junk of [null, [], 'text', 42, {}, { tag_name: 'v1.0.0' }]) expect(pickRelease(junk)).toBeNull()
  })

  it('takes files only from this project’s release address', () => {
    const elsewhere = (url: string): unknown => {
      const release = github()
      ;(release.assets as Array<Record<string, unknown>>)[1]!.browser_download_url = url
      return release
    }
    for (const url of [
      `https://evil.example/nimeshbuilds/threefold/releases/download/v0.9.0/${UPDATE_ASSET}`,
      `https://github.com/someone-else/threefold/releases/download/v0.9.0/${UPDATE_ASSET}`,
      `${UPDATE_DOWNLOAD_BASE}v0.9.1/${UPDATE_ASSET}`,
      `${UPDATE_DOWNLOAD_BASE}v0.9.0/${UPDATE_ASSET}?redirect=https://evil.example`,
      `${UPDATE_DOWNLOAD_BASE}v0.9.0/../../../../evil/${UPDATE_ASSET}`,
      `http://github.com/nimeshbuilds/threefold/releases/download/v0.9.0/${UPDATE_ASSET}`,
      'file:///tmp/Threefold-mac-arm64.zip',
    ]) {
      expect(pickRelease(elsewhere(url)), url).toBeNull()
    }
  })

  it('needs both files, at believable sizes', () => {
    const without = (name: string): unknown => {
      const release = github()
      release.assets = (release.assets as Array<Record<string, unknown>>).filter((asset) => asset.name !== name)
      return release
    }
    expect(pickRelease(without(UPDATE_ASSET))).toBeNull()
    expect(pickRelease(without(UPDATE_CHECKSUM))).toBeNull()
    const sized = (size: unknown): unknown => {
      const release = github()
      ;(release.assets as Array<Record<string, unknown>>)[1]!.size = size
      return release
    }
    for (const size of [0, -5, 9_000_000_000, 'big', Number.NaN]) expect(pickRelease(sized(size))).toBeNull()
  })

  it('builds the notes page itself when GitHub’s link points somewhere else', () => {
    expect(pickRelease(github('v0.9.0', { html_url: 'https://evil.example/notes' }))?.notesUrl).toBe('https://github.com/nimeshbuilds/threefold/releases/tag/v0.9.0')
  })

  it('reads the checksum file that the release script writes', () => {
    expect(parseChecksumFile(`${HASH}  ${UPDATE_ASSET}\n`)).toBe(HASH)
    expect(parseChecksumFile(`${HASH.toUpperCase()}  ${UPDATE_ASSET}`)).toBe(HASH)
    expect(parseChecksumFile(HASH)).toBe(HASH)
    for (const bad of [`${HASH}  some-other-file.zip`, HASH.slice(1), `${HASH}g`, '', `${HASH}  ${UPDATE_ASSET}\n${HASH}  extra`, 'x'.repeat(2000), null]) {
      expect(parseChecksumFile(bad)).toBeNull()
    }
    // The script that makes a release writes exactly this form.
    expect(fs.readFileSync(path.resolve(__dirname, '../scripts/release.mjs'), 'utf8')).toContain('`${digest}  ${path.basename(zip)}\\n`')
  })
})

describe('whether a copy can replace itself', () => {
  const ok = { packaged: true, platform: 'darwin', arch: 'arm64', exePath: '/Applications/Threefold.app/Contents/MacOS/Threefold', writable: () => true }

  it('finds the app an executable belongs to', () => {
    expect(bundlePathOf(ok.exePath)).toBe('/Applications/Threefold.app')
    expect(bundlePathOf('/Users/me/Applications/My Apps/Threefold.app/Contents/MacOS/Threefold')).toBe('/Users/me/Applications/My Apps/Threefold.app')
    expect(bundlePathOf('/usr/local/bin/threefold')).toBeNull()
    expect(bundlePathOf('/Applications/Threefold.app/Contents/Frameworks/x')).toBeNull()
  })

  it('says yes for an installed app in a folder it can write to', () => {
    expect(updateBlocker(ok)).toBeNull()
  })

  it('says why not otherwise', () => {
    expect(updateBlocker({ ...ok, packaged: false })).toMatch(/runs from the source code/)
    expect(updateBlocker({ ...ok, arch: 'x64' })).toMatch(/Apple Silicon/)
    expect(updateBlocker({ ...ok, exePath: '/private/var/folders/ab/T/AppTranslocation/1234/d/Threefold.app/Contents/MacOS/Threefold' })).toMatch(/Move Threefold into Applications/)
    expect(updateBlocker({ ...ok, exePath: '/Volumes/Threefold/Threefold.app/Contents/MacOS/Threefold' })).toMatch(/disk image/)
    const asked: string[] = []
    expect(updateBlocker({ ...ok, writable: (dir) => (asked.push(dir), false) })).toMatch(/cannot write to the folder it is in \(\/Applications\)/)
    expect(asked).toEqual(['/Applications'])
  })
})

// ---------- the updater against a stand-in release ----------

/** A tiny real app: a signed bundle with the right name and a version. */
function makeApp(dir: string, version: string, id = APP_BUNDLE_ID): string {
  const app = path.join(dir, 'Threefold.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Threefold</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  )
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Threefold'))
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
  return app
}

const versionOf = (app: string): string =>
  execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()

describe('checking for and installing an update', () => {
  let server: http.Server
  let base: string
  const files = new Map<string, { body: Buffer | string; status?: number }>()
  const hits: string[] = []
  let tmp: string
  let installed: string
  let states: UpdateState[]
  let quits: number
  let swaps: Array<{ script: string; args: string[] }>

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      hits.push(request.url ?? '')
      const file = files.get(request.url ?? '')
      if (!file) return void response.writeHead(404).end('not found')
      response.writeHead(file.status ?? 200).end(file.body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => void server.close())

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-update-'))
    fs.mkdirSync(path.join(tmp, 'Applications'))
    installed = makeApp(path.join(tmp, 'Applications'), '0.8.0')
    files.clear()
    hits.length = 0
    states = []
    quits = 0
    swaps = []
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  /** Publishes a release on the stand-in server. `inside` is what the ZIP really holds. */
  function publish(tag: string, inside: { version: string; id?: string }, tamper: { zip?: Buffer; checksum?: string; digest?: string; size?: number } = {}): void {
    const stage = fs.mkdtempSync(path.join(tmp, 'stage-'))
    const app = makeApp(stage, inside.version, inside.id)
    const zipFile = path.join(stage, UPDATE_ASSET)
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zipFile])
    const real = fs.readFileSync(zipFile)
    const zip = tamper.zip ?? real
    const sum = createHash('sha256').update(real).digest('hex')
    files.set(`/${tag}/${UPDATE_ASSET}`, { body: zip })
    files.set(`/${tag}/${UPDATE_CHECKSUM}`, { body: tamper.checksum ?? `${sum}  ${UPDATE_ASSET}\n` })
    const release = github(tag, {}, base)
    const assets = release.assets as Array<Record<string, unknown>>
    assets[1]!.size = tamper.size ?? real.length
    assets[1]!.digest = tamper.digest === '' ? undefined : `sha256:${tamper.digest ?? sum}`
    assets[2]!.size = 90
    files.set('/latest.json', { body: JSON.stringify(release) })
  }

  function updater(patch: Partial<UpdaterOptions> = {}): Updater {
    return new Updater({
      current: '0.8.0',
      feedUrl: `${base}latest.json`,
      downloadBase: base,
      workDir: path.join(tmp, 'updates'),
      bundlePath: installed,
      trashDir: path.join(tmp, 'Trash'),
      relaunch: false,
      emit: (state) => states.push(state),
      quit: () => (quits += 1),
      launchSwap: (script, args) => swaps.push({ script, args }),
      ...patch,
    })
  }

  /** Runs the helper the way the app would, with a process that has already ended. */
  function runSwap(swap: { script: string; args: string[] }): number | null {
    const ended = spawnSync('/usr/bin/true')
    return spawnSync('/bin/sh', [swap.script, String(ended.pid), ...swap.args.slice(1)]).status
  }

  it('offers a newer release and nothing else', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const one = updater()
    expect(one.get()).toEqual({ current: '0.8.0', status: 'idle', manual: undefined })
    const found = await one.check(true)
    expect(found).toMatchObject({ status: 'available', latest: { version: '0.9.0', notesUrl: 'https://github.com/nimeshbuilds/threefold/releases/tag/v0.9.0' } })
    expect(found.checkedAt).toBeGreaterThan(0)
    // Only the release description was fetched: nothing is downloaded until the user clicks.
    expect(hits).toEqual(['/latest.json'])

    // The same version, or an older one, is not an update.
    expect(await updater({ current: '0.9.0' }).check(true)).toMatchObject({ status: 'idle', latest: undefined })
    expect(await updater({ current: '1.0.0' }).check(true)).toMatchObject({ status: 'idle', latest: undefined })
  })

  it('never asks when it is offline, and stays quiet when a background check fails', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const offline = updater({ offline: true })
    expect(await offline.check(true)).toMatchObject({ status: 'idle' })
    expect(hits).toEqual([])

    files.set('/latest.json', { body: 'down', status: 503 })
    const quiet = updater()
    const silent = await quiet.check(false)
    expect(silent.status).toBe('idle')
    expect(silent.error).toBeUndefined()
    expect(states).toEqual([])
    // Asked for by the user, the same failure is reported.
    const asked = await quiet.check(true)
    expect(asked.status).toBe('error')
    expect(asked.error).toMatch(/could not reach GitHub.*503/)
  })

  it('downloads, checks and swaps on one call, and keeps the old copy in the Trash', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const one = updater()
    await one.check(true)
    expect(await one.install()).toEqual({ ok: true })
    expect(states.map((state) => state.status).filter((status, i, all) => status !== all[i - 1])).toEqual(['checking', 'available', 'downloading', 'verifying', 'installing'])
    expect(quits).toBe(1)
    // Nothing has moved yet: the swap waits for the app to close.
    expect(versionOf(installed)).toBe('0.8.0')
    expect(swaps).toHaveLength(1)
    const [pid, fresh, target, retired, reopen, result] = swaps[0]!.args
    expect(pid).toBe(String(process.pid))
    expect(target).toBe(installed)
    expect(versionOf(fresh!)).toBe('0.9.0')
    expect(path.dirname(retired!)).toBe(path.join(tmp, 'Trash'))
    expect(path.basename(retired!)).toMatch(/^Threefold 0\.8\.0 \(replaced \d{8}-\d{6}\)\.app$/)
    expect(reopen).toBe('0')
    expect(fs.readFileSync(swaps[0]!.script, 'utf8')).toBe(SWAP_SCRIPT)
    // The ZIP is gone once it has been unpacked; only the new app is waiting.
    expect(fs.existsSync(path.join(tmp, 'updates', UPDATE_ASSET))).toBe(false)

    expect(runSwap(swaps[0]!)).toBe(0)
    expect(versionOf(installed)).toBe('0.9.0')
    expect(versionOf(retired!)).toBe('0.8.0')
    expect(fs.readFileSync(result!, 'utf8').trim()).toBe('ok')
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', installed]).status).toBe(0)

    // The next start clears the work folder and has nothing to report.
    const next = updater({ current: '0.9.0' })
    expect(next.get().status).toBe('idle')
    expect(next.get().error).toBeUndefined()
    expect(fs.existsSync(path.join(tmp, 'updates'))).toBe(false)
  })

  it('says once that it has just been updated', () => {
    const one = updater({ current: '0.9.0' })
    one.noteUpdatedFrom('0.8.0')
    expect(one.get().updatedFrom).toBe('0.8.0')
    one.clearUpdatedFrom()
    expect(one.get().updatedFrom).toBeUndefined()
    // A first run, or a copy that is older than the last one used, is not "updated".
    const first = updater({ current: '0.9.0' })
    first.noteUpdatedFrom(undefined)
    first.noteUpdatedFrom('0.9.0')
    first.noteUpdatedFrom('1.0.0')
    expect(first.get().updatedFrom).toBeUndefined()
  })

  const refused: Array<[string, () => void, RegExp]> = [
    ['a download that does not match its checksum', () => publish('v0.9.0', { version: '0.9.0' }, { checksum: `${'b'.repeat(64)}  ${UPDATE_ASSET}\n`, digest: '' }), /does not match its published checksum/],
    ['a checksum that GitHub’s own record contradicts', () => publish('v0.9.0', { version: '0.9.0' }, { digest: 'c'.repeat(64) }), /does not match the one GitHub reports/],
    ['a checksum file that is not one', () => publish('v0.9.0', { version: '0.9.0' }, { checksum: 'see the release page' }), /checksum published with this release could not be read/],
    ['an app that is not Threefold', () => publish('v0.9.0', { version: '0.9.0', id: 'com.example.other' }), /is not Threefold/],
    ['an app that is not the announced version', () => publish('v0.9.0', { version: '0.9.1' }), /not the version that was announced/],
    ['an app that is older than it claims, behind a newer tag', () => publish('v0.9.0', { version: '0.7.0' }), /not the version that was announced/],
    ['a download that is cut short', () => publish('v0.9.0', { version: '0.9.0' }, { size: 999_999 }), /cut short|larger than the release says/],
  ]
  for (const [what, arrange, message] of refused) {
    it(`refuses ${what}`, async () => {
      arrange()
      const one = updater()
      await one.check(true)
      const result = await one.install()
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(message)
      // Nothing was swapped, the app was not closed, and the download is gone.
      expect(swaps).toEqual([])
      expect(quits).toBe(0)
      expect(versionOf(installed)).toBe('0.8.0')
      expect(fs.existsSync(path.join(tmp, 'updates'))).toBe(false)
      // The update is still on offer, with the reason shown.
      expect(one.get()).toMatchObject({ status: 'available', error: result.error })
    })
  }

  it('refuses an app whose seal is broken', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const tampering = updater({
      run: async (file, args) => {
        // Change the app between unpacking and the integrity check, as a damaged download would be.
        if (file.endsWith('codesign')) fs.appendFileSync(path.join(args[args.length - 1]!, 'Contents', 'MacOS', 'Threefold'), 'x')
        return new Promise((resolve) => {
          const done = spawnSync(file, args, { encoding: 'utf8' })
          resolve({ code: done.status, stdout: done.stdout, stderr: done.stderr })
        })
      },
    })
    await tampering.check(true)
    expect((await tampering.install()).error).toMatch(/failed its integrity check/)
    expect(swaps).toEqual([])
    expect(versionOf(installed)).toBe('0.8.0')
  })

  it('does not install when nothing was found, or when this copy cannot replace itself', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    expect(await updater().install()).toEqual({ ok: false, error: 'There is no update to install.' })
    const stuck = updater({ bundlePath: null, manual: 'This copy runs from the source code, so it is updated with Git instead.' })
    // It still learns that an update exists, so the window can point at the download page.
    expect(await stuck.check(true)).toMatchObject({ status: 'available', manual: expect.stringMatching(/source code/) })
    expect(await stuck.install()).toEqual({ ok: false, error: 'This copy runs from the source code, so it is updated with Git instead.' })
    expect(hits).toEqual(['/latest.json'])
  })

  it('puts the old copy back when the new one cannot be moved into place, and says so at the next start', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const one = updater()
    await one.check(true)
    await one.install()
    const [, fresh, , retired, , result] = swaps[0]!.args
    // The new copy vanishes before the swap.
    fs.renameSync(fresh!, `${fresh}.gone`)
    expect(runSwap(swaps[0]!)).toBe(1)
    expect(versionOf(installed)).toBe('0.8.0')
    expect(fs.existsSync(retired!)).toBe(false)
    expect(fs.readFileSync(result!, 'utf8')).toMatch(/^failed/)
    expect(updater().get()).toMatchObject({ status: 'error', error: expect.stringMatching(/could not be installed, so Threefold is unchanged/) })
  })

  it('waits for the app to close before it swaps', async () => {
    publish('v0.9.0', { version: '0.9.0' })
    const one = updater()
    await one.check(true)
    await one.install()
    const { script, args } = swaps[0]!
    // Stand in for the app with a process that takes a moment to end.
    const app = spawnSync('/bin/sh', ['-c', 'sleep 0.6 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
    const started = Date.now()
    const status = spawnSync('/bin/sh', [script, app.stdout.trim(), ...args.slice(1)]).status
    expect(status).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(versionOf(installed)).toBe('0.9.0')
  })
})
