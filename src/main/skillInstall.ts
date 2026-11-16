// Installs the threefolds skill for the coding tools on this Mac.
//
// A skill is one text file, SKILL.md, in a folder named after the skill. Each
// tool loads skills from a folder in the home directory:
//   Claude Code   ~/.claude/skills/threefolds/SKILL.md
//   Codex         ~/.agents/skills/threefolds/SKILL.md
//   Gemini CLI    ~/.gemini/skills/threefolds/SKILL.md
// Installing is writing that one file. Nothing is run and no other file is touched.
//
// The chat apps (claude.ai, ChatGPT, Gemini) keep skills in the user's account,
// where Threefold cannot and should not reach. For those it saves the ZIP they
// accept, or copies a message that creates the skill in a chat.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_FILE, SKILL_NAME, skillRevision } from '@shared/handoff'
import { SKILL_TARGETS, type SkillStatus, type SkillTarget } from '@shared/types'

interface TargetSpec {
  /** The tool's own folder in the home directory: there once the tool has been used. */
  toolDir: string
  /** The folder the tool loads personal skills from, under the home directory. */
  skillsDir: string
}

const TARGETS: Record<SkillTarget, TargetSpec> = {
  'claude-code': { toolDir: '.claude', skillsDir: '.claude/skills' },
  codex: { toolDir: '.codex', skillsDir: '.agents/skills' },
  'gemini-cli': { toolDir: '.gemini', skillsDir: '.gemini/skills' },
}

/** The home folder skills go under. Tests point it somewhere else. */
export function skillHome(): string {
  return process.env.THREEFOLD_SKILL_HOME ? path.resolve(process.env.THREEFOLD_SKILL_HOME) : os.homedir()
}

const isLink = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}
const isDir = (file: string): boolean => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** True for a skill file whose front matter says it is this skill. */
export function isOurSkill(text: string): boolean {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return Boolean(front && new RegExp(`^name:\\s*["']?${SKILL_NAME}["']?\\s*$`, 'm').test(front[1]!))
}

const same = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()

function paths(target: SkillTarget, home: string): { folder: string; file: string; shown: string } {
  const folder = path.join(home, TARGETS[target].skillsDir, SKILL_NAME)
  return { folder, file: path.join(folder, 'SKILL.md'), shown: `~/${TARGETS[target].skillsDir}/${SKILL_NAME}/SKILL.md` }
}

export function skillStatus(target: SkillTarget, home = skillHome()): SkillStatus {
  const { folder, file, shown } = paths(target, home)
  const toolFound = isDir(path.join(home, TARGETS[target].toolDir))
  let state: SkillStatus['state'] = 'missing'
  if (isLink(folder) || isLink(file)) state = 'linked'
  else {
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (same(text, SKILL_FILE)) state = 'current'
      else if (!isOurSkill(text)) state = 'foreign'
      // A copy installed from GitHub can be ahead of this app. It is never swapped for an older text.
      else state = skillRevision(text) > skillRevision(SKILL_FILE) ? 'newer' : 'outdated'
    } catch {
      state = 'missing'
    }
  }
  return { target, toolFound, state, path: shown }
}

export function skillStatuses(home = skillHome()): SkillStatus[] {
  return SKILL_TARGETS.map((target) => skillStatus(target, home))
}

export function installSkill(target: SkillTarget, home = skillHome()): { ok: boolean; error?: string } {
  const { folder, file } = paths(target, home)
  const { state } = skillStatus(target, home)
  if (state === 'linked') {
    return { ok: false, error: 'This skill is a link to a folder somewhere else on your Mac, so Threefold left it alone.' }
  }
  if (state === 'foreign') {
    return { ok: false, error: `A different skill named ${SKILL_NAME} is already there, so Threefold left it alone.` }
  }
  if (state === 'newer') {
    return { ok: false, error: 'The copy that is installed is newer than the one in this version of Threefold, so it was left as it is.' }
  }
  try {
    fs.mkdirSync(folder, { recursive: true })
    // Written beside the real file and then moved into place, so a tool never reads half a file.
    const draft = path.join(folder, `.SKILL.md.${process.pid}.tmp`)
    fs.writeFileSync(draft, SKILL_FILE, { mode: 0o644, flag: 'wx' })
    fs.renameSync(draft, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `The skill could not be saved: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function removeSkill(target: SkillTarget, home = skillHome()): { ok: boolean; error?: string } {
  const { folder, file } = paths(target, home)
  const { state } = skillStatus(target, home)
  if (state === 'missing') return { ok: true }
  if (state === 'linked' || state === 'foreign') {
    return { ok: false, error: 'This is not a copy Threefold installed, so it was left alone.' }
  }
  try {
    fs.unlinkSync(file)
    // The folder goes only if nothing else is in it.
    try {
      fs.rmdirSync(folder)
    } catch {
      // Something else lives there; leave it.
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `The skill could not be removed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------- the ZIP for the apps that take an upload ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A ZIP holding threefolds/SKILL.md, the layout the apps ask for and the same
 * one the website's ZIP has. One small file, stored without compression, so no
 * ZIP library is needed.
 */
export function skillZip(): Buffer {
  // 1 January 2026, 00:00, in the ZIP format's own date encoding.
  const time = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
  const entries = [{ name: `${SKILL_NAME}/SKILL.md`, data: Buffer.from(SKILL_FILE, 'utf8'), mode: 0o100644 }]
  const files: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed to read it
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(0, 8) // stored, not compressed
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4) // made on Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38) // Unix permissions: a plain file, readable by everyone
    central.writeUInt32LE(offset, 42) // where this entry starts

    files.push(local, name, entry.data)
    directory.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...files, ...directory, end])
}

/** Saves the ZIP into a folder under a name that is not taken, and returns where it went. */
export function saveSkillZip(folder: string): { ok: boolean; file?: string; error?: string } {
  const zip = skillZip()
  for (let n = 1; n <= 50; n++) {
    const file = path.join(folder, n === 1 ? `${SKILL_NAME}.zip` : `${SKILL_NAME} ${n}.zip`)
    try {
      // "wx" refuses to write over a file that is already there.
      fs.writeFileSync(file, zip, { flag: 'wx' })
      return { ok: true, file }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      return { ok: false, error: `The ZIP could not be saved: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { ok: false, error: 'The ZIP could not be saved: too many copies are already in that folder.' }
}
