// One-click updates.
//
// Threefold asks GitHub which release is the newest. When that is newer than
// the copy that is running, the window shows an update button. One click then
// downloads the release, checks it, swaps it for this copy and opens it again.
//
// The app is not signed with an Apple Developer ID, so the system's own update
// machinery cannot be used. What this does instead:
//  1. Only GitHub is asked, and files are taken only from this project's
//     release address (see pickRelease).
//  2. The download must match the checksum published beside it, and the one
//     GitHub reports for the file when it reports one.
//  3. The unpacked app must have an intact seal, be Threefold, and be exactly
//     the newer version that was announced. Nothing in it is run before that.
//  4. A small helper waits for this copy to close, moves it to the Trash, moves
//     the new copy into its place and opens it. If the swap fails, the old
//     copy is put back.
// Nothing is installed unless the user clicks. The chats, settings and keys
// live outside the app and are not touched.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  APP_BUNDLE_ID,
  MAX_UPDATE_BYTES,
  UPDATE_ASSET,
  isNewer,
  parseChecksumFile,
  pickRelease,
  type UpdateRelease,
  type UpdateState,
} from '@shared/update'

/** Waits for the running copy to close, then swaps. Paths arrive as arguments, never inside the script. */
export const SWAP_SCRIPT = `#!/bin/sh
# Threefold update helper.
# $1 process to wait for   $2 new app   $3 installed app   $4 where the old copy goes
# $5 "1" to open the app afterwards   $6 file that records how it went
tries=0
while kill -0 "$1" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "failed: Threefold did not close" > "$6"
    exit 1
  fi
  sleep 0.2
done
if [ ! -d "$2" ] || [ ! -d "$3" ]; then
  echo "failed: a copy of the app was missing" > "$6"
  [ "$5" = "1" ] && open "$3"
  exit 1
fi
if mv "$3" "$4"; then
  if mv "$2" "$3"; then
    echo "ok" > "$6"
    [ "$5" = "1" ] && open "$3"
    exit 0
  fi
  mv "$4" "$3"
fi
echo "failed: the new copy could not be moved into place" > "$6"
[ "$5" = "1" ] && open "$3"
exit 1
`

export interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

function runTool(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 180_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const exit: unknown = error ? (error as { code?: unknown }).code : 0
      const code = typeof exit === 'number' ? exit : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export interface UpdaterOptions {
  current: string
  feedUrl: string
  /** Release files must sit under this address. */
  downloadBase: string
  /** A folder of the app's own, used for the download. It is emptied before each use. */
  workDir: string
  /** The installed .app, or null when this copy cannot replace itself. */
  bundlePath: string | null
  /** Why not, in words for the user. */
  manual?: string
  /** Where the replaced copy goes. */
  trashDir: string
  /** Never asks GitHub (demo mode, tests). */
  offline?: boolean
  /** Open the app again after the swap. Tests switch this off. */
  relaunch?: boolean
  emit: (state: UpdateState) => void
  quit: () => void
  fetch?: typeof fetch
  run?: (file: string, args: string[]) => Promise<Ran>
  /** Starts the helper. Tests replace it. */
  launchSwap?: (script: string, args: string[]) => void
  now?: () => number
}

const FIRST_CHECK_MS = 8000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export class Updater {
  private state: UpdateState
  private release: UpdateRelease | null = null
  private busy = false
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private readonly fetch: typeof fetch
  private readonly run: (file: string, args: string[]) => Promise<Ran>
  private readonly now: () => number

  constructor(private readonly options: UpdaterOptions) {
    this.fetch = options.fetch ?? fetch
    this.run = options.run ?? runTool
    this.now = options.now ?? Date.now
    this.state = { current: options.current, status: 'idle', manual: options.manual }
    const failed = this.readLastResult()
    if (failed) this.state = { ...this.state, status: 'error', error: failed }
  }

  /** How the last swap went, read once. The folder is then cleared: it may hold a large download. */
  private readLastResult(): string | null {
    let failed: string | null = null
    try {
      const text = fs.readFileSync(path.join(this.options.workDir, 'result.txt'), 'utf8').trim()
      if (text.startsWith('failed')) failed = 'The last update could not be installed, so Threefold is unchanged. You can try again.'
    } catch {
      // No update was attempted.
    }
    this.clearWorkDir()
    return failed
  }

  private clearWorkDir(): void {
    try {
      fs.rmSync(this.options.workDir, { recursive: true, force: true })
    } catch {
      // Left for the next start.
    }
  }

  get(): UpdateState {
    return this.state
  }

  /** The window has shown the "just updated" note; it is not shown again. */
  clearUpdatedFrom(): void {
    if (this.state.updatedFrom) this.state = { ...this.state, updatedFrom: undefined }
  }

  /** Records that this copy has just replaced an older one, so the window can say so once. */
  noteUpdatedFrom(previous: string | undefined): void {
    if (previous && isNewer(this.options.current, previous)) this.set({ updatedFrom: previous })
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.options.emit(this.state)
  }

  /** Checks shortly after start and then a few times a day, while `auto` is on. */
  schedule(auto: boolean, firstDelayMs = FIRST_CHECK_MS): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (!auto || this.options.offline) return
    this.timers.push(setTimeout(() => void this.check(false), firstDelayMs))
    const repeat = setInterval(() => void this.check(false), CHECK_EVERY_MS)
    this.timers.push(repeat as unknown as ReturnType<typeof setTimeout>)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /**
   * Asks GitHub for the newest release. A check the user asked for reports a
   * failure; one made in the background stays quiet and tries again later.
   */
  async check(asked: boolean): Promise<UpdateState> {
    if (this.busy || this.options.offline) return this.state
    if (this.state.status === 'downloading' || this.state.status === 'verifying' || this.state.status === 'installing') return this.state
    this.busy = true
    const before = this.state
    if (asked) this.set({ status: 'checking', error: undefined })
    try {
      const response = await this.fetch(this.options.feedUrl, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Threefold/${this.options.current}` },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
      const release = pickRelease(await response.json(), this.options.downloadBase)
      if (release && isNewer(release.version, this.options.current)) {
        this.release = release
        this.set({
          status: 'available',
          error: undefined,
          progress: undefined,
          checkedAt: this.now(),
          latest: { version: release.version, notesUrl: release.notesUrl, sizeBytes: release.sizeBytes, publishedAt: release.publishedAt },
        })
      } else {
        this.release = null
        this.set({ status: 'idle', error: undefined, latest: undefined, progress: undefined, checkedAt: this.now() })
      }
    } catch (error) {
      if (asked) {
        const why = error instanceof Error ? error.message : String(error)
        this.set({ ...before, status: before.latest ? 'available' : 'error', error: `Threefold could not reach GitHub to look for an update (${why}).` })
      } else {
        // Whatever was known before still stands.
        this.state = before
      }
    } finally {
      this.busy = false
    }
    return this.state
  }

  /** Downloads, checks and installs the release that check() found. Ends by closing the app. */
  async install(): Promise<{ ok: boolean; error?: string }> {
    const release = this.release
    const bundle = this.options.bundlePath
    if (!release || this.state.status !== 'available') return { ok: false, error: 'There is no update to install.' }
    if (!bundle || this.options.manual) return { ok: false, error: this.options.manual ?? 'This copy cannot update itself.' }
    if (this.busy) return { ok: false, error: 'An update is already under way.' }
    this.busy = true
    const fail = (message: string): { ok: false; error: string } => {
      this.clearWorkDir()
      this.set({ status: 'available', progress: undefined, error: message })
      return { ok: false, error: message }
    }
    try {
      const work = this.options.workDir
      this.clearWorkDir()
      fs.mkdirSync(work, { recursive: true, mode: 0o700 })

      // 1. The published checksum.
      this.set({ status: 'downloading', error: undefined, progress: { received: 0, total: release.sizeBytes } })
      const listed = await this.fetch(release.checksumUrl, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
      if (!listed.ok) return fail(`The checksum could not be downloaded (GitHub answered ${listed.status}).`)
      const expected = parseChecksumFile(await listed.text(), UPDATE_ASSET)
      if (!expected) return fail('The checksum published with this release could not be read, so the update was not installed.')
      if (release.digest && release.digest !== expected) return fail('The checksum published with this release does not match the one GitHub reports for the file, so the update was not installed.')

      // 2. The app itself, hashed while it arrives.
      const zip = path.join(work, UPDATE_ASSET)
      const got = await this.download(release, zip)
      if (typeof got !== 'string') return fail(got.error)
      this.set({ status: 'verifying', progress: undefined })
      if (got !== expected) return fail('The download does not match its published checksum, so it was not installed. Try again.')

      // 3. What is inside.
      const unpacked = path.join(work, 'unpacked')
      fs.mkdirSync(unpacked, { mode: 0o700 })
      const unzip = await this.run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
      if (unzip.code !== 0) return fail('The download could not be unpacked.')
      const fresh = path.join(unpacked, 'Threefold.app')
      const stats = fs.lstatSync(fresh, { throwIfNoEntry: false })
      if (!stats || !stats.isDirectory()) return fail('The download does not contain the Threefold app.')
      const seal = await this.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh])
      if (seal.code !== 0) return fail('The downloaded app failed its integrity check, so it was not installed.')
      const plist = path.join(fresh, 'Contents', 'Info.plist')
      const id = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])
      if (id.code !== 0 || id.stdout.trim() !== APP_BUNDLE_ID) return fail('The downloaded app is not Threefold, so it was not installed.')
      const version = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])
      if (version.code !== 0 || version.stdout.trim() !== release.version || !isNewer(version.stdout.trim(), this.options.current)) {
        return fail('The downloaded app is not the version that was announced, so it was not installed.')
      }
      fs.rmSync(zip, { force: true })

      // 4. The swap, once this copy has closed.
      if (!fs.lstatSync(bundle, { throwIfNoEntry: false })?.isDirectory()) return fail('Threefold could not find its own app to replace.')
      fs.mkdirSync(this.options.trashDir, { recursive: true })
      const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      const retired = path.join(this.options.trashDir, `Threefold ${this.options.current} (replaced ${stamp}).app`)
      const script = path.join(work, 'swap.sh')
      fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 })
      const args = [String(process.pid), fresh, bundle, retired, this.options.relaunch === false ? '0' : '1', path.join(work, 'result.txt')]
      this.set({ status: 'installing' })
      if (this.options.launchSwap) this.options.launchSwap(script, args)
      else spawn('/bin/sh', [script, ...args], { detached: true, stdio: 'ignore' }).unref()
      this.options.quit()
      return { ok: true }
    } catch (error) {
      return fail(`The update could not be installed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  /** Saves the ZIP and returns its SHA-256. Stops if more arrives than the release said it holds. */
  private async download(release: UpdateRelease, file: string): Promise<string | { error: string }> {
    const response = await this.fetch(release.zipUrl, { redirect: 'follow' })
    if (!response.ok || !response.body) return { error: `The update could not be downloaded (GitHub answered ${response.status}).` }
    const limit = Math.min(MAX_UPDATE_BYTES, release.sizeBytes)
    const hash = createHash('sha256')
    const out = fs.createWriteStream(file, { mode: 0o600 })
    const reader = response.body.getReader()
    let received = 0
    let lastShown = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > limit) {
          await reader.cancel().catch(() => {})
          return { error: 'The download is larger than the release says it should be, so it was stopped.' }
        }
        hash.update(value)
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        if (this.now() - lastShown > 200) {
          lastShown = this.now()
          this.set({ progress: { received, total: release.sizeBytes } })
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    if (received !== release.sizeBytes) return { error: 'The download was cut short. Try again.' }
    this.set({ progress: { received, total: release.sizeBytes } })
    return hash.digest('hex')
  }
}
