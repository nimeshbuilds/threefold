// Settings, "Handoff skill" tab: puts the threefolds skill where each assistant
// can find it, and shows how to run it.
//
// The coding tools on this Mac (Claude Code, Codex, Gemini CLI) load skills from
// a folder, so Threefold can install it for them with one click. The chat apps
// keep skills in the user's account, which Threefold cannot reach: for those it
// saves the ZIP they accept, or copies a message that creates the skill in a chat.

import { useCallback, useEffect, useState } from 'react'
import type { Provider, SkillStatus, SkillTarget } from '@shared/types'
import { SKILL_INSTALL_PROMPT, SKILL_NAME } from '@shared/handoff'
import { MODE_NAME } from '../lib/format'
import { useApp } from '../state'
import { HANDOFF_KIND, copyPrompt } from './Handoff'
import { Icon } from './Icon'

const api = window.threefold

const TOOL: Record<SkillTarget, { name: string; provider: Provider; after: string }> = {
  'claude-code': { name: 'Claude Code', provider: 'claude', after: `Type /${SKILL_NAME} in any Claude Code session.` },
  codex: { name: 'Codex', provider: 'chatgpt', after: `Type $${SKILL_NAME} in any Codex session.` },
  'gemini-cli': { name: 'Gemini CLI', provider: 'gemini', after: `Ask Gemini CLI to "use the ${SKILL_NAME} skill" in any session.` },
}

const STATE_TEXT: Record<SkillStatus['state'], string> = {
  missing: 'Not installed',
  current: 'Installed',
  outdated: 'An older copy is installed',
  linked: 'Linked from another folder; left alone',
  foreign: 'A different skill has this name; left alone',
}

/** Commands worth trying, per provider. The first of each is the plain one. */
const EXAMPLES: Record<Provider, Array<{ run: string; where: string; what: string }>> = {
  claude: [
    { run: `/${SKILL_NAME}`, where: 'Claude Code or the Claude app', what: 'Write a handoff of this whole chat.' },
    {
      run: `/${SKILL_NAME} and open it in Threefold`,
      where: 'Claude Code',
      what: 'Write it and pass it straight to Threefold on this Mac. You are asked before anything is opened.',
    },
    {
      run: `/${SKILL_NAME} Keep the latest draft in full.`,
      where: 'Claude Code or the Claude app',
      what: 'Say what the handoff must not shorten.',
    },
  ],
  chatgpt: [
    { run: `$${SKILL_NAME}`, where: 'Codex', what: 'Write a handoff of this whole session.' },
    {
      run: `$${SKILL_NAME} then pass it to Threefold`,
      where: 'Codex',
      what: 'Write it and save it for Threefold on this Mac, after asking. If Codex’s sandbox will not open the app, the handoff is waiting when you switch to Threefold.',
    },
    { run: `Use the ${SKILL_NAME} skill for this chat.`, where: 'ChatGPT', what: 'Works once the skill is in your workspace.' },
  ],
  gemini: [
    { run: `/${SKILL_NAME}`, where: 'the Gemini app', what: 'Pick the skill from the list that opens when you type the slash.' },
    {
      run: `Use the ${SKILL_NAME} skill and pass this chat to Threefold.`,
      where: 'Gemini CLI',
      what: 'Write the handoff and pass it straight to Threefold on this Mac. You are asked before anything is opened.',
    },
    {
      run: `Use the ${SKILL_NAME} skill. Write the handoff in English.`,
      where: 'Gemini CLI or the Gemini app',
      what: 'Add any instruction about the handoff after the name.',
    },
  ],
}

const APP_SITE: Record<Provider, string> = {
  claude: 'https://claude.ai/',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/',
}

function ToolRow({ status, refresh }: { status: SkillStatus; refresh: () => Promise<void> }) {
  const notify = useApp((s) => s.notify)
  const [busy, setBusy] = useState(false)
  const tool = TOOL[status.target]

  const act = async (action: 'install' | 'remove'): Promise<void> => {
    setBusy(true)
    const result = action === 'install' ? await api.skill.install(status.target) : await api.skill.remove(status.target)
    await refresh()
    setBusy(false)
    if (!result.ok) notify(result.error ?? 'That did not work.', 'error')
    else if (action === 'install') notify(`Installed for ${tool.name}. ${tool.after} Start a new session if it does not show up.`)
    else notify(`Removed from ${tool.name}.`)
  }

  const fixed = status.state === 'linked' || status.state === 'foreign'
  return (
    <div className="skill-row" data-target={status.target}>
      <div className="skill-row-text">
        <strong>{tool.name}</strong>
        <span className={`status ${status.state === 'current' ? 'ok' : ''}`}>
          {status.state === 'missing' && !status.toolFound ? `${tool.name} was not found on this Mac` : STATE_TEXT[status.state]}
        </span>
        <code className="skill-path">{status.path}</code>
      </div>
      <div className="skill-row-actions">
        {status.state === 'missing' && (
          <button className={`btn small ${status.toolFound ? 'primary' : ''}`} disabled={busy} onClick={() => void act('install')}>
            {status.toolFound ? 'Install' : 'Install anyway'}
          </button>
        )}
        {status.state === 'outdated' && (
          <button className="btn small primary" disabled={busy} onClick={() => void act('install')}>
            Update
          </button>
        )}
        {!fixed && status.state !== 'missing' && (
          <button className="btn small ghost" disabled={busy} onClick={() => void act('remove')}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

function Examples({ provider }: { provider: Provider }) {
  const notify = useApp((s) => s.notify)
  const copy = async (text: string): Promise<void> => {
    await api.app.copyText(text)
    notify('Copied.')
  }
  return (
    <ul className="skill-examples" aria-label={`Ways to run the skill in ${MODE_NAME[provider]}`}>
      {EXAMPLES[provider].map((example) => (
        <li key={example.run}>
          <button className="skill-example" onClick={() => void copy(example.run)} title="Copy this">
            <code>{example.run}</code>
            <Icon name="copy" size={13} />
          </button>
          <span>
            In {example.where}. {example.what}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function SkillTab() {
  const notify = useApp((s) => s.notify)
  const [statuses, setStatuses] = useState<SkillStatus[] | null>(null)
  const refresh = useCallback(async (): Promise<void> => setStatuses(await api.skill.status()), [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const statusOf = (target: SkillTarget): SkillStatus | undefined => statuses?.find((status) => status.target === target)
  const copyInstall = async (app: string): Promise<void> => {
    await api.app.copyText(SKILL_INSTALL_PROMPT)
    notify(`Copied. Paste it into a new ${app} chat and send it.`)
  }
  const saveZip = async (): Promise<void> => {
    const saved = await api.skill.saveZip()
    if (saved.ok) notify(`Saved ${saved.file ?? `${SKILL_NAME}.zip`} to your Downloads folder.`)
    else notify(saved.error ?? 'The ZIP could not be saved.', 'error')
  }
  const row = (target: SkillTarget): React.ReactNode => {
    const status = statusOf(target)
    return status ? <ToolRow status={status} refresh={refresh} /> : null
  }
  const site = (provider: Provider, label: string): React.ReactNode => (
    <button className="btn small ghost" onClick={() => void api.app.openExternal(APP_SITE[provider])}>
      <Icon name="external" size={14} /> {label}
    </button>
  )

  return (
    <>
      <h2>Handoff skill</h2>
      <p className="lead">
        <strong>{SKILL_NAME}</strong> is a small skill for Claude, ChatGPT and Gemini: one text file of instructions, with no
        code in it. Run it in any chat and the assistant writes a handoff summary of that chat. In a coding tool on this
        Mac it can then pass the handoff straight into Threefold, and install or update Threefold when you ask.
      </p>

      <div className="handoff-kinds" aria-label="The two kinds of handoff">
        <div className="handoff-kind-card">
          <span className="handoff-kind inside">{HANDOFF_KIND.inside}</span>
          <strong>Between Claude, ChatGPT and Gemini mode</strong>
          <p>
            Click <strong>Hand off</strong> at the top of a chat, or let automatic fallback do it when credit runs low
            (Settings → Credits). The provider you move to writes the summary and bills you for it. No skill is needed.
          </p>
        </div>
        <div className="handoff-kind-card">
          <span className="handoff-kind outside">{HANDOFF_KIND.outside}</span>
          <strong>From the official apps and coding tools, into Threefold</strong>
          <p>
            The assistant you are leaving writes the summary, on that app’s own plan, with the{' '}
            <strong>{SKILL_NAME}</strong> skill. Threefold shows what arrived and asks before it continues. This page
            sets that up.
          </p>
        </div>
      </div>

      <div className="key-setup skill-group" data-provider="claude">
        <div className="key-setup-head">
          <h3>Claude</h3>
        </div>
        {row('claude-code')}
        <div className="skill-row">
          <div className="skill-row-text">
            <strong>Claude app and claude.ai</strong>
            <span className="status">Takes the skill as a ZIP upload</span>
            <span className="muted small">
              Save the ZIP, then in Claude open Customize → Skills, click +, then Create skill, then Upload a skill. Code
              execution and file creation must be on under Settings → Capabilities.
            </span>
          </div>
          <div className="skill-row-actions">
            <button className="btn small" onClick={() => void saveZip()}>
              <Icon name="download" size={14} /> Save the ZIP
            </button>
            {site('claude', 'Open Claude')}
          </div>
        </div>
        <Examples provider="claude" />
      </div>

      <div className="key-setup skill-group" data-provider="chatgpt">
        <div className="key-setup-head">
          <h3>ChatGPT</h3>
        </div>
        {row('codex')}
        <div className="skill-row">
          <div className="skill-row-text">
            <strong>ChatGPT app and chatgpt.com</strong>
            <span className="status">Skills are for Business, Enterprise, Healthcare and Edu workspaces</span>
            <span className="muted small">
              In such a workspace, paste the install message into a chat and ChatGPT creates the skill, or upload the ZIP
              under Plugins → Skills → Create. On a personal plan, paste the handoff prompt into the chat you want to
              move: it does the same job without a skill.
            </span>
          </div>
          <div className="skill-row-actions">
            <button className="btn small" onClick={() => void copyInstall('ChatGPT')}>
              <Icon name="copy" size={14} /> Copy the install message
            </button>
            <button className="btn small ghost" onClick={() => void copyPrompt(notify)}>
              <Icon name="copy" size={14} /> Copy the handoff prompt
            </button>
            {site('chatgpt', 'Open ChatGPT')}
          </div>
        </div>
        <Examples provider="chatgpt" />
      </div>

      <div className="key-setup skill-group" data-provider="gemini">
        <div className="key-setup-head">
          <h3>Gemini</h3>
        </div>
        {row('gemini-cli')}
        <div className="skill-row">
          <div className="skill-row-text">
            <strong>Gemini app and gemini.google.com</strong>
            <span className="status">Creates the skill from a message</span>
            <span className="muted small">
              Paste the install message into a new Gemini chat and send it. Gemini shows the skill for you to review;
              click Create. Skills are for personal Google accounts.
            </span>
          </div>
          <div className="skill-row-actions">
            <button className="btn small" onClick={() => void copyInstall('Gemini')}>
              <Icon name="copy" size={14} /> Copy the install message
            </button>
            {site('gemini', 'Open Gemini')}
          </div>
        </div>
        <Examples provider="gemini" />
      </div>

      <h3>How a handoff reaches Threefold</h3>
      <ul className="skill-how">
        <li>
          <strong>From a coding tool on this Mac.</strong> The skill checks that Threefold is installed and asks you
          first. If you say yes, it saves the handoff as a file in Threefold’s inbox folder and opens Threefold. If
          the tool is not allowed to open another app, the handoff is here when you come back to Threefold.
        </li>
        <li>
          <strong>From a chat app in the browser.</strong> The reply ends with a link. Copy the reply, click the link,
          and Threefold picks the handoff up from your clipboard.
        </li>
        <li>
          <strong>Updating Threefold.</strong> Ask a coding tool that has the skill to “update Threefold”. It tells
          you what it will do and asks first, then fetches the newest release, checks it and swaps it in. It never
          uses sudo, changes a macOS setting or touches your API keys.
        </li>
        <li>
          <strong>Either way, Threefold asks before it does anything.</strong> It shows the whole handoff and who it
          says it is from, picks the matching mode, and waits for you to continue or discard it. A link to Threefold
          never carries any part of a conversation, and nothing reaches a provider until you send a message.
        </li>
      </ul>
    </>
  )
}
