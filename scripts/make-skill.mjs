// Publishes the `threefolds` skill: copies skills/threefolds/SKILL.md into the
// website (docs/skills/) and builds the ZIP that the official apps accept.
//
// The ZIP holds the skill folder at its top level (threefolds/SKILL.md), which
// is what Claude requires and what ChatGPT and Gemini accept. File times are
// pinned so that running this twice gives a byte-identical ZIP.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const name = 'threefolds'
const source = path.join(root, 'skills', name)
const outDir = path.join(root, 'docs', 'skills')
const zip = path.join(outDir, `${name}.zip`)
const stamp = new Date('2026-01-01T00:00:00Z')

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'threefolds-skill-'))
try {
  const folder = path.join(stage, name)
  fs.mkdirSync(folder)
  fs.mkdirSync(path.join(outDir, name), { recursive: true })
  for (const file of fs.readdirSync(source)) {
    // Hidden files such as .DS_Store make some uploads fail.
    if (file.startsWith('.')) continue
    fs.copyFileSync(path.join(source, file), path.join(folder, file))
    fs.utimesSync(path.join(folder, file), stamp, stamp)
    fs.copyFileSync(path.join(source, file), path.join(outDir, name, file))
  }
  fs.utimesSync(folder, stamp, stamp)
  fs.rmSync(zip, { force: true })
  execFileSync('zip', ['-q', '-X', '-D', '-r', zip, name], { cwd: stage, env: { ...process.env, TZ: 'UTC' } })
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
console.log(`${path.relative(root, zip)}  ${fs.statSync(zip).size} bytes`)
