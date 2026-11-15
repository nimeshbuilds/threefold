import { useEffect, useMemo, useState } from 'react'
import type { ConversationMeta, Provider } from '@shared/types'
import { formatUsd } from '@shared/pricing'
import { MODE_NAME, daysUntil, groupByRecency } from '../lib/format'
import { connectedProviders, useApp } from '../state'
import { Icon } from './Icon'
import { Wordmark } from './Logo'
import { Popover } from './Popover'

const api = window.threefold
const PAGE = 250

/** How much of this month's API credit is used, counting replies still streaming. */
export function CreditMeter() {
  const mode = useApp((s) => s.mode)
  const summary = useApp((s) => s.spend?.[s.mode])
  const openSettings = useApp((s) => s.openSettings)
  if (!summary) return null
  const used = summary.spentUsd + summary.liveUsd
  const grant = summary.monthlyUsd
  const ratio = grant > 0 ? Math.min(1, used / grant) : 0
  const days = daysUntil(summary.cycleEnd)
  const over = grant > 0 && used > grant
  return (
    <button className={`meter ${over ? 'over' : ''}`} onClick={() => openSettings('usage')} title="Open the spend breakdown">
      <div className="meter-top">
        <span className="meter-label">
          {summary.liveUsd > 0 && <span className="dot" />}
          {MODE_NAME[mode]} API spend
        </span>
        <strong>
          {formatUsd(used, { estimated: summary.liveUsd > 0 })}
          {grant > 0 && <span className="meter-of"> / ${grant}</span>}
        </strong>
      </div>
      {grant > 0 && (
        <div className="meter-bar">
          <div className="meter-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <div className="meter-sub">
        {grant > 0
          ? over
            ? `Over this cycle's credits · renews in ${days} day${days === 1 ? '' : 's'}`
            : `${formatUsd(Math.max(0, grant - used))} left · renews in ${days} day${days === 1 ? '' : 's'}`
          : `This cycle · today ${formatUsd(summary.todayUsd)}`}
      </div>
    </button>
  )
}

function ChatRow({ meta, active }: { meta: ConversationMeta; active: boolean }) {
  const open = useApp((s) => s.openConversation)
  const rename = useApp((s) => s.renameConversation)
  const togglePin = useApp((s) => s.togglePin)
  const remove = useApp((s) => s.removeConversation)
  const busy = useApp((s) => Boolean(s.streaming[meta.id]))
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(meta.title)
  const [confirming, setConfirming] = useState(false)

  if (editing) {
    return (
      <div className="chat-row editing">
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            setEditing(false)
            if (value.trim() && value.trim() !== meta.title) void rename(meta.id, value.trim())
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className={`chat-row ${active ? 'active' : ''}`}>
      <button className="chat-row-main" onClick={() => void open(meta.id)} title={meta.title}>
        {busy && <span className="dot" />}
        {meta.projectId && <Icon name="folder" size={13} />}
        <span className="chat-row-title">{meta.title}</span>
      </button>
      <Popover
        className="chat-row-menu"
        align="right"
        trigger={({ toggle }) => (
          <button className="row-more" onClick={toggle} aria-label="Chat options">
            <Icon name="more" size={16} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              className="menu-item"
              onClick={() => {
                setValue(meta.title)
                setEditing(true)
                close()
              }}
            >
              <Icon name="edit" size={15} /> Rename
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void togglePin(meta.id)
                close()
              }}
            >
              <Icon name="pin" size={15} /> {meta.pinned ? 'Unpin' : 'Pin'}
            </button>
            <div className="menu-sep" />
            {confirming ? (
              <button
                className="menu-item danger"
                onClick={() => {
                  void remove(meta.id)
                  close()
                }}
              >
                <Icon name="trash" size={15} /> Really delete?
              </button>
            ) : (
              <button className="menu-item danger" onClick={() => setConfirming(true)}>
                <Icon name="trash" size={15} /> Delete
              </button>
            )}
            <div className="menu-foot">Cost so far {formatUsd(meta.costUsd)}</div>
          </>
        )}
      </Popover>
    </div>
  )
}

function ModeSwitch() {
  const mode = useApp((s) => s.mode)
  const setMode = useApp((s) => s.setMode)
  const keys = useApp((s) => s.keys)
  const option = (id: Provider) => (
    <button
      role="tab"
      aria-selected={mode === id}
      className={mode === id ? 'active' : ''}
      onClick={() => setMode(id)}
      title={keys[id] ? `${MODE_NAME[id]} mode` : `${MODE_NAME[id]} mode (no API key yet)`}
    >
      {MODE_NAME[id]}
      {!keys[id] && <span className="needs-key" />}
    </button>
  )
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {option('claude')}
      {option('chatgpt')}
      {option('gemini')}
    </div>
  )
}

export function Sidebar() {
  const mode = useApp((s) => s.mode)
  const metas = useApp((s) => s.metas)
  const activeId = useApp((s) => s.conversation?.id)
  const view = useApp((s) => s.view)
  const newChat = useApp((s) => s.newChat)
  const openThreefold = useApp((s) => s.openThreefold)
  const reviewReady = useApp((s) => connectedProviders(s.keys).length >= 2)
  const setView = useApp((s) => s.setView)
  const openSettings = useApp((s) => s.openSettings)
  const name = useApp((s) => s.settings?.displayName ?? '')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ConversationMeta[] | null>(null)
  const [limit, setLimit] = useState(PAGE)

  const inPanel = view.kind === 'threefold'
  // The Threefold tab lists its own chats, from every provider; the modes list ordinary chats.
  const mine = useMemo(
    () => metas.filter((m) => (inPanel ? m.panel === true : !m.panel && m.provider === mode)),
    [metas, mode, inPanel],
  )

  // Titles filter instantly; message text is searched after a short pause.
  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      setResults(null)
      return
    }
    const timer = setTimeout(() => {
      void api.conversations
        .search(needle, mode)
        .then((found) => setResults(found.filter((m) => (inPanel ? m.panel === true : !m.panel))))
    }, 220)
    return () => clearTimeout(timer)
  }, [query, mode, inPanel])

  useEffect(() => setLimit(PAGE), [mode, query])

  const needle = query.trim().toLowerCase()
  const shown = needle ? (results ?? mine.filter((m) => m.title.toLowerCase().includes(needle))) : mine
  const groups = needle ? [{ label: `${shown.length} result${shown.length === 1 ? '' : 's'}`, items: shown }] : groupByRecency(shown.slice(0, limit))

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Wordmark />
      </div>
      <ModeSwitch />

      <nav className="side-nav">
        <button className={`side-btn ${view.kind === 'chat' && !activeId ? 'active' : ''}`} onClick={() => newChat()}>
          <Icon name="edit" size={17} /> New chat
        </button>
        <button
          className={`side-btn ${inPanel ? 'active' : ''} ${reviewReady ? '' : 'dimmed'}`}
          onClick={openThreefold}
          title={
            reviewReady
              ? 'One model answers, the others review, then it writes the final reply'
              : 'Connect a second provider to turn this on'
          }
        >
          <Icon name="layers" size={17} /> Threefold review
          {!reviewReady && <span className="side-tag">needs 2 keys</span>}
        </button>
        <button
          className={`side-btn ${view.kind === 'projects' || view.kind === 'project' ? 'active' : ''}`}
          onClick={() => setView({ kind: 'projects' })}
        >
          <Icon name="folder" size={17} /> Projects
        </button>
        <button className={`side-btn ${view.kind === 'code' ? 'active' : ''}`} onClick={() => setView({ kind: 'code' })}>
          <Icon name="code" size={17} /> Code
        </button>
      </nav>

      <label className="search">
        <Icon name="search" size={15} />
        <input placeholder="Search chats" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        )}
      </label>

      <div className="chat-list">
        {shown.length === 0 && (
          <p className="chat-list-empty">
            {needle
              ? 'No chats match.'
              : inPanel
                ? 'No reviewed chats yet.'
                : `No ${MODE_NAME[mode]} chats yet. Start one, or import your history in Settings.`}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="chat-group">
            <div className="group-label">{group.label}</div>
            {group.items.map((meta) => (
              <ChatRow
                key={meta.id}
                meta={meta}
                active={(view.kind === 'chat' || view.kind === 'threefold') && meta.id === activeId}
              />
            ))}
          </div>
        ))}
        {!needle && mine.length > limit && (
          <button className="show-more" onClick={() => setLimit((value) => value + PAGE)}>
            Show more ({mine.length - limit} older)
          </button>
        )}
      </div>

      <div className="sidebar-foot">
        <CreditMeter />
        <button className="user-row" onClick={() => openSettings('general')}>
          <span className="avatar">{(name.trim()[0] ?? 'T').toUpperCase()}</span>
          <span className="user-name">{name.trim() || 'Settings'}</span>
          <Icon name="settings" size={16} />
        </button>
      </div>
    </aside>
  )
}
