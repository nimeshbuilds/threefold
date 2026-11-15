import { useEffect, useState } from 'react'
import type { ImportResult, Memory, Provider, SpendSummary } from '@shared/types'
import { MODELS, PRICING_AS_OF, currentRates, formatTokens, formatUsd, modelLabel } from '@shared/pricing'
import nimeshbuildsLogo from '../assets/nimeshbuilds.png'
import { API_NAME, MODE_NAME, ORG_URL, daysUntil, shortDate } from '../lib/format'
import { useApp, type SettingsTab } from '../state'
import { FallbackSettings, HandoffImportBlock } from './Handoff'
import { SkillTab } from './Skill'
import { Icon } from './Icon'
import { Logo } from './Logo'

const api = window.threefold

const LINKS: Record<Provider, { billing: string; keys: string; credits: string; export: string }> = {
  gemini: {
    billing: 'https://aistudio.google.com/',
    keys: 'https://aistudio.google.com/apikey',
    credits: 'https://aistudio.google.com/learn/claim-google-ai-plan-credits-in-ai-studio',
    export: 'https://takeout.google.com/',
  },
  claude: {
    billing: 'https://claude.ai/settings/billing',
    keys: 'https://platform.claude.com/settings/keys',
    credits: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans',
    export: 'https://claude.ai/settings',
  },
  chatgpt: {
    billing: 'https://chatgpt.com/',
    keys: 'https://platform.openai.com/api-keys',
    credits: 'https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions',
    export: 'https://chatgpt.com/',
  },
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        void api.app.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** The three steps to connect one provider. Used in Settings and in the first-run wizard. */
export function KeySetup({ provider }: { provider: Provider }) {
  const connected = useApp((s) => s.keys[provider])
  const refreshKeys = useApp((s) => s.refreshKeys)
  const refreshModels = useApp((s) => s.refreshModels)
  const notify = useApp((s) => s.notify)
  const [key, setKey] = useState('')
  const [state, setState] = useState<'idle' | 'checking'>('idle')
  const [error, setError] = useState<string | null>(null)
  const links = LINKS[provider]
  const plans = { claude: 'Max, Ultra or Team', chatgpt: 'Pro or Business', gemini: 'Google AI Pro or Ultra' }[provider]
  const consoleName = { claude: 'Claude Console', chatgpt: 'OpenAI API Platform', gemini: 'Google AI Studio' }[provider]

  const save = async (): Promise<void> => {
    setState('checking')
    setError(null)
    const result = await api.keys.save(provider, key)
    setState('idle')
    if (!result.ok) {
      setError(result.error ?? 'The key could not be verified.')
      return
    }
    setKey('')
    await Promise.all([refreshKeys(), refreshModels()])
    notify(`${MODE_NAME[provider]} mode is connected.`)
  }

  return (
    <div className="key-setup">
      <div className="key-setup-head">
        <h3>{MODE_NAME[provider]} mode</h3>
        <span className={`status ${connected ? 'ok' : ''}`}>{connected ? 'Connected' : 'Not connected'}</span>
      </div>
      <ol className="steps">
        {provider === 'gemini' ? (
          <>
            <li>
              <strong>Claim your monthly credits</strong> (if your plan has them: {plans}). Open{' '}
              <Link href={links.billing}>Google AI Studio</Link> and follow the prompt to claim your plan's credits. Google
              asks for a one-time $5 prepayment before the credits can be used. <Link href={links.credits}>Official guide</Link>
            </li>
            <li>
              <strong>Create an API key</strong> in <Link href={links.keys}>{consoleName}</Link>, in the project that has
              billing set up. A key on the free tier also works, with low daily limits and not for every model.
            </li>
          </>
        ) : (
          <>
            <li>
              <strong>Claim your monthly API credits</strong> (if your plan has them: {plans}). In{' '}
              <Link href={links.billing}>{MODE_NAME[provider]} → Settings → Billing</Link>, find <em>API credits</em> and
              link an API organization. Your plan must be at least 7 days old.{' '}
              <Link href={links.credits}>Official guide</Link>
            </li>
            <li>
              <strong>Create an API key</strong> in that same organization on the{' '}
              <Link href={links.keys}>{consoleName}</Link>. Without credits this still works; usage is then billed to the
              card on your API account.
            </li>
          </>
        )}
        <li>
          <strong>Paste the key here.</strong> It is checked with a free request and stored encrypted on this computer.
        </li>
      </ol>
      <div className="key-row">
        <input
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            connected
              ? 'Paste a new key to replace the saved one'
              : { claude: 'sk-ant-…', chatgpt: 'sk-…', gemini: 'AIza…' }[provider]
          }
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && key.trim()) void save()
          }}
        />
        <button className="btn primary" disabled={!key.trim() || state === 'checking'} onClick={() => void save()}>
          {state === 'checking' ? 'Checking…' : connected ? 'Replace' : 'Connect'}
        </button>
        {connected && (
          <button
            className="btn ghost"
            onClick={async () => {
              await api.keys.remove(provider)
              await refreshKeys()
            }}
          >
            Remove
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

export function CreditFields({ provider }: { provider: Provider }) {
  const plan = useApp((s) => s.settings?.credits[provider])
  const update = useApp((s) => s.updateSettings)
  const settings = useApp((s) => s.settings)
  if (!plan || !settings) return null
  const options = provider === 'gemini' ? [0, 10, 40, 100] : [0, 100, 200, 500]
  const set = (patch: Partial<typeof plan>): void => {
    void update({ credits: { ...settings.credits, [provider]: { ...plan, ...patch } } })
  }
  return (
    <div className="credit-fields">
      <h3>{MODE_NAME[provider]}</h3>
      <div className="field-row">
        <label className="field">
          <span>Monthly API credits</span>
          <div className="seg wide">
            {options.map((amount) => (
              <button key={amount} className={plan.monthlyUsd === amount ? 'active' : ''} onClick={() => set({ monthlyUsd: amount })}>
                {amount === 0 ? 'None' : `$${amount}`}
              </button>
            ))}
          </div>
        </label>
        <label className="field narrow">
          <span>Other amount</span>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={plan.monthlyUsd}
            onChange={(event) => set({ monthlyUsd: Math.max(0, Number(event.target.value) || 0) })}
          />
        </label>
        <label className="field narrow">
          <span>Renews on day</span>
          <input
            className="input"
            type="number"
            min={1}
            max={28}
            value={plan.renewalDay}
            onChange={(event) => set({ renewalDay: Math.min(28, Math.max(1, Number(event.target.value) || 1)) })}
          />
        </label>
      </div>
      {provider === 'gemini' && (
        <p className="muted small">
          Google's credits stay valid for 12 months and add up, so what you do not use is not lost at renewal. The meter
          still counts one month at a time.
        </p>
      )}
    </div>
  )
}

function UsageBlock({ summary }: { summary: SpendSummary }) {
  const used = summary.spentUsd + summary.liveUsd
  const max = Math.max(0.0001, ...summary.byDay.map((d) => d.costUsd))
  return (
    <div className="usage-block">
      <div className="usage-head">
        <h3>{MODE_NAME[summary.provider]}</h3>
        <span className="muted">
          {shortDate(summary.cycleStart)} – {shortDate(summary.cycleEnd - 1)} · renews in {daysUntil(summary.cycleEnd)} days
        </span>
      </div>
      <div className="stat-row">
        <div className="stat">
          <small>Spent this cycle</small>
          <strong>{formatUsd(used)}</strong>
        </div>
        <div className="stat">
          <small>Today</small>
          <strong>{formatUsd(summary.todayUsd)}</strong>
        </div>
        <div className="stat">
          <small>{summary.monthlyUsd > 0 ? 'Credits left' : 'Monthly credits'}</small>
          <strong>{summary.monthlyUsd > 0 ? formatUsd(Math.max(0, summary.monthlyUsd - used)) : 'Not set'}</strong>
        </div>
      </div>
      {summary.byDay.length > 0 && (
        <div className="day-bars" aria-label="Spend per day">
          {summary.byDay.map((day) => (
            <div key={day.day} className="day-bar" title={`${day.day}: ${formatUsd(day.costUsd)}`}>
              <div style={{ height: `${Math.max(4, (day.costUsd / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      )}
      {summary.byModel.length > 0 ? (
        <table className="plain-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Tokens in</th>
              <th>Tokens out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.byModel.map((row) => (
              <tr key={row.model}>
                <td>{modelLabel(row.model)}</td>
                <td>{formatTokens(row.inputTokens)}</td>
                <td>{formatTokens(row.outputTokens)}</td>
                <td>{formatUsd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Nothing spent in this cycle yet.</p>
      )}
    </div>
  )
}

function MemoryTab() {
  const enabled = useApp((s) => s.settings?.memoryEnabled ?? true)
  const update = useApp((s) => s.updateSettings)
  const [memories, setMemories] = useState<Memory[]>([])
  const [text, setText] = useState('')
  useEffect(() => {
    void api.memory.list().then(setMemories)
  }, [])
  return (
    <>
      <h2>Memory</h2>
      <p className="lead">
        Short facts the models may save about you and reuse in new chats, in every mode. They are stored only on this
        computer and added to the start of each new conversation.
      </p>
      <label className="toggle-row">
        <span>
          <strong>Use memory</strong>
          <small>When off, nothing is saved and nothing saved is sent.</small>
        </span>
        <button className={`switch ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} onClick={() => void update({ memoryEnabled: !enabled })} />
      </label>
      <div className="key-row">
        <input
          className="input"
          placeholder="Add a memory yourself, e.g. “I write TypeScript and prefer pnpm”"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && text.trim()) {
              void api.memory.add(text).then(setMemories)
              setText('')
            }
          }}
        />
        <button
          className="btn"
          disabled={!text.trim()}
          onClick={() => {
            void api.memory.add(text).then(setMemories)
            setText('')
          }}
        >
          Add
        </button>
      </div>
      {memories.length === 0 ? (
        <p className="muted">Nothing saved yet.</p>
      ) : (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <span>{memory.text}</span>
              <small>{memory.source === 'user' ? 'You' : MODE_NAME[memory.source]}</small>
              <button className="icon-btn" title="Forget this" onClick={() => void api.memory.remove(memory.id).then(setMemories)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {memories.length > 1 && (
        <button className="btn ghost danger" onClick={() => void api.memory.clear().then(setMemories)}>
          Forget everything
        </button>
      )}
    </>
  )
}

export function ImportBlock({ provider }: { provider: Provider }) {
  const refreshMetas = useApp((s) => s.refreshMetas)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const links = LINKS[provider]
  return (
    <div className="key-setup">
      <div className="key-setup-head">
        <h3>{MODE_NAME[provider]} history</h3>
      </div>
      <ol className="steps">
        {provider === 'claude' && (
          <>
            <li>
              On <Link href={links.export}>claude.ai</Link> or in the Claude desktop app (not the phone app), open{' '}
              <strong>Settings → Privacy</strong> and click <strong>Export data</strong>.
            </li>
            <li>
              Claude emails a download link to your account's address. Open it while signed in; it expires after 24
              hours.
            </li>
          </>
        )}
        {provider === 'chatgpt' && (
          <>
            <li>
              In <Link href={links.export}>ChatGPT</Link>, open your profile menu, then{' '}
              <strong>Settings → Data controls</strong>. Next to <strong>Export data</strong> click <strong>Export</strong>,
              then <strong>Confirm export</strong>.
            </li>
            <li>
              ChatGPT emails (or texts) you when the export is ready. That is often quick but can take days. Download it
              while signed in to the same account; the link expires after 24 hours.
            </li>
          </>
        )}
        {provider === 'gemini' && (
          <>
            <li>
              Open <Link href={links.export}>Google Takeout</Link> and click <strong>Deselect all</strong>. Scroll to{' '}
              <strong>My Activity</strong> and tick it. (Not the separate <em>Gemini</em> entry: that one holds your Gems,
              not your chats.)
            </li>
            <li>
              Under My Activity click <strong>All activity data included</strong>, choose <strong>Deselect all</strong>,
              tick only <strong>Gemini Apps</strong> and confirm.
            </li>
            <li>
              Still under My Activity click <strong>Multiple formats</strong> and set <strong>Activity records</strong> to{' '}
              <strong>JSON</strong>. This matters: the default is HTML, which Threefold cannot read.
            </li>
            <li>
              Click <strong>Next step</strong>, then <strong>Create export</strong>. Google emails you a download link.
            </li>
          </>
        )}
        <li>Download the ZIP file. You do not need to unzip it.</li>
        <li>
          Click the button below and choose that ZIP. The chats appear in the {MODE_NAME[provider]} mode sidebar and can be
          continued through the API.
        </li>
      </ol>
      <div className="key-row">
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setResult(null)
            const outcome = await api.importer.run(provider)
            setBusy(false)
            if (outcome) {
              setResult(outcome)
              await refreshMetas()
            }
          }}
        >
          <Icon name="upload" size={16} /> {busy ? 'Importing…' : 'Choose export file…'}
        </button>
      </div>
      {result && (
        <p className={result.errors.length > 0 && result.imported === 0 ? 'form-error' : 'form-ok'}>
          {result.imported > 0 || result.updated > 0
            ? `Imported ${result.imported} chat${result.imported === 1 ? '' : 's'}` +
              (result.updated > 0 ? `, refreshed ${result.updated}` : '') +
              (result.skipped > 0 ? `, skipped ${result.skipped} (already here or empty)` : '') +
              '.'
            : result.errors[0] ?? `Nothing new to import (${result.skipped} already here or empty).`}
        </p>
      )}
      <p className="muted small">
        The export is a snapshot. Chats you continue in Threefold do not sync back to {MODE_NAME[provider]}, and pictures
        and uploaded files are not part of the export. Importing the same export again adds only what is new.
        {provider === 'claude' &&
          ' On a Team or Enterprise plan, export works only if an owner has allowed members to export their data.'}
        {provider === 'chatgpt' && ' Business and Enterprise workspaces do not offer this export.'}
        {provider === 'gemini' &&
          ' Google exports an activity log, not conversations, so prompts made within half an hour of each other are grouped into one chat. Only activity that Gemini was saving (Gemini Apps Activity switched on) is included, and work or school accounts may not allow the export.'}
      </p>
    </div>
  )
}

const TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: 'user' },
  { id: 'keys', label: 'API keys', icon: 'key' },
  { id: 'credits', label: 'Credits', icon: 'bolt' },
  { id: 'usage', label: 'Spend', icon: 'chart' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'import', label: 'Import history', icon: 'upload' },
  { id: 'skill', label: 'Handoff skill', icon: 'handoff' },
  { id: 'about', label: 'About', icon: 'info' },
]

export function SettingsModal() {
  const tab = useApp((s) => s.settingsTab)
  const openSettings = useApp((s) => s.openSettings)
  const close = useApp((s) => s.closeModal)
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const spend = useApp((s) => s.spend)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api.app.version().then(setVersion)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  if (!settings) return null

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-label="Settings">
        <nav className="modal-nav">
          <div className="modal-nav-title">Settings</div>
          {TABS.map((item) => (
            <button key={item.id} className={`side-btn ${tab === item.id ? 'active' : ''}`} onClick={() => openSettings(item.id)}>
              <Icon name={item.icon} size={16} /> {item.label}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          <button className="icon-btn modal-close" onClick={close} aria-label="Close settings">
            <Icon name="close" size={18} />
          </button>

          {tab === 'general' && (
            <>
              <h2>General</h2>
              <label className="field">
                <span>Your name</span>
                <input
                  className="input"
                  placeholder="Used in the greeting and shared with the model"
                  defaultValue={settings.displayName}
                  onBlur={(event) => void update({ displayName: event.target.value.trim() })}
                />
              </label>
              <label className="field">
                <span>Appearance</span>
                <div className="seg wide">
                  {(['system', 'light', 'dark'] as const).map((theme) => (
                    <button key={theme} className={settings.theme === theme ? 'active' : ''} onClick={() => void update({ theme })}>
                      {theme === 'system' ? 'Match system' : theme === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </label>
              <p className="muted small">
                Shortcuts: ⌘1 Claude mode · ⌘2 ChatGPT mode · ⌘3 Gemini mode · ⌘4 Threefold review · ⌘N new chat · ⇧⌘H
                continue from a handoff · ⌘, settings · Enter to send, Shift+Enter for a new line.
              </p>
            </>
          )}

          {tab === 'keys' && (
            <>
              <h2>API keys</h2>
              <p className="lead">
                Threefold talks to Anthropic and OpenAI directly from this computer with your own keys. There is no Threefold
                server and no account.
              </p>
              <KeySetup provider="claude" />
              <KeySetup provider="chatgpt" />
              <KeySetup provider="gemini" />
            </>
          )}

          {tab === 'credits' && (
            <>
              <h2>Credits</h2>
              <p className="lead">
                Tell Threefold how much API credit your plan grants each month and when it renews, so the meter can show
                what is left. Threefold cannot read your real balance; it counts what it spends itself.
              </p>
              <CreditFields provider="claude" />
              <CreditFields provider="chatgpt" />
              <CreditFields provider="gemini" />
              <FallbackSettings />
            </>
          )}

          {tab === 'usage' && spend && (
            <>
              <h2>Spend</h2>
              <p className="lead">
                Counted from the token usage each API response reports, at the prices below. Spend outside Threefold is not
                included.
              </p>
              <UsageBlock summary={spend.claude} />
              <UsageBlock summary={spend.chatgpt} />
              <UsageBlock summary={spend.gemini} />
            </>
          )}

          {tab === 'memory' && <MemoryTab />}

          {tab === 'import' && (
            <>
              <h2>Import history</h2>
              <p className="lead">
                Bring one chat over in a minute with a handoff summary, or bring everything in from the official apps'
                data exports.
              </p>
              <HandoffImportBlock />
              <ImportBlock provider="claude" />
              <ImportBlock provider="chatgpt" />
              <ImportBlock provider="gemini" />
            </>
          )}

          {tab === 'skill' && <SkillTab />}

          {tab === 'about' && (
            <>
              <h2>About</h2>
              <div className="about-brand">
                <Logo size={48} />
                <div>
                  <strong>Threefold {version}</strong>
                  <p className="muted">Three assistants, one local app, your own API credits.</p>
                </div>
              </div>
              <p className="muted small">
                Threefold is an independent app. It is not made by, affiliated with or endorsed by Anthropic, OpenAI or
                Google. “Claude”, “ChatGPT” and “Gemini” are trademarks of their owners and are used here only to say
                which API a mode connects to.
              </p>
              <div className="built-by-card">
                <img src={nimeshbuildsLogo} width={40} height={40} alt="NimeshBuilds logo" />
                <div>
                  <strong>Built in public by Nimesh</strong>
                  <p>
                    Threefold is built by Nimesh under NimeshBuilds, a build-in-public organisation on GitHub where the
                    work is shared as it happens. Check out the GitHub org:{' '}
                    <Link href={ORG_URL}>github.com/nimeshbuilds</Link>
                  </p>
                </div>
              </div>
              <h3>Prices used for the meter</h3>
              <p className="muted small">
                USD per 1M tokens, from the providers' pricing pages on {PRICING_AS_OF}. Web search adds $0.01 per search
                (Gemini: 5,000 a month free, then $0.014). Price changes the providers have announced are applied on
                their start date.
              </p>
              <table className="plain-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Input</th>
                    <th>Cached</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {MODELS.map((model) => (
                    <tr key={model.id}>
                      <td>
                        {model.label}
                        {model.imageOutput !== undefined && ` (images $${model.imageOutput})`}
                      </td>
                      <td>${currentRates(model).input}</td>
                      <td>${currentRates(model).cacheRead}</td>
                      <td>${currentRates(model).output}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                {API_NAME.claude}, {API_NAME.chatgpt} and {API_NAME.gemini} set these prices and can change them.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
