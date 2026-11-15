// Renders the app icon from brand/threefold-icon.svg into every size macOS wants
// and packs them into build/icon.icns. Run with: pnpm icons
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const source = fs.readFileSync(path.join(root, 'brand/threefold-icon.svg'))
const buildDir = path.join(root, 'build')
const iconset = path.join(buildDir, 'icon.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset, { recursive: true })

const render = (size, file) => sharp(source, { density: 300 }).resize(size, size).png().toFile(file)

for (const size of [16, 32, 128, 256, 512]) {
  await render(size, path.join(iconset, `icon_${size}x${size}.png`))
  await render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`))
}
await render(1024, path.join(buildDir, 'icon.png'))
await render(512, path.join(root, 'brand/threefold-icon-512.png'))

if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')])
  console.log('Wrote build/icon.icns')
}
fs.rmSync(iconset, { recursive: true, force: true })
console.log('Wrote build/icon.png and brand/threefold-icon-512.png')
