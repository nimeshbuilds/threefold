import { memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { artifactFromBlock, type Artifact } from '@shared/artifacts'
import { useApp } from '../state'
import { Icon } from './Icon'

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="code-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? 'Copied' : label}
    </button>
  )
}

function ArtifactCard({ artifact, writing }: { artifact: Artifact; writing: boolean }) {
  const openArtifact = useApp((s) => s.openArtifact)
  const kind = artifact.kind === 'html' ? 'Web page' : artifact.kind === 'svg' ? 'Image' : 'Document'
  return (
    <button className="artifact-card" onClick={() => openArtifact(artifact)}>
      <span className="artifact-card-icon">
        <Icon name={artifact.kind === 'svg' ? 'image' : artifact.kind === 'html' ? 'panel' : 'file'} size={20} />
      </span>
      <span className="artifact-card-text">
        <strong>{artifact.title}</strong>
        <small>{writing ? 'Writing…' : `${kind} · Click to open`}</small>
      </span>
      <Icon name="chevronRight" size={16} />
    </button>
  )
}

function CodeBlock({ lang, code, streaming }: { lang: string; code: string; streaming: boolean }) {
  const html = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        return null
      }
    }
    return null
  }, [lang, code])

  const artifact = artifactFromBlock(lang, code)
  if (artifact) return <ArtifactCard artifact={artifact} writing={streaming} />

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre>{html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
    </div>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function buildComponents(streaming: boolean): Components {
  return {
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            if (href) void window.twofold.app.openExternal(href)
          }}
        >
          {children}
        </a>
      )
    },
    // Remote images are not loaded by the app; show them as a link instead.
    img({ src, alt }) {
      const url = typeof src === 'string' ? src : ''
      if (url.startsWith('twofold://')) return <img src={url} alt={alt ?? ''} />
      return (
        <a
          href={url}
          onClick={(event) => {
            event.preventDefault()
            if (url) void window.twofold.app.openExternal(url)
          }}
        >
          {alt || 'Image'} ↗
        </a>
      )
    },
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children
      const props = (child as { props?: { className?: string; children?: ReactNode } } | undefined)?.props ?? {}
      const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? ''
      const code = textOf(props.children).replace(/\n$/, '')
      return <CodeBlock lang={lang.toLowerCase()} code={code} streaming={streaming} />
    },
    table({ children }) {
      return (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      )
    },
  }
}

const settled = buildComponents(false)
const live = buildComponents(true)

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? live : settled}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export { CopyButton }
