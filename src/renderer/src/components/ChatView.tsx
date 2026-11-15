import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatUsd } from '@shared/pricing'
import { greeting } from '../lib/format'
import { useApp } from '../state'
import { Composer, ModelPicker } from './Composer'
import { Icon } from './Icon'
import { Logo } from './Logo'
import { MessageView, StreamingMessage } from './Message'
import { PanelBar, PanelBilling, PanelNotice } from './Threefold'

/** Running total for the open chat. It ticks up while a reply is streaming. */
function ChatCost() {
  const saved = useApp((s) => s.conversation?.costUsd ?? 0)
  const live = useApp((s) => (s.conversation ? s.streaming[s.conversation.id]?.usage : null))
  const total = saved + (live?.costUsd ?? 0)
  const estimated = Boolean(live?.estimated)
  return (
    <span
      className={`cost-chip ${live ? 'live' : ''}`}
      title="What this chat has cost so far, at API prices. It updates as the reply streams."
    >
      {live && <span className="dot" />}
      This chat {formatUsd(total, { estimated })}
    </span>
  )
}

function TitleEditor({ fallback }: { fallback: string }) {
  const conversation = useApp((s) => s.conversation)
  const rename = useApp((s) => s.renameConversation)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  if (!conversation) return <span className="topbar-title muted">{fallback}</span>
  if (editing) {
    return (
      <input
        className="topbar-title-input"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          setEditing(false)
          if (value.trim() && value.trim() !== conversation.title) void rename(conversation.id, value.trim())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button
      className="topbar-title"
      title="Rename"
      onClick={() => {
        setValue(conversation.title)
        setEditing(true)
      }}
    >
      {conversation.title}
    </button>
  )
}

export function ChatView() {
  const mode = useApp((s) => s.mode)
  const panel = useApp((s) => s.view.kind === 'threefold')
  const conversation = useApp((s) => s.conversation)
  const streaming = useApp((s) => (s.conversation ? s.streaming[s.conversation.id] : undefined))
  const name = useApp((s) => s.settings?.displayName ?? '')
  const hasKey = useApp((s) => s.keys[s.mode])
  const openSettings = useApp((s) => s.openSettings)
  const project = useApp((s) => {
    const id = s.conversation?.projectId ?? s.draft.projectId
    return id ? s.projects.find((p) => p.id === id) : undefined
  })
  const setView = useApp((s) => s.setView)

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const busy = Boolean(streaming)
  const messages = conversation?.messages ?? []
  const empty = messages.length === 0 && !streaming

  // Follow the reply as it grows, unless the reader has scrolled up.
  const stepChars = streaming?.steps.reduce((sum, step) => sum + step.text.length, 0)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [messages.length, streaming?.text, streaming?.thinking, streaming?.events.length, streaming?.steps.length, stepChars])

  useEffect(() => {
    pinned.current = true
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [conversation?.id])

  const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id
  const lastAssistantId = messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.id : undefined

  return (
    <section className={`chat ${empty ? 'chat-empty' : ''} ${panel ? 'chat-panel' : ''}`}>
      <header className="topbar">
        {panel ? (
          <span className="panel-badge">
            <Icon name="layers" size={15} /> Threefold
          </span>
        ) : (
          mode === 'chatgpt' && <ModelPicker />
        )}
        {project && !panel && (
          <button className="crumb" onClick={() => setView({ kind: 'project', id: project.id })}>
            <Icon name="folder" size={14} /> {project.name}
          </button>
        )}
        <TitleEditor fallback={panel ? 'New reviewed chat' : 'New chat'} />
        <span className="topbar-spacer" />
        <ChatCost />
      </header>
      {panel && <PanelBar />}

      {empty ? (
        <div className="empty">
          <div className="empty-inner">
            {panel ? (
              <>
                <span className="empty-icon">
                  <Icon name="layers" size={34} />
                </span>
                <h1>Ask once. Get a reviewed answer.</h1>
                <p className="lead center">
                  One model drafts a reply, the others check it for mistakes and gaps, and the first model writes the
                  final answer with their notes in hand.
                </p>
                <PanelNotice />
              </>
            ) : (
              <>
                <Logo size={44} />
                <h1>{greeting(mode, name)}</h1>
              </>
            )}
            {!hasKey && (
              <button className="btn primary" onClick={() => openSettings('keys')}>
                <Icon name="key" size={16} /> Add your API key to start
              </button>
            )}
            <Composer busy={busy} panel={panel} />
            {panel ? (
              <PanelBilling />
            ) : (
              <p className="empty-hint">
                Replies are billed to your own API key at API prices. The cost of each message shows as it streams.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div
            className="thread"
            ref={scroller}
            onScroll={(event) => {
              const element = event.currentTarget
              pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
            }}
          >
            <div className="thread-inner">
              {panel && <PanelNotice />}
              {conversation?.origin && (
                <div className="import-note">
                  Imported from your{' '}
                  {conversation.origin === 'chatgpt-export'
                    ? 'ChatGPT'
                    : conversation.origin === 'gemini-export'
                      ? 'Gemini'
                      : 'Claude'}{' '}
                  export. New messages here are sent through the API and stay in Threefold.
                </div>
              )}
              {messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  busy={busy}
                  isLastUser={message.id === lastUserId}
                  isLastAssistant={message.id === lastAssistantId}
                />
              ))}
              {streaming && <StreamingMessage streaming={streaming} />}
            </div>
          </div>
          <div className="composer-dock">
            <Composer busy={busy} panel={panel} />
            {panel && <PanelBilling />}
          </div>
        </>
      )}
    </section>
  )
}
