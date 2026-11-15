// Decides which fenced code blocks in a reply open in the side panel as an
// artifact (a page, picture or document) instead of showing as plain code.

export type ArtifactKind = 'html' | 'svg' | 'markdown'

export interface Artifact {
  kind: ArtifactKind
  title: string
  code: string
}

const HTML_LANGS = new Set(['html', 'htm', 'xhtml'])
const SVG_LANGS = new Set(['svg'])
const MD_LANGS = new Set(['markdown', 'md'])

function titleFrom(code: string, fallback: string): string {
  const match = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)
  const title = match?.[1]?.trim()
  return title ? title : fallback
}

function markdownTitle(code: string): string {
  const match = /^#{1,3}\s+(.{1,80})$/m.exec(code)
  return match?.[1]?.trim() ?? 'Document'
}

/** Returns an artifact for a fenced block, or null when it should stay inline as code. */
export function artifactFromBlock(lang: string | undefined, code: string): Artifact | null {
  const language = (lang ?? '').toLowerCase()
  const body = code.trim()
  if (!body) return null

  const looksSvg = /^<svg[\s>]/i.test(body) || /^<\?xml[^>]*>\s*<svg[\s>]/i.test(body)
  if (SVG_LANGS.has(language) || ((language === 'xml' || language === '') && looksSvg)) {
    if (!looksSvg) return null
    return { kind: 'svg', title: titleFrom(body, 'SVG image'), code: body }
  }

  if (HTML_LANGS.has(language)) {
    const fullPage = /<!doctype html|<html[\s>]|<body[\s>]/i.test(body)
    // Short snippets with no page structure are examples, not artifacts.
    if (!fullPage && body.split('\n').length < 12) return null
    return { kind: 'html', title: titleFrom(body, 'HTML page'), code: body }
  }

  if (MD_LANGS.has(language) && body.split('\n').length >= 12) {
    return { kind: 'markdown', title: markdownTitle(body), code: body }
  }

  return null
}

/** The document shown in the sandboxed preview frame. */
export function artifactDocument(artifact: Artifact): string {
  if (artifact.kind === 'html') return artifact.code
  if (artifact.kind === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;background:#fff}
body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
svg{max-width:100%;max-height:100%;height:auto}
</style></head><body>${artifact.code}</body></html>`
  }
  return ''
}

export function artifactFileName(artifact: Artifact): string {
  const base =
    artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artifact'
  const ext = artifact.kind === 'html' ? 'html' : artifact.kind === 'svg' ? 'svg' : 'md'
  return `${base}.${ext}`
}
