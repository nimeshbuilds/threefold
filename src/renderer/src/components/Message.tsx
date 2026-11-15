import { memo, useState } from 'react'
import type { Attachment, ChatMessage, Citation, ToolEvent, Usage } from '@shared/types'
import { formatTokens, formatUsd, modelLabel, understated } from '@shared/pricing'
import { fileSize } from '../lib/format'
import { useApp, type Streaming } from '../state'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const api = window.twofold

export function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
  const isImage = attachment.kind === 'image'
  return (
    <span className={`att-chip ${isImage ? 'att-image' : ''}`} title={attachment.name}>
      {isImage ? (
        <img src={api.attachments.url(attachment)} alt={attachment.name} />
      ) : (
        <span className="att-icon">
          <Icon name="file" size={16} />
        </span>
      )}
      {!isImage && (
        <span className="att-text">
          <strong>{attachment.name}</strong>
          <small>{fileSize(attachment.size)}</small>
        </span>
      )}
      {onRemove && (
        <button className="att-remove" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  )
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !active) return null
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((value) => !value)}>
        <Icon name="bulb" size={15} />
        <span className={active ? 'shimmer' : ''}>{active ? 'Thinking…' : 'Thought process'}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open && text.trim() && <div className="thinking-body">{text}</div>}
    </div>
  )
}

const EVENT_ICON: Record<ToolEvent['kind'], string> = {
  web_search: 'globe',
  web_fetch: 'globe',
  code: 'terminal',
  memory: 'memory',
  image: 'image',
  notice: 'info',
}

function EventRow({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(event.detail || event.output)
  return (
    <div className={`event event-${event.status}`}>
      <button className="event-head" onClick={() => expandable && setOpen((value) => !value)} disabled={!expandable}>
        <Icon name={EVENT_ICON[event.kind]} size={15} />
        <span className={event.status === 'running' ? 'shimmer' : ''}>{event.title}</span>
        {event.detail && !open && <span className="event-hint">{event.detail.split('\n')[0]}</span>}
        {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />}
      </button>
      {open && (
        <div className="event-body">
          {event.detail && <pre>{event.detail}</pre>}
          {event.output && <pre className="event-output">{event.output}</pre>}
        </div>
      )}
    </div>
  )
}

function Sources({ citations }: { citations: Citation[] }) {
  return (
    <div className="sources">
      <span className="sources-label">Sources</span>
      {citations.slice(0, 12).map((citation) => (
        <button key={citation.url} className="source" onClick={() => void api.app.openExternal(citation.url)} title={citation.url}>
          {citation.title}
        </button>
      ))}
    </div>
  )
}

function Generated({ files }: { files: Attachment[] }) {
  return (
    <div className="generated">
      {files.map((file) =>
        file.kind === 'image' ? (
          <figure key={file.id} className="generated-image">
            <img src={api.attachments.url(file)} alt={file.name} />
            <figcaption>
              <span>{file.name}</span>
              <button onClick={() => void api.attachments.saveAs(file)}>
                <Icon name="download" size={14} /> Save
              </button>
            </figcaption>
          </figure>
        ) : (
          <button key={file.id} className="generated-file" onClick={() => void api.attachments.saveAs(file)}>
            <Icon name="file" size={16} />
            <span>{file.name}</span>
            <small>{fileSize(file.size)}</small>
            <Icon name="download" size={14} />
          </button>
        ),
      )}
    </div>
  )
}

/** The small line under a reply: model, tokens and what it cost. */
export function UsageLine({ usage, live = false }: { usage: Usage; live?: boolean }) {
  const tokensIn = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const parts = [
    modelLabel(usage.model),
    `${formatTokens(tokensIn)} in`,
    `${formatTokens(usage.outputTokens)} out`,
  ]
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cached`)
  if (usage.webSearches > 0) parts.push(`${usage.webSearches} search${usage.webSearches === 1 ? '' : 'es'}`)
  const low = understated(usage)
  return (
    <span className={`usage-line ${live ? 'live' : ''}`}>
      <strong
        title={
          !usage.priced
            ? 'This model is not in the price table, so its cost is not counted.'
            : low
              ? 'This prompt is large enough for long-context pricing, so the real cost is higher.'
              : usage.estimated
                ? 'Estimate. The exact figure replaces it when the reply finishes.'
                : 'From the token counts the API reported.'
        }
      >
        {usage.priced ? formatUsd(usage.costUsd, { estimated: usage.estimated }) : 'cost unknown'}
        {low ? '+' : ''}
      </strong>
      <span>{parts.join(' · ')}</span>
    </span>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="msg-action"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} />
    </button>
  )
}

export const MessageView = memo(function MessageView({
  message,
  isLastUser,
  isLastAssistant,
  busy,
}: {
  message: ChatMessage
  isLastUser: boolean
  isLastAssistant: boolean
  busy: boolean
}) {
  const regenerate = useApp((s) => s.regenerate)
  const editLast = useApp((s) => s.editLast)

  if (message.role === 'user') {
    return (
      <div className="msg user">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        {message.text && <div className="bubble">{message.text}</div>}
        <div className="msg-actions">
          <CopyAction text={message.text} />
          {isLastUser && !busy && (
            <button className="msg-action" title="Edit and resend" onClick={editLast}>
              <Icon name="edit" size={15} />
            </button>
          )}
        </div>
      </div>
    )
  }

  const stopped = message.error === 'Stopped.'
  return (
    <div className="msg assistant">
      {message.thinking && <Thinking text={message.thinking} active={false} />}
      {message.events && message.events.length > 0 && (
        <div className="events">
          {message.events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
      {message.text && <Markdown text={message.text} />}
      {message.generated && message.generated.length > 0 && <Generated files={message.generated} />}
      {message.citations && message.citations.length > 0 && <Sources citations={message.citations} />}
      {message.error && <div className={`msg-error ${stopped ? 'muted' : ''}`}>{message.error}</div>}
      <div className="msg-foot">
        <div className="msg-actions">
          {message.text && <CopyAction text={message.text} />}
          {isLastAssistant && !busy && (
            <button className="msg-action" title="Try again" onClick={regenerate}>
              <Icon name="refresh" size={15} />
            </button>
          )}
        </div>
        {message.usage && <UsageLine usage={message.usage} />}
      </div>
    </div>
  )
})

export function StreamingMessage({ streaming }: { streaming: Streaming }) {
  const waiting = !streaming.text && streaming.events.length === 0
  return (
    <div className="msg assistant streaming">
      <Thinking text={streaming.thinking} active={waiting} />
      {streaming.events.length > 0 && (
        <div className="events">
          {streaming.events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
      {streaming.text && <Markdown text={streaming.text} streaming />}
      <div className="msg-foot">
        <span className="pulse" aria-label="Replying" />
        {streaming.usage && <UsageLine usage={streaming.usage} live />}
      </div>
    </div>
  )
}
