import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IMAGE_PROVIDERS, type Attachment, type Effort, type Provider } from '@shared/types'
import { findModel, modelLabel } from '@shared/pricing'
import { MODE_NAME } from '../lib/format'
import { activeModel, useApp } from '../state'
import { Icon } from './Icon'
import { FallbackNotice } from './Handoff'
import { AttachmentChip } from './Message'
import { Popover } from './Popover'

const api = window.threefold

const EFFORTS: Array<{ id: Effort; label: string; hint: string }> = [
  { id: 'default', label: 'Standard', hint: "The model's own default" },
  { id: 'low', label: 'Light', hint: 'Faster and cheaper' },
  { id: 'medium', label: 'Medium', hint: 'Balanced' },
  { id: 'high', label: 'Deep', hint: 'Thinks longer, costs more' },
]

export function ModelPicker() {
  const mode = useApp((s) => s.mode)
  const models = useApp((s) => s.models[s.mode])
  const model = useApp(activeModel)
  const setModel = useApp((s) => s.setModel)
  return (
    <Popover
      className="model-picker"
      align={mode === 'chatgpt' ? 'left' : 'right'}
      side={mode === 'chatgpt' ? 'bottom' : 'top'}
      trigger={({ toggle }) => (
        <button className="model-button" onClick={toggle} title="Choose a model">
          <span>{modelLabel(model)}</span>
          <Icon name="chevronDown" size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">{MODE_NAME[mode]} models · price per 1M tokens</div>
          {models.map((option) => {
            const info = findModel(option.id)
            return (
              <button
                key={option.id}
                className={`menu-item model-item ${option.id === model ? 'selected' : ''}`}
                onClick={() => {
                  void setModel(option.id)
                  close()
                }}
              >
                <span className="model-item-main">
                  <strong>{option.label}</strong>
                  <small>{option.blurb}</small>
                </span>
                {info && (
                  <span className="model-item-price">
                    ${info.rates.input} in · ${info.rates.output} out
                  </span>
                )}
                {option.id === model && <Icon name="check" size={15} />}
              </button>
            )
          })}
        </>
      )}
    </Popover>
  )
}

/** What deep research means on each provider, and what to expect on the bill. */
const RESEARCH_HINT: Record<Provider, string> = {
  claude: 'Searches and reads for minutes, then writes a cited report',
  chatgpt: 'Runs in the background for minutes, then writes a cited report',
  gemini: "Google's Deep Research agent. About $1 to $3 a run",
}

/** Shown above the message box while deep research is switched on. */
const RESEARCH_NOTE: Record<Provider, string> = {
  claude: 'Claude will search and read for several minutes at its highest effort, which uses many more tokens than a normal reply.',
  chatgpt: 'The model will search and read for several minutes at its highest effort, running on OpenAI in the background (OpenAI stores this response).',
  gemini: "Google's Deep Research agent will run for several minutes; Google estimates $1 to $3 a run, and stores the run.",
}

const IMAGE_HINT: Partial<Record<Provider, string>> = {
  chatgpt: 'Billed separately by OpenAI; not in the meter',
  gemini: 'About $0.03 an image, counted in the meter',
}

function ToolsMenu() {
  const mode = useApp((s) => s.mode)
  const tools = useApp((s) => s.conversation?.tools ?? s.draft.tools)
  const effort = useApp((s) => s.conversation?.effort ?? s.draft.effort)
  const research = useApp((s) => s.researchNext)
  const setResearch = useApp((s) => s.setResearchNext)
  const setTools = useApp((s) => s.setTools)
  const setEffort = useApp((s) => s.setEffort)
  const canImage = IMAGE_PROVIDERS.includes(mode)
  const activeCount =
    Number(tools.webSearch) + Number(tools.codeExec) + Number(tools.imageGen && canImage) + Number(research)

  const toggle = (key: 'webSearch' | 'codeExec' | 'imageGen', icon: string, label: string, hint: string) => (
    <button className="menu-item tool-item" onClick={() => void setTools({ [key]: !tools[key] })} role="menuitemcheckbox" aria-checked={tools[key]}>
      <Icon name={icon} size={17} />
      <span className="model-item-main">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <span className={`switch ${tools[key] ? 'on' : ''}`} />
    </button>
  )

  return (
    <Popover
      side="top"
      trigger={({ toggle: open }) => (
        <button className={`icon-btn ${activeCount > 0 ? 'has-active' : ''}`} onClick={open} title="Tools and thinking">
          <Icon name="settings" size={18} />
          {activeCount > 0 && <span className="badge">{activeCount}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div className="menu-label">For the next message</div>
          <button
            className="menu-item tool-item"
            onClick={() => setResearch(!research)}
            role="menuitemcheckbox"
            aria-checked={research}
          >
            <Icon name="search" size={17} />
            <span className="model-item-main">
              <strong>Deep research</strong>
              <small>{RESEARCH_HINT[mode]}</small>
            </span>
            <span className={`switch ${research ? 'on' : ''}`} />
          </button>
          <div className="menu-sep" />
          <div className="menu-label">Tools</div>
          {toggle('webSearch', 'globe', 'Web search', mode === 'gemini' ? 'Google Search; also opens pages and links' : '$0.01 per search, plus tokens')}
          {toggle('codeExec', 'terminal', 'Code execution', 'Runs code in a sandbox; reads data files')}
          {canImage && toggle('imageGen', 'image', 'Image generation', IMAGE_HINT[mode] ?? '')}
          <div className="menu-sep" />
          <div className="menu-label">Thinking</div>
          <div className="effort-row">
            {EFFORTS.map((option) => (
              <button
                key={option.id}
                className={`effort ${effort === option.id ? 'selected' : ''}`}
                title={option.hint}
                onClick={() => void setEffort(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  )
}

const PLACEHOLDER = { claude: 'Write to Claude…', chatgpt: 'Ask anything', gemini: 'Ask Gemini' } as const

export function Composer({ busy, panel = false }: { busy: boolean; panel?: boolean }) {
  const mode = useApp((s) => s.mode)
  const send = useApp((s) => s.send)
  const stop = useApp((s) => s.stop)
  const seed = useApp((s) => s.composerSeed)
  const clearSeed = useApp((s) => s.clearSeed)
  const notify = useApp((s) => s.notify)
  const conversationId = useApp((s) => s.conversation?.id ?? null)
  const tools = useApp((s) => s.conversation?.tools ?? s.draft.tools)
  const research = useApp((s) => s.researchNext)
  const setResearch = useApp((s) => s.setResearchNext)
  // A chat that starts from a handoff and has no messages yet: the first message picks the thread up.
  const resuming = useApp((s) => Boolean(s.conversation?.handoff) && s.conversation?.messages.length === 0)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [truncateFrom, setTruncateFrom] = useState<string | undefined>()
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)

  // "Edit" puts the last message back here.
  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    setAttachments(seed.attachments)
    setTruncateFrom(seed.truncateFrom)
    clearSeed()
    textarea.current?.focus()
  }, [seed, clearSeed])

  // A different chat starts with an empty box.
  useEffect(() => {
    setText('')
    setAttachments([])
    setTruncateFrom(undefined)
    textarea.current?.focus()
  }, [conversationId, mode])

  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`
  }, [text])

  const submit = useCallback(async () => {
    if (busy) return
    const value = text.trim()
    if (!value && attachments.length === 0) return
    const previous = { text, attachments, truncateFrom }
    setText('')
    setAttachments([])
    setTruncateFrom(undefined)
    const ok = await send(value, attachments, truncateFrom)
    if (!ok) {
      setText(previous.text)
      setAttachments(previous.attachments)
      setTruncateFrom(previous.truncateFrom)
    }
  }, [busy, text, attachments, truncateFrom, send])

  const addFiles = useCallback(
    async (files: File[]) => {
      const added: Attachment[] = []
      const paths: string[] = []
      for (const file of files) {
        const path = api.attachments.pathForFile(file)
        if (path) paths.push(path)
        else added.push(await api.attachments.fromData(file.name || 'pasted-image.png', file.type, await file.arrayBuffer()))
      }
      if (paths.length > 0) added.push(...(await api.attachments.fromPaths(paths)))
      if (added.length === 0) return
      setAttachments((current) => [...current, ...added])
      if (added.some((a) => a.kind === 'data') && !tools.codeExec) {
        notify('Turn on Code execution (the sliders button) so the model can open data files.')
      }
    },
    [notify, tools.codeExec],
  )

  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void addFiles([...event.dataTransfer.files])
      }}
    >
      {truncateFrom && (
        <div className="composer-note">
          <Icon name="edit" size={14} /> Editing your last message. Sending replaces it and the reply.
          <button
            onClick={() => {
              setTruncateFrom(undefined)
              setText('')
              setAttachments([])
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {!panel && !truncateFrom && <FallbackNotice />}
      {research && (
        <div className="composer-note research">
          <Icon name="search" size={14} />
          {panel
            ? 'Deep research is on: the draft is a full research run, the reviewers can search the web to check it, and the final rewrite can search too. Expect several minutes and a few dollars across providers.'
            : `Deep research is on for this message. ${RESEARCH_NOTE[mode]} The cost shows live.`}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={() => setAttachments((current) => current.filter((a) => a.id !== attachment.id))}
            />
          ))}
        </div>
      )}
      <textarea
        ref={textarea}
        value={text}
        rows={1}
        placeholder={panel ? 'Ask for a reviewed answer' : resuming ? 'Say what to do next, or just type “continue”' : PLACEHOLDER[mode]}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files]
          if (files.length > 0) {
            event.preventDefault()
            void addFiles(files)
          }
        }}
      />
      <div className="composer-row">
        <button
          className="icon-btn"
          title="Attach files"
          onClick={async () => {
            const picked = await api.attachments.pick()
            if (picked.length > 0) setAttachments((current) => [...current, ...picked])
          }}
        >
          <Icon name={mode === 'chatgpt' ? 'plus' : 'paperclip'} size={18} />
        </button>
        <ToolsMenu />
        {research && (
          <button className="tool-pill research" onClick={() => setResearch(false)} title="Deep research is on for the next message. Click to turn it off.">
            <Icon name="search" size={13} /> Deep research <Icon name="close" size={11} />
          </button>
        )}
        {tools.webSearch && !research && <span className="tool-pill"><Icon name="globe" size={13} /> Search</span>}
        {tools.codeExec && <span className="tool-pill"><Icon name="terminal" size={13} /> Code</span>}
        {tools.imageGen && IMAGE_PROVIDERS.includes(mode) && <span className="tool-pill"><Icon name="image" size={13} /> Images</span>}
        <span className="composer-spacer" />
        {mode !== 'chatgpt' && !panel && <ModelPicker />}
        {busy ? (
          <button className="send-btn stop" onClick={stop} title="Stop">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={() => void submit()}
            disabled={!text.trim() && attachments.length === 0}
            title="Send"
          >
            <Icon name="arrowUp" size={18} />
          </button>
        )}
      </div>
    </div>
  )
}
