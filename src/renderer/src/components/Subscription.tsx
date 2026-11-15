// Code tab: use a Claude or ChatGPT subscription for coding sessions.
//
// The button in the Code tab opens a panel with one button that does whatever
// is still missing: install the official CLI (Claude Code or Codex), sign in
// through its maker's own page, and switch "use my subscription first" on.
// Nothing here asks the user to open a terminal.

import { useCallback, useEffect, useRef, useState } from 'react'
import { isCliProvider, type CliEvent, type CliProvider, type CliStatus } from '@shared/types'
import { API_NAME, MODE_NAME } from '../lib/format'
import { useApp } from '../state'
import { Icon } from './Icon'

const api = window.threefold

export const CLI_NAME: Record<CliProvider, string> = { claude: 'Claude Code', chatgpt: 'Codex' }
export const PLAN_NAME: Record<CliProvider, string> = { claude: 'Claude plan', chatgpt: 'ChatGPT plan' }

function clock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Is this CLI ready to run a session on the user's plan? */
export function cliReady(status: CliStatus | null): boolean {
  return Boolean(status?.installed && !status.unsupported && status.account === 'subscription')
}

/** "Install Claude Code, sign in and switch on": what one click on the setup button will do. */
export function setupSteps(status: CliStatus | null, on: boolean, name: string): string[] {
  const steps: string[] = []
  if (!status?.installed) steps.push(`install ${name}`)
  else if (status.unsupported) steps.push(`update ${name}`)
  if (status?.account !== 'subscription') steps.push('sign in')
  if (!on) steps.push('switch on')
  return steps
}

function sentence(parts: string[]): string {
  const joined = parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return joined ? joined[0]!.toUpperCase() + joined.slice(1) : ''
}

/** The button in the Code tab's top bar. Says whether the subscription is in use and opens the panel. */
export function SubscriptionButton() {
  const mode = useApp((s) => s.mode)
  const on = useApp((s) => (isCliProvider(s.mode) ? Boolean(s.settings?.subscription[s.mode]) : false))
  const open = useApp((s) => s.openSubscription)
  if (!isCliProvider(mode)) return null
  return (
    <button
      className={`crumb sub-button ${on ? 'on' : ''}`}
      onClick={() => open()}
      title={on ? `New sessions use your ${PLAN_NAME[mode]} first, then your API key` : `Run coding sessions on your ${PLAN_NAME[mode]}`}
    >
      <Icon name={on ? 'check' : 'bolt'} size={14} /> {on ? 'Subscription first' : 'Use subscription'}
    </button>
  )
}

export function SubscriptionPanel() {
  const mode = useApp((s) => s.mode)
  const close = useApp((s) => s.closeModal)
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const hasKey = useApp((s) => s.keys[s.mode])
  const notify = useApp((s) => s.notify)
  const auto = useApp((s) => s.subscriptionAuto)
  const provider: CliProvider = isCliProvider(mode) ? mode : 'claude'
  const name = CLI_NAME[provider]
  const plan = PLAN_NAME[provider]
  const maker = API_NAME[provider]

  const [status, setStatus] = useState<CliStatus | null>(null)
  const [checking, setChecking] = useState(true)
  /** What is running right now. */
  const [task, setTask] = useState<'install' | 'login' | null>(null)
  const [log, setLog] = useState<{ install: string; login: string }>({ install: '', login: '' })
  const [code, setCode] = useState('')
  const logEnd = useRef<HTMLPreElement>(null)
  const running = useRef(false)
  const autoStarted = useRef(false)

  const refresh = useCallback(async (): Promise<CliStatus> => {
    setChecking(true)
    const next = await api.cli.status(provider)
    setStatus(next)
    setChecking(false)
    return next
  }, [provider])

  useEffect(() => {
    return api.cli.onEvent((event: CliEvent) => {
      if (event.provider !== provider) return
      if (event.type === 'output') {
        setLog((current) => ({ ...current, [event.task]: (current[event.task] + event.text).slice(-6000) }))
      } else if (!event.ok && event.error) {
        notify(event.error, 'error')
      }
    })
  }, [provider, notify])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  // Closing the panel half-way stops an install or a sign-in that is still waiting.
  useEffect(() => {
    return () => {
      if (running.current) void api.cli.cancel(provider)
    }
  }, [provider])

  useEffect(() => {
    const element = logEnd.current
    if (element) element.scrollTop = element.scrollHeight
  }, [log])

  const begin = (next: 'install' | 'login'): void => {
    setTask(next)
    setLog((current) => ({ ...current, [next]: '' }))
  }

  /** Does everything that is still missing, in order, and switches the subscription on. */
  const setUp = useCallback(async (): Promise<void> => {
    if (running.current) return
    running.current = true
    try {
      let now = await refresh()
      if (!now.installed || now.unsupported) {
        begin('install')
        const result = await api.cli.install(provider)
        now = await refresh()
        if (!result.ok || !now.installed || now.unsupported) return
      }
      if (now.account !== 'subscription') {
        begin('login')
        await api.cli.login(provider)
        now = await refresh()
        if (now.account !== 'subscription') return
      }
      setTask(null)
      const current = useApp.getState().settings
      if (current && !current.subscription[provider]) {
        await update({ subscription: { ...current.subscription, [provider]: true } })
      }
      notify(`Your ${plan} is now used first for coding.`)
      // Opened from a session that was waiting for this: go straight back to it.
      const { subscriptionAuto, subscriptionThen } = useApp.getState()
      if (subscriptionAuto || subscriptionThen) {
        close()
        subscriptionThen?.()
      }
    } finally {
      running.current = false
      setTask(null)
    }
  }, [provider, plan, refresh, update, notify, close])

  const updateOnly = useCallback(async (): Promise<void> => {
    if (running.current) return
    running.current = true
    try {
      begin('install')
      await api.cli.install(provider)
      await refresh()
    } finally {
      running.current = false
      setTask(null)
    }
  }, [provider, refresh])

  // First look at the CLI; when the panel was opened to finish setup, start at once.
  useEffect(() => {
    if (auto && !autoStarted.current) {
      autoStarted.current = true
      void setUp()
    } else if (!auto) {
      void refresh()
    }
  }, [auto, setUp, refresh])

  if (!settings) return null
  const on = settings.subscription[provider]
  const ready = cliReady(status)
  const steps = setupSteps(status, on, name)
  const signInUrl = log.login.match(/https?:\/\/[^\s"'<>]+/g)?.at(-1)

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal sub-modal" role="dialog" aria-label={`Use your ${plan} for coding`}>
        <button className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
        <h2>Use your {MODE_NAME[provider]} subscription for coding</h2>
        <p className="lead">
          With this on, coding sessions in {MODE_NAME[provider]} mode run through {name}, {maker}’s own command-line
          tool, signed in with your own account. <strong>Your {plan} is used first.</strong> When the plan’s limit is
          reached, Threefold carries on in the same session with your API key, and tells you.
        </p>

        <div className="sub-setup">
          {on && ready ? (
            <p className="sub-done">
              <Icon name="check" size={16} /> On. New coding sessions use your {plan} first.
            </p>
          ) : task ? (
            <>
              <p className="sub-doing" role="status">
                <span className="dot" />
                {task === 'install'
                  ? `${status?.installed ? 'Updating' : 'Installing'} ${name}…`
                  : `Waiting for you to approve the sign-in in your browser…`}
              </p>
              <button className="btn ghost" onClick={() => void api.cli.cancel(provider)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn primary sub-go" disabled={checking && !status} onClick={() => void setUp()}>
                <Icon name="bolt" size={16} /> {status ? sentence(steps) : 'Checking…'}
              </button>
              <span className="muted small">
                {steps.includes('sign in')
                  ? 'One click does it all. The sign-in opens in your browser.'
                  : steps.length > 1
                    ? 'One click does it all.'
                    : `${name} is installed and signed in.`}
              </span>
            </>
          )}
        </div>

        {task === 'login' && (
          <div className="sub-signin">
            <p>
              {maker}’s sign-in page should have opened in your browser. Approve it there, and this window carries on by
              itself.
            </p>
            <div className="key-row">
              {signInUrl && (
                <button className="btn" onClick={() => void api.app.openExternal(signInUrl)}>
                  <Icon name="external" size={15} /> Open the sign-in page
                </button>
              )}
              <input
                className="input"
                placeholder="If the page shows a code, paste it here"
                value={code}
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && code.trim()) {
                    void api.cli.loginInput(provider, code)
                    setCode('')
                  }
                }}
              />
              <button
                className="btn"
                disabled={!code.trim()}
                onClick={() => {
                  void api.cli.loginInput(provider, code)
                  setCode('')
                }}
              >
                Send
              </button>
            </div>
          </div>
        )}

        <div className="key-setup sub-step">
          <div className="key-setup-head">
            <h3>1. {name} on this Mac</h3>
            <span className={`status ${status?.installed && !status.unsupported && !status.outdated ? 'ok' : ''}`}>
              {checking && !status
                ? 'Checking…'
                : !status?.installed
                  ? 'Not installed'
                  : status.unsupported
                    ? 'Too old'
                    : status.outdated
                      ? 'Update available'
                      : 'Up to date'}
            </span>
          </div>
          {status?.error && <p className="form-error">{status.error}</p>}
          {status && (
            <p className="sub-line">
              {!status.installed
                ? `${name} is not on this Mac yet. Threefold installs it with ${maker}’s own installer.`
                : `Version ${status.version}${
                    status.latest ? (status.outdated ? `. The newest is ${status.latest}.` : ', the newest.') : '. Could not check for a newer one.'
                  }${status.unsupported ? ' Threefold needs a newer version than this to run it.' : ''}`}
            </p>
          )}
          {status?.installed && status.outdated && !status.unsupported && (
            <div className="key-row">
              <button className="btn" disabled={task !== null} onClick={() => void updateOnly()}>
                <Icon name="download" size={15} /> Update {name}
              </button>
              <span className="muted small">Optional. This version works.</span>
            </div>
          )}
          {status?.installCommand && (!status.installed || status.outdated || status.unsupported) && (
            <p className="muted small">
              {status.installed ? 'Updating' : 'Installing'} runs {maker}’s own command: <code>{status.installCommand}</code>
            </p>
          )}
          {log.install && (
            <pre className="cli-log" ref={task === 'install' ? logEnd : undefined}>
              {log.install}
            </pre>
          )}
        </div>

        <div className="key-setup sub-step">
          <div className="key-setup-head">
            <h3>2. Signed in to your account</h3>
            <span className={`status ${status?.account === 'subscription' ? 'ok' : ''}`}>
              {!status?.installed
                ? 'After installing'
                : status.account === 'subscription'
                  ? `Signed in${status.plan ? ` · ${status.plan} plan` : ''}`
                  : status.account === 'api'
                    ? 'Signed in with an API account'
                    : 'Not signed in'}
            </span>
          </div>
          <p className="sub-line">
            {status?.account === 'subscription'
              ? `${name} is signed in with your ${plan}.`
              : status?.account === 'api'
                ? `${name} is signed in with an API account, which is billed per token. Signing in with your ${MODE_NAME[provider]} account switches it to your plan.`
                : `Signing in opens ${maker}’s own page in your browser.`}{' '}
            {name} keeps the sign-in itself. Threefold never sees your password or any token.
          </p>
          {log.login && (
            <pre className="cli-log" ref={task === 'login' ? logEnd : undefined}>
              {log.login}
            </pre>
          )}
        </div>

        <div className="key-setup sub-step">
          <div className="key-setup-head">
            <h3>3. Use it</h3>
            <span className={`status ${on && ready ? 'ok' : ''}`}>{on ? (ready ? 'On' : 'On, but not ready') : 'Off'}</span>
          </div>
          <label className="toggle-row">
            <span>
              <strong>Use my {plan} first</strong>
              <small>
                Coding sessions you start from now on run on your plan. When its limit is reached, the same session
                carries on with your API key.
              </small>
            </span>
            <button
              className={`switch ${on ? 'on' : ''}`}
              role="switch"
              aria-checked={on}
              aria-label={`Use my ${plan} first`}
              disabled={(!on && !ready) || task !== null}
              onClick={() => void update({ subscription: { ...settings.subscription, [provider]: !on } })}
            />
          </label>
          {status?.limitedUntil && (
            <p className="sub-line">
              Your {plan}’s limit is reached until {clock(status.limitedUntil)}. Sessions use your API key until then.
            </p>
          )}
          <ul className="sub-notes">
            <li>
              Work on your plan is not billed to your API key and is not counted on the meter. Every turn ends with a
              line saying what paid for it.
            </li>
            <li>
              {hasKey
                ? `When your API key takes over, its cost shows live as usual and is billed by ${maker}.`
                : `No ${maker} API key is saved, so a turn stops when the plan’s limit is reached. Add a key in Settings to have it carry on.`}
            </li>
            <li>
              {provider === 'claude'
                ? 'Claude Code still asks you before it edits a file or runs a command.'
                : 'Codex does not ask before each step. It works in its own sandbox: it can change files in the project folder and nowhere else, and it has no network access.'}
            </li>
            <li>
              Threefold runs {name} exactly as {maker} publishes it. Your plan’s own terms and limits apply.
            </li>
          </ul>
        </div>

        <div className="handoff-modal-actions">
          <button className="btn ghost" disabled={checking || task !== null} onClick={() => void refresh()}>
            <Icon name="refresh" size={15} /> {checking ? 'Checking…' : 'Check again'}
          </button>
          <span className="handoff-spacer" />
          <button className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
