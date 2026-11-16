// Updates: finding out that a newer Threefold has been released on GitHub, and
// the checks a release has to pass before the app will install it.

export const UPDATE_REPO = 'nimeshbuilds/threefold'
/** GitHub's own record of the newest published release. */
export const UPDATE_FEED = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
/** The only place release files are downloaded from. */
export const UPDATE_DOWNLOAD_BASE = `https://github.com/${UPDATE_REPO}/releases/download/`
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`
export const UPDATE_ASSET = 'Threefold-mac-arm64.zip'
export const UPDATE_CHECKSUM = `${UPDATE_ASSET}.sha256`
export const APP_BUNDLE_ID = 'dev.nimeshbuilds.threefold'
/** Nothing larger than this is ever downloaded as an update. */
export const MAX_UPDATE_BYTES = 1_500_000_000

export interface UpdateRelease {
  version: string
  tag: string
  notesUrl: string
  zipUrl: string
  checksumUrl: string
  sizeBytes: number
  /** SHA-256 of the ZIP as GitHub itself reports it, when it does. */
  digest?: string
  publishedAt?: string
}

export interface UpdateState {
  /** The version that is running. */
  current: string
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'error'
  /** Why this copy cannot replace itself, when it cannot. The update is then offered as a download. */
  manual?: string
  latest?: { version: string; notesUrl: string; sizeBytes: number; publishedAt?: string }
  progress?: { received: number; total: number }
  error?: string
  /** When GitHub was last asked. */
  checkedAt?: number
  /** Set once, right after an update: the version this copy replaced. */
  updatedFrom?: string
}

export type Version = [number, number, number]

/** "0.8.1" or "v0.8.1". Anything else, including pre-release tags, is not a version the app acts on. */
export function parseVersion(text: unknown): Version | null {
  const match = typeof text === 'string' ? text.trim().match(/^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads GitHub's description of a release and keeps it only if it is a full
 * release with a plain version number and both files, each at exactly the
 * address a release file has. Everything else in the description is ignored.
 */
export function pickRelease(json: unknown, downloadBase: string = UPDATE_DOWNLOAD_BASE): UpdateRelease | null {
  if (!isRecord(json) || json.draft === true || json.prerelease === true) return null
  const tag = typeof json.tag_name === 'string' ? json.tag_name : ''
  const version = parseVersion(tag)
  if (!version || !Array.isArray(json.assets)) return null

  const asset = (name: string): { url: string; size: number; digest?: string } | null => {
    for (const entry of json.assets as unknown[]) {
      if (!isRecord(entry) || entry.name !== name) continue
      const url = typeof entry.browser_download_url === 'string' ? entry.browser_download_url : ''
      const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0
      // A release file lives at <base><tag>/<name> and nowhere else.
      if (url !== `${downloadBase}${tag}/${name}` || size <= 0 || size > MAX_UPDATE_BYTES) return null
      const digest = typeof entry.digest === 'string' ? entry.digest.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() : undefined
      return { url, size, digest }
    }
    return null
  }
  const zip = asset(UPDATE_ASSET)
  const checksum = asset(UPDATE_CHECKSUM)
  if (!zip || !checksum || checksum.size > 1000) return null

  const page = typeof json.html_url === 'string' && json.html_url.startsWith(`${UPDATE_RELEASES_PAGE}/`) ? json.html_url : `${UPDATE_RELEASES_PAGE}/tag/${tag}`
  return {
    version: version.join('.'),
    tag,
    notesUrl: page,
    zipUrl: zip.url,
    checksumUrl: checksum.url,
    sizeBytes: zip.size,
    digest: zip.digest,
    publishedAt: typeof json.published_at === 'string' ? json.published_at.slice(0, 40) : undefined,
  }
}

/** The checksum file is one line: 64 hex digits, two spaces, the file's name. */
export function parseChecksumFile(text: unknown, name: string = UPDATE_ASSET): string | null {
  if (typeof text !== 'string' || text.length > 1000) return null
  const match = text.trim().match(/^([0-9a-fA-F]{64})(?:[ \t]+\*?(\S+))?$/)
  if (!match || (match[2] !== undefined && match[2] !== name)) return null
  return match[1]!.toLowerCase()
}

/** The .app folder an executable belongs to, or null when it is not inside one. */
export function bundlePathOf(exePath: string): string | null {
  return exePath.match(/^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/)?.[1] ?? null
}

/**
 * Says why a copy of the app cannot replace itself, or returns null when it can.
 * Such a copy still learns about updates; it is sent to the download page instead.
 */
export function updateBlocker(input: {
  packaged: boolean
  platform: string
  arch: string
  exePath: string
  /** True when the folder that holds the app can be written to. */
  writable: (dir: string) => boolean
}): string | null {
  if (!input.packaged) return 'This copy runs from the source code, so it is updated with Git instead.'
  if (input.platform !== 'darwin' || input.arch !== 'arm64') return 'The ready-made download is for Apple Silicon Macs. Build this version from the source instead.'
  const bundle = bundlePathOf(input.exePath)
  if (!bundle) return 'Threefold could not work out where it is installed.'
  if (bundle.includes('/AppTranslocation/')) {
    return 'macOS is running Threefold from a temporary place, because the app has not been moved since it was downloaded. Move Threefold into Applications and open it again; updates then install with one click.'
  }
  if (bundle.startsWith('/Volumes/')) return 'Threefold is running from a disk image or another drive. Move it into Applications and open it again; updates then install with one click.'
  const folder = bundle.slice(0, bundle.lastIndexOf('/')) || '/'
  if (!input.writable(folder)) return `Threefold cannot write to the folder it is in (${folder}).`
  return null
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}
