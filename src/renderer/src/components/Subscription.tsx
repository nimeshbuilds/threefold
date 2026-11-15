// Code tab: use a Claude or ChatGPT subscription for coding sessions.
//
// The button in the Code tab opens a panel that checks the official CLI
// (Claude Code or Codex), installs or updates it, signs in through the maker's
// own page, and then lets the user switch "use my subscription first" on.

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

/** The button in the Code tab's top bar. Says whether the subscription is in use and opens the panel. */
export function SubscriptionButton() {
  const mode = useApp((s) => s.mode)
  const on = useApp((s) => (isCliProvider(s.mode) ? Boolean(s.settings?.subscription[s.mode]) : false))
  const open = useApp((s) => s.openSubscription)
  if (!isCliProvider(mode)) return null
  return (
    <button
      className={`crumb sub-button ${on ? 'on' : ''}`}
      onClick={open}
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
  const provider: CliProvider = isCliProvider(mode) ? mode : 'claude'
  const name = CLI_NAME[provider]
  const plan = PLAN_NAME[provider]
  const maker = API_NAME[provider]

  const [status, setStatus] = useState<CliStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [task, setTask] = useState<'install' | 'login' | null>(null)
  const [log, setLog] = useState<{ install: string; login: string }>({ install: '', login: '' })
  const [code, setCode] = useState('')
  const logEnd = useRef<HTMLPreElement>(null)

  const refresh = useCallback(async () => {
    setChecking(true)
    setStatus(await api.cli.status(provider))
    setChecking(false)
  }, [provider])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return api.cli.onEvent((event: CliEvent) => {
      if (event.provider !== provider) return
      if (event.type === 'output') {
        setLog((current) => ({ ...current, [event.task]: (current[event.task] + event.text).slice(-6000) }))
      } else {
        setTask(null)
        if (!event.ok && event.error) notify(event.error, 'error')
        void refresh()
      }
    })
  }, [provider, notify, refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(() => {
    const element = logEnd.current
    if (element) element.scrollTop = element.scrollHeight
  }, [log])

  if (!settings) return null
  const on = settings.subscription[provider]
  const ready = cliReady(status)
  const needsUpdate = Boolean(status?.installed && (status.outdated || status.unsupported))

  const install = (): void => {
    setTask('install')
    setLog((current) => ({ ...current, install: '' }))
    void api.cli.install(provider)
  }
  const login = (): void => {
    setTask('login')
    setLog((current) => ({ ...current, login: '' }))
    void api.cli.login(provider)
  }
  const toggle = (): void => void update({ subscription: { ...settings.subscription, [provider]: !on } })

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

        <div className="key-setup sub-step">
          <div className="key-setup-head">
            <h3>1. {name} on this Mac</h3>
            <span className={`status ${status?.installed && !needsUpdate ? 'ok' : ''}`}>
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
                ? `${name} was not found on this Mac.`
                : `Version ${status.version}${
                    status.latest ? (status.outdated ? `. The newest is ${status.latest}.` : ', the newest.') : '. Could not check for a newer one.'
                  }${status.unsupported ? ` Threefold needs a newer version than this to run it.` : ''}`}
            </p>
          )}
          {status && (!status.installed || needsUpdate) && (
            <>
              <div className="key-row">
                <button className="btn primary" disabled={task !== null} onClick={install}>
                  <Icon name="download" size={15} />{' '}
                  {task === 'install' ? (status.installed ? 'Updating…' : 'Installing…') : status.installed ? `Update ${name}` : `Install ${name}`}
                </button>
                {task === 'install' && (
                  <button className="btn ghost" onClick={() => void api.cli.cancel(provider)}>
                    Cancel
                  </button>
                )}
              </div>
              {status.installCommand && (
                <p className="muted small">
                  This runs {maker}’s own {status.installed ? 'update' : 'install'} command: <code>{status.installCommand}</code>
                </p>
              )}
            </>
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
                ? 'Install it first'
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
                ? `${name} is signed in with an API account, which is billed per token. Sign in with your ${MODE_NAME[provider]} account to use your plan.`
                : `Signing in opens ${maker}’s own page in your browser.`}{' '}
            {name} keeps the sign-in itself. Threefold never sees your password or any token.
          </p>
          {status?.installed && status.account !== 'subscription' && (
            <div className="key-row">
              <button className="btn primary" disabled={task !== null} onClick={login}>
                <Icon name="external" size={15} /> {task === 'login' ? 'Waiting for your browser…' : `Sign in with ${MODE_NAME[provider]}`}
              </button>
              {task === 'login' && (
                <button className="btn ghost" onClick={() => void api.cli.cancel(provider)}>
                  Cancel
                </button>
              )}
            </div>
          )}
          {log.login && (
            <pre className="cli-log" ref={task === 'login' ? logEnd : undefined}>
              {log.login}
            </pre>
          )}
          {task === 'login' && (
            <div className="key-row">
              <input
                className="input"
                placeholder="If your browser shows a code, paste it here"
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
              disabled={!on && !ready}
              onClick={toggle}
            />
          </label>
          {!ready && !on && <p className="muted small">Finish steps 1 and 2 to switch this on.</p>}
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
