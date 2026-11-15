// Turns the app that `pnpm dist` built into the ZIP attached to a GitHub release.
//
// The app is signed ad hoc: a local signature with no Apple identity behind it.
// That gives a downloaded copy a valid seal, without which macOS reports the
// app as "damaged". It is NOT a Developer ID signature and the app is not
// notarized, so macOS still blocks the first launch until the user allows it.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'dist/mac-arm64/Threefold.app')
const zip = path.join(root, 'dist/Threefold-mac-arm64.zip')

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

if (!fs.existsSync(app)) {
  console.error(`No app at ${app}. Run "pnpm dist" first.`)
  process.exit(1)
}

run('codesign', ['--force', '--deep', '--sign', '-', app])
run('codesign', ['--verify', '--deep', '--strict', app])

// ditto keeps the symlinks and metadata inside the bundle, which the signature covers.
fs.rmSync(zip, { force: true })
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])

const digest = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
const megabytes = (fs.statSync(zip).size / 1_000_000).toFixed(1)
console.log(`\n${path.relative(root, zip)}  ${megabytes} MB\nSHA-256  ${digest}`)
