import { useEffect, useState } from 'react'
import { artifactDocument, artifactFileName } from '@shared/artifacts'
import { useApp } from '../state'
import { Icon } from './Icon'
import { CopyButton, Markdown } from './Markdown'

const api = window.threefold

/** Side panel that runs a page or shows a picture the model wrote. */
export function ArtifactPanel() {
  const artifact = useApp((s) => s.artifact)
  const close = useApp((s) => s.openArtifact)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [frameUrl, setFrameUrl] = useState<string | null>(null)

  useEffect(() => {
    setTab('preview')
    setFrameUrl(null)
    if (!artifact || artifact.kind === 'markdown') return
    let cancelled = false
    void api.artifacts.register(artifactDocument(artifact)).then((id) => {
      if (!cancelled) setFrameUrl(`threefold://artifact/${id}`)
    })
    return () => {
      cancelled = true
    }
  }, [artifact])

  if (!artifact) return null

  return (
    <aside className="artifact-panel">
      <header className="artifact-head">
        <strong title={artifact.title}>{artifact.title}</strong>
        <div className="seg">
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            <Icon name="eye" size={14} /> Preview
          </button>
          <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
            <Icon name="code" size={14} /> Code
          </button>
        </div>
        <span className="topbar-spacer" />
        <CopyButton text={artifact.code} />
        <button className="icon-btn" title="Save as a file" onClick={() => void api.artifacts.save(artifactFileName(artifact), artifact.code)}>
          <Icon name="download" size={16} />
        </button>
        <button className="icon-btn" title="Close" onClick={() => close(null)}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="artifact-body">
        {tab === 'code' ? (
          <pre className="artifact-code">
            <code>{artifact.code}</code>
          </pre>
        ) : artifact.kind === 'markdown' ? (
          <div className="artifact-doc">
            <Markdown text={artifact.code} />
          </div>
        ) : frameUrl ? (
          // No allow-same-origin: the page cannot reach the app, its storage or other previews.
          <iframe className="artifact-frame" title={artifact.title} src={frameUrl} sandbox="allow-scripts allow-forms" />
        ) : (
          <div className="artifact-loading">Loading preview…</div>
        )}
      </div>
    </aside>
  )
}
