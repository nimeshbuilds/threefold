import { useState } from 'react'
import { PROVIDERS, type Provider } from '@shared/types'
import { useApp } from '../state'
import { Icon } from './Icon'
import { Logo } from './Logo'
import { CreditFields, ImportBlock, KeySetup } from './Settings'

const STEPS = ['Welcome', 'Claude', 'ChatGPT', 'Gemini', 'Credits', 'History'] as const
const KEY_STEP: Partial<Record<number, Provider>> = { 1: 'claude', 2: 'chatgpt', 3: 'gemini' }

/** First-run wizard: name, one or both API keys, credit amounts, optional import. */
export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const keys = useApp((s) => s.keys)
  const update = useApp((s) => s.updateSettings)
  const close = useApp((s) => s.closeModal)
  const setMode = useApp((s) => s.setMode)
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings?.displayName ?? '')
  const keyStep = KEY_STEP[step]

  const finish = async (): Promise<void> => {
    await update({ onboarded: true, displayName: name.trim() })
    // Land in a mode that actually has a key.
    const connected = PROVIDERS.find((provider) => keys[provider])
    if (connected && !keys.claude) setMode(connected)
    close()
  }
  const next = (): void => {
    if (step === 0) void update({ displayName: name.trim() })
    if (step === STEPS.length - 1) void finish()
    else setStep(step + 1)
  }

  return (
    <div className="modal-backdrop solid">
      <div className="modal onboarding" role="dialog" aria-label="Set up Threefold">
        <div className="onboarding-steps">
          {STEPS.map((label, index) => (
            <span key={label} className={index === step ? 'current' : index < step ? 'done' : ''}>
              {index < step ? <Icon name="check" size={12} /> : index + 1} {label}
            </span>
          ))}
        </div>

        <div className="onboarding-body">
          {step === 0 && (
            <div className="welcome">
              <Logo size={64} />
              <h1>Welcome to Threefold</h1>
              <p className="lead">
                One app with a Claude mode, a ChatGPT mode and a Gemini mode. It runs on this computer, talks to each
                company's API with your own key, and shows what every message costs while it is being written.
              </p>
              <ul className="points">
                <li>
                  <Icon name="bolt" size={16} /> Put the monthly API credits from your Claude, ChatGPT or Google AI plan to
                  use.
                </li>
                <li>
                  <Icon name="chart" size={16} /> See the cost of each reply live, and what is left for the month.
                </li>
                <li>
                  <Icon name="layers" size={16} /> Connect two or more and one model can answer while the others review it.
                </li>
                <li>
                  <Icon name="key" size={16} /> Keys and chats stay on your Mac. There is no Threefold account or server.
                </li>
              </ul>
              <label className="field">
                <span>What should the app call you?</span>
                <input className="input" autoFocus placeholder="Your first name (optional)" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            </div>
          )}
          {step === 1 && (
            <>
              <h2>Connect Claude mode</h2>
              <p className="lead">About two minutes. You can skip this and add it later in Settings.</p>
              <KeySetup provider="claude" />
            </>
          )}
          {step === 2 && (
            <>
              <h2>Connect ChatGPT mode</h2>
              <p className="lead">Same three steps on the OpenAI side. Skip it if you do not use ChatGPT.</p>
              <KeySetup provider="chatgpt" />
            </>
          )}
          {step === 3 && (
            <>
              <h2>Connect Gemini mode</h2>
              <p className="lead">And once more on the Google side. Skip it if you do not use Gemini.</p>
              <KeySetup provider="gemini" />
            </>
          )}
          {step === 4 && (
            <>
              <h2>Your monthly credits</h2>
              <p className="lead">
                Pick the amount your plan grants and the day it renews (the day your subscription bills). The sidebar
                meter counts down from this.
              </p>
              <CreditFields provider="claude" />
              <CreditFields provider="chatgpt" />
              <CreditFields provider="gemini" />
            </>
          )}
          {step === 5 && (
            <>
              <h2>Bring your history (optional)</h2>
              <p className="lead">You can also do this any time from Settings → Import history.</p>
              <ImportBlock provider="claude" />
              <ImportBlock provider="chatgpt" />
              <ImportBlock provider="gemini" />
            </>
          )}
        </div>

        <div className="onboarding-foot">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          <span className="muted small">
            {keyStep && !keys[keyStep] && 'No key yet'}
          </span>
          <button className="btn primary" onClick={next}>
            {step === STEPS.length - 1
              ? 'Start using Threefold'
              : keyStep && !keys[keyStep]
                ? 'Skip for now'
                : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
