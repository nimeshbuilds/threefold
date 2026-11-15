// A handoff arriving from outside the app.
//
// The threefolds skill, running in a coding tool on this Mac, saves the handoff
// as a file in Threefold's inbox folder and then opens a threefold://handoff
// link. A chat app in the browser cannot save a file, so its reply sends the
// user to a page that opens the same link once they have copied the handoff.
//
// What keeps this safe:
//  - The link carries no content. Any page or program can open a link, so all a
//    link can do is make Threefold look for a handoff that is already on this Mac.
//  - Only the inbox folder and the clipboard are looked at, and only text that
//    is a Threefold handoff is kept.
//  - A file is taken only if it is a plain file that this user owns, has the
//    expected name, and is small and recent. Links to files are never followed.
//  - Nothing here starts a chat or contacts a provider. What is found is shown
//    to the user, who decides whether to continue with it and where.
//  - macOS does not tell an app who opened a link. The sender is whatever the
//    link claims, and it is shown to the user as a claim.

import fs from 'node:fs'
import path from 'node:path'
import { HANDOFF_HEADING, parseHandoff, parseHandoffLink, providerFromName } from '@shared/handoff'
import type { IncomingHandoff, Provider } from '@shared/types'

/** handoff-<letters, digits, dots, dashes>.md and nothing else. */
export const INBOX_FILE = /^handoff-[A-Za-z0-9._-]{1,80}\.md$/
/** Far more than a handoff needs (200,000 characters, each up to four bytes). */
export const MAX_INBOX_BYTES = 1_000_000
/** A handoff nobody picked up within a day is dropped. */
export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function inboxDir(userData: string): string {
  return path.join(userData, 'inbox')
}

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined)
const mine = (stats: fs.Stats): boolean => uid() === undefined || stats.uid === uid()

/** True when the inbox is a real folder that belongs to this user (and not a link to one). */
function trustedDir(dir: string): boolean {
  try {
    const stats = fs.lstatSync(dir)
    return stats.isDirectory() && mine(stats)
  } catch {
    return false
  }
}

/** Makes the inbox folder, readable and writable by this user only. */
export function ensureInbox(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    return false
  }
  return trustedDir(dir)
}

function remove(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // Already gone, or not ours to remove.
  }
}

/** Reads a file without ever following a link, and checks again what was actually opened. */
function readPlainFile(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stats = fs.fstatSync(fd)
    if (!stats.isFile() || !mine(stats) || stats.size > MAX_INBOX_BYTES) return null
    const buffer = Buffer.alloc(stats.size)
    let read = 0
    while (read < buffer.length) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, read)
      if (got <= 0) break
      read += got
    }
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/**
 * Takes the newest handoff waiting in the inbox and empties the inbox of
 * handoff files: the inbox holds one handoff, the latest. Files with any other
 * name are never touched. Returns the file's text, or null when nothing usable
 * was waiting.
 */
export function takeFromInbox(dir: string, now = Date.now()): string | null {
  if (!trustedDir(dir)) return null
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const waiting: Array<{ file: string; modified: number }> = []
  for (const name of names) {
    if (!INBOX_FILE.test(name)) continue
    const file = path.join(dir, name)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(file)
    } catch {
      continue
    }
    // A link or a folder with a handoff's name is not a handoff. A link is removed
    // (that removes the link, never what it points to); a folder is left alone.
    if (stats.isSymbolicLink()) {
      remove(file)
      continue
    }
    if (!stats.isFile() || !mine(stats)) continue
    const fresh = now - stats.mtimeMs <= INBOX_MAX_AGE_MS && stats.size <= MAX_INBOX_BYTES && stats.size > 0
    if (fresh) waiting.push({ file, modified: stats.mtimeMs })
    else remove(file)
  }
  waiting.sort((a, b) => b.modified - a.modified)

  let found: string | null = null
  for (const { file } of waiting) {
    if (found === null) {
      const text = readPlainFile(file)
      if (text !== null && text.toLowerCase().includes(HANDOFF_HEADING.toLowerCase())) found = text
    }
    remove(file)
  }
  return found
}

/** Turns found text into what the window shows. Null when the text is not a handoff. */
export function describeIncoming(text: string, source: 'inbox' | 'clipboard', sender?: Provider): IncomingHandoff | null {
  // Outside the app a handoff must carry its heading: unmarked text is never picked up.
  if (!text.toLowerCase().includes(HANDOFF_HEADING.toLowerCase())) return null
  const parsed = parseHandoff(text)
  if (!parsed) return null
  return {
    source,
    sender,
    summary: parsed.summary,
    title: parsed.title,
    from: parsed.from,
    fromProvider: providerFromName(parsed.from),
  }
}

export class IncomingHandoffs {
  private pending: IncomingHandoff | null = null

  constructor(
    private readonly dir: string,
    private readonly readClipboard: () => string | Promise<string>,
    /** Tells the window that something is waiting. */
    private readonly signal: () => void,
  ) {
    ensureInbox(dir)
  }

  /**
   * A link was opened from outside the app. Returns false, and does nothing at
   * all, for any link that is not a handoff link.
   */
  async open(url: string): Promise<boolean> {
    const link = parseHandoffLink(url)
    if (!link) return false
    this.pending =
      this.fromInbox(link.sender) ?? (await this.fromClipboard(link.sender)) ?? { source: 'none', sender: link.sender, summary: '' }
    this.signal()
    return true
  }

  /** What is waiting, handed over once. */
  take(): IncomingHandoff | null {
    const waiting = this.pending ?? this.fromInbox()
    this.pending = null
    return waiting
  }

  private fromInbox(sender?: Provider): IncomingHandoff | null {
    const text = takeFromInbox(this.dir)
    return text === null ? null : describeIncoming(text, 'inbox', sender)
  }

  private async fromClipboard(sender?: Provider): Promise<IncomingHandoff | null> {
    let text = ''
    try {
      text = await this.readClipboard()
    } catch {
      return null
    }
    // Anything on the clipboard that is not a handoff is left unread beyond this check.
    if (!text || text.length > MAX_INBOX_BYTES) return null
    return describeIncoming(text, 'clipboard', sender)
  }
}
