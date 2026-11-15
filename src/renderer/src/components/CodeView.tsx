import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isCliProvider } from '@shared/types'
import type { CodeEvent, CodeItem, CodeSession, CodeSessionMeta, PermissionRequest } from '@shared/types'
import { formatUsd, modelLabel } from '@shared/pricing'
import { MODE_NAME, shortDate } from '../lib/format'
import { useApp } from '../state'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { CLI_NAME, PLAN_NAME, SubscriptionButton } from './Subscription'

const api = window.threefold

function ToolCard({ item }: { item: Extract<CodeItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(item.input || item.output)
  return (
    <div className={`event event-${item.status === 'denied' ? 'error' : item.status}`}>
      <button className="event-head" disabled={!expandable} onClick={() => setOpen((value) => !value)}>
        <Icon name={/run|bash/i.test(item.name) ? 'terminal' : /search|grep|glob|web/i.test(item.name) ? 'search' : 'file'} size={15} />
        <span className={item.status === 'running' ? 'shimmer' : ''}>{item.summary}</span>
        {item.status === 'denied' && <span className="event-hint">declined</span>}
        {item.status === 'error' && <span className="event-hint">failed</span>}
        {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />}
      </button>
      {open && (
        <div className="event-body">
          {item.input && <pre>{item.input}</pre>}
          {item.output && <pre className="event-output">{item.output}</pre>}
        </div>
      )}
    </div>
  )
}

/**
 * @param onSetup given for a notice that says the CLI needs installing or signing in to:
 *   what its button does. Absent once that turn is no longer the latest.
 */
function ItemView({ item, onSetup }: { item: CodeItem; onSetup?: () => void }) {
  switch (item.type) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
        </div>
      )
    case 'text':
      return item.text ? (
        <div className="msg assistant">
          <Markdown text={item.text} />
        </div>
      ) : null
    case 'thinking':
      return item.text ? <div className="code-thinking">{item.text}</div> : null
    case 'tool':
      return <ToolCard item={item} />
    case 'notice':
      return (
        <div className={`msg-error ${item.tone === 'info' ? 'muted' : ''} ${item.setup && onSetup ? 'with-action' : ''}`}>
          <span>{item.text}</span>
          {item.setup && onSetup && (
            <button className="btn primary small" onClick={onSetup}>
              {item.setup.need === 'install' ? `Install ${CLI_NAME[item.setup.provider]}` : 'Sign in'}
            </button>
          )}
        </div>
      )
  }
}

function PermissionCard({ request, onDecide }: { request: PermissionRequest; onDecide: (decision: 'allow' | 'allow-always' | 'deny') => void }) {
  return (
    <div className="permission" role="alertdialog" aria-label="Permission needed">
      <div className="permission-head">
        <Icon name="info" size={16} />
        <strong>Allow this?</strong>
        <span>{request.summary}</span>
      </div>
      {request.detail && <pre>{request.detail}</pre>}
      <div className="permission-actions">
        <button className="btn primary" onClick={() => onDecide('allow')}>
          Allow once
        </button>
        <button className="btn" onClick={() => onDecide('allow-always')}>
          Always allow {request.tool} in this session
        </button>
        <button className="btn ghost" onClick={() => onDecide('deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

export function CodeView() {
  const mode = useApp((s) => s.mode)
  const hasKey = useApp((s) => s.keys[s.mode])
  const models = useApp((s) => s.models[s.mode])
  const notify = useApp((s) => s.notify)
  const openSettings = useApp((s) => s.openSettings)
  const openSubscription = useApp((s) => s.openSubscription)
  // "Use my subscription first" is switched on for this mode.
  const onPlan = useApp((s) => (isCliProvider(s.mode) ? Boolean(s.settings?.subscription[s.mode]) : false))

  const [sessions, setSessions] = useState<CodeSessionMeta[]>([])
  const [session, setSession] = useState<CodeSession | null>(null)
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [cost, setCost] = useState<{ usd: number; estimated: boolean }>({ usd: 0, estimated: false })
  const [prompt, setPrompt] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const sessionId = session?.id ?? null

  const refreshList = useCallback(async () => setSessions(await api.code.list()), [])

  const load = useCallback(async (id: string) => {
    const loaded = await api.code.get(id)
    if (!loaded) return
    setSession(loaded)
    setRunning(Boolean(loaded.running))
    setPermission(loaded.pendingPermission ?? null)
    setCost({ usd: loaded.costUsd, estimated: false })
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // A different mode shows that mode's sessions.
  useEffect(() => {
    setSession(null)
    setPermission(null)
    setRunning(false)
  }, [mode])

  useEffect(() => {
    return api.code.onEvent((event: CodeEvent) => {
      if (event.type === 'done') void refreshList()
      if (event.sessionId !== sessionId) return
      switch (event.type) {
        case 'item':
          setSession((current) => {
            if (!current) return current
            const index = current.items.findIndex((item) => item.id === event.item.id)
            const items = [...current.items]
            if (index === -1) items.push(event.item)
            else items[index] = event.item
            return { ...current, items }
          })
          break
        case 'delta':
          setSession((current) => {
            if (!current) return current
            return {
              ...current,
              items: current.items.map((item) =>
                item.id === event.itemId && (item.type === 'text' || item.type === 'thinking')
                  ? { ...item, text: item.text + event.delta }
                  : item,
              ),
            }
          })
          break
        case 'permission':
          setPermission(event.request)
          break
        case 'usage':
          setCost({ usd: event.costUsd, estimated: event.estimated })
          break
        case 'done':
          setRunning(false)
          setPermission(null)
          break
        case 'error':
          notify(event.error, 'error')
          break
      }
    })
  }, [sessionId, notify, refreshList])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [session?.items, permission])

  const start = async (): Promise<void> => {
    if (!session || !prompt.trim() || running) return
    const text = prompt
    setPrompt('')
    setRunning(true)
    const result = await api.code.send(session.id, text, session.model)
    if (!result.ok) {
      setRunning(false)
      setPrompt(text)
      notify(result.error ?? 'The agent could not start.', 'error')
    }
  }

  // A turn can stop because the CLI needs installing or signing in to. Its notice then carries a
  // button that does it on the spot. When the turn never got going, the prompt is sent again after.
  const items = session?.items ?? []
  const lastUser = items.reduce((found, item, index) => (item.type === 'user' ? index : found), -1)
  const lastPrompt = lastUser === -1 ? null : (items[lastUser] as Extract<CodeItem, { type: 'user' }>).text
  const turnRan = items.slice(lastUser + 1).some((item) => item.type !== 'notice')
  const fixAndCarryOn = (): void => {
    if (!session || lastPrompt === null) return
    const id = session.id
    const model = session.model
    openSubscription({
      auto: true,
      then: turnRan
        ? undefined
        : () => {
            setSession((current) =>
              current && current.id === id
                ? { ...current, items: current.items.filter((item, index) => index <= lastUser || item.type !== 'notice' || !item.setup) }
                : current,
            )
            setRunning(true)
            void api.code.send(id, lastPrompt, model, true).then((result) => {
              if (result.ok) return
              setRunning(false)
              notify(result.error ?? 'The agent could not start.', 'error')
            })
          },
    })
  }

  const mine = sessions.filter((s) => s.provider === mode)
  // This session runs through the official CLI (Claude Code or Codex).
  const cliSession = session?.engine === 'cli' && isCliProvider(session.provider) ? session.provider : null

  return (
    <section className="page code-page">
      <header className="topbar">
        <span className="topbar-title muted">Code · {MODE_NAME[mode]} mode</span>
        <span className="topbar-spacer" />
        <SubscriptionButton />
        {session && (
          <span
            className={`cost-chip ${running ? 'live' : ''}`}
            title={
              cliSession
                ? 'What this session has cost on your API key. Work done on your plan is not billed per message.'
                : 'What this coding session has cost so far.'
            }
          >
            {running && <span className="dot" />}
            This session {formatUsd(cost.usd, { estimated: cost.estimated && running })}
            {cliSession ? ' on API' : ''}
          </span>
        )}
      </header>
      <div className="code-layout">
        <div className="code-sessions">
          <button
            className="btn primary block"
            onClick={async () => {
              // On a subscription the API key is only the fallback, so it is not needed to start.
              if (!hasKey && !onPlan) {
                openSettings('keys')
                return
              }
              const created = await api.code.create(mode)
              if (created) {
                await refreshList()
                await load(created.id)
              }
            }}
          >
            <Icon name="folder" size={16} /> Open a project folder
          </button>
          {mine.length === 0 && <p className="muted small">No coding sessions yet.</p>}
          {mine.map((meta) => (
            <div key={meta.id} className={`chat-row ${meta.id === sessionId ? 'active' : ''}`}>
              <button className="chat-row-main" onClick={() => void load(meta.id)} title={meta.cwd}>
                <span className="chat-row-title">{meta.title}</span>
              </button>
              <button
                className="row-more"
                title="Delete session"
                onClick={async () => {
                  await api.code.remove(meta.id)
                  if (meta.id === sessionId) setSession(null)
                  await refreshList()
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="code-main">
          {!session ? (
            <div className="empty">
              <div className="empty-inner">
                <Icon name="code" size={40} />
                <h1>A coding agent in your project folder</h1>
                <p className="lead">
                  {isCliProvider(mode) && onPlan
                    ? `New sessions run ${CLI_NAME[mode]} on your ${PLAN_NAME[mode]} first. When the plan’s limit is reached, the same session carries on with your API key, and says so.`
                    : mode === 'claude'
                      ? 'Claude mode runs the Claude Agent SDK (the engine behind Claude Code) with your API key, so the work is billed to your API credits.'
                      : mode === 'chatgpt'
                        ? 'ChatGPT mode runs a coding agent on the OpenAI API with file and shell tools, billed to your API credits.'
                        : 'Gemini mode runs a coding agent on the Gemini API with file and shell tools, billed to your Google credits.'}
                </p>
                <p className="muted small">
                  {mode === 'chatgpt' && onPlan
                    ? 'Codex works in its own sandbox: it can change files in the folder you choose and nowhere else, has no network access, and does not ask before each step.'
                    : 'It can read the folder freely. Before it edits a file or runs a command it asks you first.'}
                </p>
                {isCliProvider(mode) && !onPlan && (
                  <p className="muted small">
                    Have a {mode === 'claude' ? 'Claude' : 'ChatGPT'} subscription? <strong>Use subscription</strong>, at the top
                    right, runs {CLI_NAME[mode]} on your plan first and falls back to your API key.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="code-meta">
                <Icon name="folder" size={14} />
                <span title={session.cwd}>{session.cwd}</span>
                <span className="topbar-spacer" />
                {cliSession && (
                  <span
                    className="engine-tag"
                    title={`This session runs through ${CLI_NAME[cliSession]}. ${
                      onPlan ? `It uses your ${PLAN_NAME[cliSession]} first, then your API key.` : 'Subscription use is switched off, so it runs on your API key.'
                    }`}
                  >
                    {CLI_NAME[cliSession]} · {onPlan ? 'plan first' : 'API key'}
                  </span>
                )}
                <select
                  className="select"
                  value={session.model}
                  disabled={running}
                  title={
                    cliSession
                      ? `Used when your API key pays. On your plan, ${CLI_NAME[cliSession]} picks its own model.`
                      : 'The model for this session'
                  }
                  onChange={(event) => setSession({ ...session, model: event.target.value })}
                >
                  {!models.some((m) => m.id === session.model) && <option value={session.model}>{modelLabel(session.model)}</option>}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <small className="muted">started {shortDate(session.createdAt)}</small>
              </div>
              <div className="thread" ref={scroller}>
                <div className="thread-inner">
                  {session.items.length === 0 && (
                    <p className="muted">Describe a task: “add a --json flag to the CLI”, “find why the tests fail”, “explain how auth works here”.</p>
                  )}
                  {session.items.map((item, index) => (
                    <ItemView key={item.id} item={item} onSetup={!running && index > lastUser ? fixAndCarryOn : undefined} />
                  ))}
                  {running && !permission && <span className="pulse" aria-label="Working" />}
                  {permission && (
                    <PermissionCard
                      request={permission}
                      onDecide={(decision) => {
                        void api.code.respond(permission.requestId, decision)
                        setPermission(null)
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="composer-dock">
                <div className="composer">
                  <textarea
                    rows={2}
                    placeholder="What should the agent do?"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void start()
                      }
                    }}
                  />
                  <div className="composer-row">
                    <span className="muted small">
                      {cliSession === 'chatgpt'
                        ? 'Codex works in a sandbox: this folder only, no network, no asking'
                        : 'Asks before editing files or running commands'}
                    </span>
                    <span className="composer-spacer" />
                    {running ? (
                      <button className="send-btn stop" title="Stop" onClick={() => void api.code.stop(session.id)}>
                        <Icon name="stop" size={18} />
                      </button>
                    ) : (
                      <button className="send-btn" title="Start" disabled={!prompt.trim()} onClick={() => void start()}>
                        <Icon name="arrowUp" size={18} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
