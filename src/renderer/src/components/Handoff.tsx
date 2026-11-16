// Everything on screen that has to do with moving a chat between assistants:
// the low-credit notice, the progress card, the summary card at the top of a
// continued chat, the "hand off" menu, the paste dialog and the settings.

import { useEffect, useMemo, useState } from 'react'
import type { Handoff, HandoffProgress, Provider } from '@shared/types'
import { FALLBACK_MIN_PROVIDERS, FALLBACK_THRESHOLDS, type FallbackPlan } from '@shared/fallback'
import { HANDOFF_PROMPT, SKILL_NAME } from '@shared/handoff'
import { DEFAULT_MODEL, formatUsd, modelLabel } from '@shared/pricing'
import { API_NAME, MODE_NAME } from '../lib/format'
import { connectedProviders, fallbackPlan, useApp } from '../state'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { Popover } from './Popover'

const api = window.threefold

/**
 * The two kinds of handoff, named the same way wherever one shows up.
 * inside: a chat moves between providers here in Threefold; the provider it moves to writes the summary.
 * outside: a chat comes in from another app; the assistant it leaves wrote the summary.
 */
export const HANDOFF_KIND = {
  inside: 'Handoff inside Threefold',
  outside: 'Handoff from outside Threefold',
} as const

function KindTag({ kind }: { kind: keyof typeof HANDOFF_KIND }) {
  return <span className={`handoff-kind ${kind}`}>{HANDOFF_KIND[kind]}</span>
}

/** Where the next message will go. Recomputed only when something it depends on changes. */
export function useFallbackPlan(): FallbackPlan {
  const settings = useApp((s) => s.settings)
  const spend = useApp((s) => s.spend)
  const keys = useApp((s) => s.keys)
  const mode = useApp((s) => s.mode)
  const conversation = useApp((s) => s.conversation)
  const draft = useApp((s) => s.draft)
  const view = useApp((s) => s.view)
  return useMemo(
    () => fallbackPlan({ settings, spend, keys, mode, conversation, draft, view }),
    [settings, spend, keys, mode, conversation, draft, view],
  )
}

/** Above the message box: says before sending that the next message will go elsewhere, and lets the user say no. */
export function FallbackNotice() {
  const plan = useFallbackPlan()
  const mode = useApp((s) => s.conversation?.provider ?? s.mode)
  const started = useApp((s) => (s.conversation?.messages.length ?? 0) > 0 || Boolean(s.conversation?.handoff))
  const setNoFallback = useApp((s) => s.setNoFallback)
  if (plan.kind !== 'switch') return null
  const used = Math.round(plan.usedPct)
  return (
    <div className="composer-note fallback">
      <Icon name="handoff" size={14} />
      <span>
        {MODE_NAME[mode]} credit is {used}% used.{' '}
        {started
          ? `Your next message continues in ${MODE_NAME[plan.to]}, which first writes a handoff summary of this chat.`
          : `This chat will start in ${MODE_NAME[plan.to]} instead.`}
      </span>
      <button onClick={() => void setNoFallback(true)}>Stay on {MODE_NAME[mode]}</button>
    </div>
  )
}

/** Shown in the chat being left while the summary is written. */
export function HandoffWriting({ progress }: { progress: HandoffProgress }) {
  return (
    <div className="handoff-card writing" role="status">
      <span className="handoff-icon">
        <Icon name="handoff" size={18} />
      </span>
      <div className="handoff-text">
        <KindTag kind="inside" />
        <strong>Moving this chat to {MODE_NAME[progress.to]}</strong>
        <p>
          {progress.reason === 'credit' && `${MODE_NAME[progress.from]} credit is ${Math.round(progress.usedPct ?? 0)}% used. `}
          {modelLabel(progress.model)} is writing a handoff summary of the conversation so far
          {progress.usage ? ` · ${formatUsd(progress.usage.costUsd, { estimated: true })}` : ''}
          <span className="typing-dots" aria-hidden="true" />
        </p>
      </div>
    </div>
  )
}

/** At the top of a chat that continues another one: where it came from, and the summary itself. */
export function HandoffCard({ handoff }: { handoff: Handoff }) {
  const [open, setOpen] = useState(false)
  const openConversation = useApp((s) => s.openConversation)
  const hasOriginal = useApp((s) => Boolean(handoff.fromConversationId && s.metas.some((m) => m.id === handoff.fromConversationId)))
  const from = handoff.fromProvider ? MODE_NAME[handoff.fromProvider] : (handoff.from ?? 'another app')
  const cost = handoff.usage ? formatUsd(handoff.usage.costUsd) : null
  const writer = handoff.model ? modelLabel(handoff.model) : 'The new model'

  let detail: string
  if (handoff.source === 'fallback') {
    detail = `${from} credit was ${Math.round(handoff.usedPct ?? 0)}% used, so this chat moved here. ${writer} wrote a summary of the earlier conversation${cost ? ` for ${cost}` : ''}, and new replies build on it.`
  } else if (handoff.source === 'manual') {
    detail = `${writer} wrote a summary of the earlier conversation${cost ? ` for ${cost}` : ''}, and new replies build on it.`
  } else if (handoff.source === 'received') {
    detail = 'This handoff summary was passed in from another app, and you accepted it. It is sent with your messages as background, so you do not have to repeat yourself.'
  } else {
    detail = 'You pasted this handoff summary. It is sent with your messages as background, so you do not have to repeat yourself.'
  }

  return (
    <div className="handoff-card">
      <span className="handoff-icon">
        <Icon name="handoff" size={18} />
      </span>
      <div className="handoff-text">
        <KindTag kind={handoff.source === 'fallback' || handoff.source === 'manual' ? 'inside' : 'outside'} />
        <strong>Continued from {from}</strong>
        <p>{detail}</p>
        <div className="handoff-actions">
          <button onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide the summary' : 'Read the summary'}
          </button>
          {hasOriginal && <button onClick={() => void openConversation(handoff.fromConversationId!)}>Open the original chat</button>}
        </div>
        {open && (
          <div className="handoff-summary">
            <Markdown text={handoff.summary} />
          </div>
        )}
      </div>
    </div>
  )
}

/** At the bottom of a chat that was handed off: points at where it carries on. */
export function ContinuedNote({ target }: { target: { conversationId: string; provider: Provider } }) {
  const openConversation = useApp((s) => s.openConversation)
  const exists = useApp((s) => s.metas.some((m) => m.id === target.conversationId))
  if (!exists) return null
  return (
    <div className="import-note continued-note">
      This chat continues in {MODE_NAME[target.provider]}.{' '}
      <button onClick={() => void openConversation(target.conversationId)}>Open it</button>
    </div>
  )
}

/** Top bar button: hand the open chat to another connected provider. */
export function HandoffMenu() {
  const conversation = useApp((s) => s.conversation)
  const keys = useApp((s) => s.keys)
  const defaults = useApp((s) => s.settings?.defaultModel)
  const handoffTo = useApp((s) => s.handoffTo)
  const openHandoffModal = useApp((s) => s.openHandoffModal)
  const busy = useApp((s) => (s.conversation ? Boolean(s.streaming[s.conversation.id] || s.handoffs[s.conversation.id]) : false))
  if (!conversation || conversation.panel) return null
  const hasHistory = conversation.messages.length > 0 || Boolean(conversation.handoff)
  const others = connectedProviders(keys).filter((provider) => provider !== conversation.provider)
  if (!hasHistory || others.length === 0) return null
  return (
    <Popover
      align="right"
      className="handoff-menu"
      trigger={({ toggle }) => (
        <button className="crumb handoff-button" onClick={toggle} disabled={busy} title="Continue this chat with another provider">
          <Icon name="handoff" size={14} /> Hand off
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Inside Threefold · continue this chat in</div>
          {others.map((provider) => (
            <button
              key={provider}
              className="menu-item model-item"
              onClick={() => {
                void handoffTo(provider)
                close()
              }}
            >
              <span className="model-item-main">
                <strong>{MODE_NAME[provider]}</strong>
                <small>
                  {modelLabel(defaults?.[provider] ?? DEFAULT_MODEL[provider])} writes a summary first, billed by {API_NAME[provider]}
                </small>
              </span>
            </button>
          ))}
          <div className="menu-foot">A new chat opens there. This one stays as it is.</div>
          <div className="menu-label">From outside Threefold</div>
          <button
            className="menu-item model-item"
            onClick={() => {
              openHandoffModal()
              close()
            }}
          >
            <span className="model-item-main">
              <strong>Bring a chat in from another app…</strong>
              <small>From the Claude, ChatGPT or Gemini app, with the {SKILL_NAME} skill</small>
            </span>
          </button>
        </>
      )}
    </Popover>
  )
}

export async function copyPrompt(notify: (text: string, tone?: 'info' | 'error') => void): Promise<void> {
  try {
    await api.app.copyText(HANDOFF_PROMPT)
    notify('Prompt copied. Paste it into the chat you want to bring over.')
  } catch {
    notify('The prompt could not be copied.', 'error')
  }
}

/** The dialog for starting a chat from a summary written in another app. */
export function HandoffModal() {
  const mode = useApp((s) => s.mode)
  const close = useApp((s) => s.closeModal)
  const start = useApp((s) => s.startFromHandoff)
  const notify = useApp((s) => s.notify)
  const openSettings = useApp((s) => s.openSettings)
  const [text, setText] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal handoff-modal" role="dialog" aria-label="Continue a chat from another app">
        <button className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
        <KindTag kind="outside" />
        <h2>Continue a chat from another app</h2>
        <p className="lead">
          In the official Claude, ChatGPT or Gemini app, open the chat you want to bring over and run the{' '}
          <strong>{SKILL_NAME}</strong> skill, or paste the prompt into it. Copy the summary it writes and paste it here.
        </p>
        <textarea
          className="input handoff-input"
          autoFocus
          spellCheck={false}
          placeholder="Paste the handoff summary here"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="handoff-modal-actions">
          <button className="btn ghost" onClick={() => void copyPrompt(notify)}>
            <Icon name="copy" size={15} /> Copy the prompt
          </button>
          <button className="btn ghost" onClick={() => openSettings('skill')}>
            <Icon name="download" size={15} /> Install the skill
          </button>
          <span className="handoff-spacer" />
          <button className="btn primary" disabled={!text.trim()} onClick={() => void start(text)}>
            Continue in {MODE_NAME[mode]}
          </button>
        </div>
        <p className="muted small">
          Nothing is sent until you write a message. The summary then goes to {API_NAME[mode]} with it as background and
          is billed as input tokens, like any other text. To move a chat between Claude, ChatGPT and Gemini here in
          Threefold you need none of this: use <strong>Hand off</strong> at the top of that chat.
        </p>
      </div>
    </div>
  )
}

const ARRIVED: Record<'inbox' | 'clipboard', string> = {
  inbox: 'As a file in Threefold’s inbox folder on this Mac',
  clipboard: 'From your clipboard',
}

/**
 * A handoff arrived from outside the app. It is shown in full, with what is known
 * about where it came from, and nothing happens until the user picks a mode and
 * continues. Closing the dialog keeps the handoff; "Discard" drops it.
 */
export function IncomingHandoffModal() {
  const incoming = useApp((s) => s.incoming)
  const keys = useApp((s) => s.keys)
  const mode = useApp((s) => s.mode)
  const close = useApp((s) => s.closeModal)
  const discard = useApp((s) => s.discardIncoming)
  const start = useApp((s) => s.startFromHandoff)
  const openSettings = useApp((s) => s.openSettings)
  const connected = connectedProviders(keys)
  // The mode of the assistant the chat comes from, when that provider is connected.
  const origin = incoming?.sender ?? incoming?.fromProvider
  const [chosen, setChosen] = useState<Provider | null>(null)
  const provider = chosen ?? (origin && connected.includes(origin) ? origin : connected.includes(mode) ? mode : connected[0])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  if (!incoming || incoming.source === 'none') return null
  const disagree = Boolean(incoming.sender && incoming.fromProvider && incoming.sender !== incoming.fromProvider)

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal handoff-modal incoming-modal" role="dialog" aria-label="A handoff is waiting">
        <button className="icon-btn modal-close" onClick={close} aria-label="Decide later">
          <Icon name="close" size={18} />
        </button>
        <KindTag kind="outside" />
        <h2>A handoff is waiting</h2>
        <p className="lead">
          {incoming.source === 'inbox'
            ? 'A chat was passed to Threefold from another app.'
            : 'Threefold was asked to pick up a handoff and found this one on your clipboard.'}{' '}
          Nothing has been started or sent. Read it, then choose where to continue.
        </p>
        <dl className="incoming-facts">
          <div>
            <dt>Chat</dt>
            <dd>{incoming.title ?? 'No title given'}</dd>
          </div>
          <div>
            <dt>Says it is from</dt>
            <dd>
              {incoming.sender ? MODE_NAME[incoming.sender] : 'Not stated by the sender'}
              {incoming.from ? ` · summary written by ${incoming.from}` : ''}
            </dd>
          </div>
          <div>
            <dt>Arrived</dt>
            <dd>{ARRIVED[incoming.source]}</dd>
          </div>
        </dl>
        {disagree && (
          <p className="incoming-warn" role="note">
            The sender says {MODE_NAME[incoming.sender!]}, but the summary says it was written by {incoming.from}. Read it
            with care before you continue.
          </p>
        )}
        <pre className="incoming-text" tabIndex={0} aria-label="The handoff summary">
          {incoming.summary}
        </pre>
        {connected.length === 0 ? (
          <div className="handoff-modal-actions">
            <span className="muted small">Connect a provider to continue this chat. The handoff is kept meanwhile.</span>
            <span className="handoff-spacer" />
            <button className="btn ghost" onClick={discard}>
              Discard
            </button>
            <button className="btn primary" onClick={() => openSettings('keys')}>
              Add an API key
            </button>
          </div>
        ) : (
          <>
            <label className="field incoming-pick">
              <span>Continue in</span>
              <div className="seg wide">
                {connected.map((option) => (
                  <button key={option} className={provider === option ? 'active' : ''} onClick={() => setChosen(option)}>
                    {MODE_NAME[option]}
                  </button>
                ))}
              </div>
            </label>
            <div className="handoff-modal-actions">
              <button className="btn ghost" onClick={discard}>
                Discard
              </button>
              <span className="handoff-spacer" />
              <button
                className="btn primary"
                disabled={!provider}
                onClick={() => provider && void start(incoming.summary, { provider, received: true })}
              >
                Continue in {provider ? MODE_NAME[provider] : '…'}
              </button>
            </div>
          </>
        )}
        <p className="muted small">
          macOS does not tell Threefold which app sent a handoff, so the sender above is what the handoff itself claims.
          Nothing is sent until you write a message
          {provider ? `; the summary then goes to ${API_NAME[provider]} with it as background and is billed as input tokens` : ''}.
          Close this to decide later: File → Continue from a Handoff brings it back.
        </p>
      </div>
    </div>
  )
}

/** Settings, Credits tab: switch provider automatically when credit runs low. */
export function FallbackSettings() {
  const settings = useApp((s) => s.settings)
  const keys = useApp((s) => s.keys)
  const update = useApp((s) => s.updateSettings)
  if (!settings) return null
  const { fallback } = settings
  const connected = connectedProviders(keys)
  const available = connected.length >= FALLBACK_MIN_PROVIDERS
  const on = fallback.enabled && available
  const set = (patch: Partial<typeof fallback>): void => void update({ fallback: { ...fallback, ...patch } })
  return (
    <div className="credit-fields fallback-settings">
      <h3>Automatic fallback</h3>
      <label className="toggle-row">
        <span>
          <strong>Switch provider when credit runs low</strong>
          <small>
            Once a provider's monthly credit is {fallback.thresholdPct}% used, your next message goes to another connected
            provider. That provider first writes a handoff summary of the chat, so you carry on without repeating yourself.
          </small>
        </span>
        <button
          className={`switch ${on ? 'on' : ''}`}
          role="switch"
          aria-checked={on}
          aria-label="Switch provider when credit runs low"
          disabled={!available}
          onClick={() => set({ enabled: !fallback.enabled })}
        />
      </label>
      {!available && <p className="muted small">Connect at least two providers to use this.</p>}
      {on && (
        <>
          <div className="fallback-options">
            <label className="field">
              <span>Switch when this much is used</span>
              <div className="seg wide">
                {FALLBACK_THRESHOLDS.map((pct) => (
                  <button key={pct} className={fallback.thresholdPct === pct ? 'active' : ''} onClick={() => set({ thresholdPct: pct })}>
                    {pct}%
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span>Switch to</span>
              <div className="seg wide">
                <button className={fallback.prefer === 'auto' ? 'active' : ''} onClick={() => set({ prefer: 'auto' })}>
                  Most credit left
                </button>
                {connected.map((provider) => (
                  <button key={provider} className={fallback.prefer === provider ? 'active' : ''} onClick={() => set({ prefer: provider })}>
                    {MODE_NAME[provider]}
                  </button>
                ))}
              </div>
            </label>
          </div>
          <p className="muted small">
            This is a handoff inside Threefold, between your own providers. (Bringing a chat in from the official
            apps is the other kind: see Settings → Handoff skill.) To write the summary, the conversation so far is sent to the provider you switch to. That is one extra
            request, billed by that provider and shown in the chat with its cost. Only providers that have a monthly credit set above, and credit to spare, are switched to. Reviewed
            chats and the Code tab never switch. A note above the message box tells you before it happens and lets you
            keep that chat where it is.
          </p>
        </>
      )}
    </div>
  )
}

/** Settings, Import tab: bring one chat over with a summary instead of a full export. */
export function HandoffImportBlock() {
  const openHandoffModal = useApp((s) => s.openHandoffModal)
  const openSettings = useApp((s) => s.openSettings)
  const notify = useApp((s) => s.notify)
  return (
    <div className="key-setup">
      <div className="key-setup-head">
        <h3>One chat, with a handoff summary</h3>
        <span className="status ok">No export needed</span>
      </div>
      <ol className="steps">
        <li>
          Add the <strong>{SKILL_NAME}</strong> skill to Claude, ChatGPT or Gemini:{' '}
          <button className="inline-link" onClick={() => openSettings('skill')}>
            install it from here
          </button>
          . Or skip that and copy the prompt with the button below.
        </li>
        <li>
          Open the chat you want to bring over and type <code>/{SKILL_NAME}</code>, or paste the prompt. The assistant
          writes a handoff summary of the whole chat.
        </li>
        <li>
          In a coding tool on this Mac, say yes when it offers to open Threefold: the handoff arrives by itself.
          Anywhere else, copy the summary and click the button below: Threefold takes it from your clipboard.
        </li>
      </ol>
      <div className="key-row">
        <button className="btn primary" onClick={openHandoffModal}>
          <Icon name="handoff" size={16} /> Paste a handoff…
        </button>
        <button className="btn" onClick={() => void copyPrompt(notify)}>
          <Icon name="copy" size={15} /> Copy the prompt
        </button>
      </div>
      <p className="muted small">
        A handoff carries the gist of one chat, not its full text. To bring every old chat in word for word, use the
        exports below.
      </p>
    </div>
  )
}
