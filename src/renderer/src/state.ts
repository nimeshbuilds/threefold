// One store for the whole window. The main process owns the data; this is the
// window's working copy plus what is streaming right now.

import { create } from 'zustand'
import type {
  Attachment,
  ChatEvent,
  ChatTools,
  Conversation,
  ConversationMeta,
  Effort,
  KeyStatus,
  ModelOption,
  Project,
  Provider,
  Settings,
  SpendSummary,
  ToolEvent,
  Usage,
} from '@shared/types'
import type { Artifact } from '@shared/artifacts'
import { DEFAULT_MODEL } from '@shared/pricing'

const api = window.twofold

export interface Streaming {
  messageId: string
  model: string
  text: string
  thinking: string
  events: ToolEvent[]
  usage: Usage | null
}

export type View = { kind: 'chat' } | { kind: 'projects' } | { kind: 'project'; id: string } | { kind: 'code' }
export type SettingsTab = 'general' | 'keys' | 'credits' | 'usage' | 'memory' | 'import' | 'about'

export interface Draft {
  projectId?: string
  tools: ChatTools
  effort: Effort
}

const emptyDraft = (): Draft => ({
  tools: { webSearch: false, codeExec: false, imageGen: false },
  effort: 'default',
})

interface State {
  ready: boolean
  settings: Settings | null
  keys: KeyStatus
  mode: Provider
  view: View
  metas: ConversationMeta[]
  conversation: Conversation | null
  streaming: Record<string, Streaming>
  draft: Draft
  projects: Project[]
  spend: Record<Provider, SpendSummary> | null
  models: Record<Provider, ModelOption[]>
  artifact: Artifact | null
  modal: 'settings' | 'onboarding' | null
  settingsTab: SettingsTab
  toast: { text: string; tone: 'info' | 'error' } | null
  /** Text to put back in the composer (after "Edit"). */
  composerSeed: { text: string; attachments: Attachment[]; truncateFrom: string } | null

  init(): Promise<void>
  setMode(mode: Provider): void
  setView(view: View): void
  newChat(projectId?: string): void
  openConversation(id: string): Promise<void>
  send(text: string, attachments: Attachment[], truncateFrom?: string): Promise<boolean>
  stop(): void
  regenerate(): void
  editLast(): void
  setModel(model: string): Promise<void>
  setTools(patch: Partial<ChatTools>): Promise<void>
  setEffort(effort: Effort): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  togglePin(id: string): Promise<void>
  removeConversation(id: string): Promise<void>
  refreshMetas(): Promise<void>
  refreshProjects(): Promise<void>
  refreshKeys(): Promise<void>
  refreshModels(): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  openArtifact(artifact: Artifact | null): void
  openSettings(tab?: SettingsTab): void
  closeModal(): void
  notify(text: string, tone?: 'info' | 'error'): void
  clearSeed(): void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useApp = create<State>((set, get) => ({
  ready: false,
  settings: null,
  keys: { claude: false, chatgpt: false },
  mode: 'claude',
  view: { kind: 'chat' },
  metas: [],
  conversation: null,
  streaming: {},
  draft: emptyDraft(),
  projects: [],
  spend: null,
  models: { claude: [], chatgpt: [] },
  artifact: null,
  modal: null,
  settingsTab: 'general',
  toast: null,
  composerSeed: null,

  async init() {
    const [settings, keys, metas, projects, spend, claudeModels, gptModels] = await Promise.all([
      api.settings.get(),
      api.keys.status(),
      api.conversations.list(),
      api.projects.list(),
      api.usage.summary(),
      api.models.list('claude'),
      api.models.list('chatgpt'),
    ])
    set({
      ready: true,
      settings,
      keys,
      metas,
      projects,
      spend,
      mode: settings.lastProvider,
      models: { claude: claudeModels, chatgpt: gptModels },
      modal: settings.onboarded ? null : 'onboarding',
    })
  },

  setMode(mode) {
    if (get().mode === mode) return
    set({ mode, conversation: null, view: { kind: 'chat' }, artifact: null, draft: emptyDraft(), composerSeed: null })
    void api.settings.update({ lastProvider: mode })
  },

  setView(view) {
    set({ view, artifact: null })
  },

  newChat(projectId) {
    set({
      conversation: null,
      view: { kind: 'chat' },
      artifact: null,
      draft: { ...emptyDraft(), projectId },
      composerSeed: null,
    })
  },

  async openConversation(id) {
    const conversation = await api.conversations.get(id)
    if (!conversation) {
      get().notify('That chat could not be opened.', 'error')
      await get().refreshMetas()
      return
    }
    set({
      conversation,
      mode: conversation.provider,
      view: { kind: 'chat' },
      artifact: null,
      composerSeed: null,
    })
  },

  async send(text, attachments, truncateFrom) {
    const state = get()
    let conversation = state.conversation
    if (!state.keys[state.mode]) {
      state.openSettings('keys')
      state.notify(`Add your ${state.mode === 'claude' ? 'Anthropic' : 'OpenAI'} API key to start chatting.`)
      return false
    }
    if (!conversation) {
      // The chat is created on the first message, so abandoned drafts leave nothing behind.
      const model = state.settings?.defaultModel[state.mode] ?? DEFAULT_MODEL[state.mode]
      conversation = await api.conversations.create({
        provider: state.mode,
        projectId: state.draft.projectId,
        model,
      })
      await api.conversations.update(conversation.id, { tools: state.draft.tools, effort: state.draft.effort })
      conversation = { ...conversation, tools: state.draft.tools, effort: state.draft.effort }
      set({ conversation })
    } else if (truncateFrom) {
      const index = conversation.messages.findIndex((m) => m.id === truncateFrom)
      if (index !== -1) {
        conversation = { ...conversation, messages: conversation.messages.slice(0, index) }
        set({ conversation })
      }
    }
    const result = await api.chat.send({ conversationId: conversation.id, text, attachments, truncateFrom })
    if (!result.ok) {
      get().notify(result.error ?? 'The message could not be sent.', 'error')
      return false
    }
    return true
  },

  stop() {
    const id = get().conversation?.id
    if (id) void api.chat.stop(id)
  },

  regenerate() {
    const conversation = get().conversation
    if (!conversation) return
    const lastUser = [...conversation.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    void get().send(lastUser.text, lastUser.attachments ?? [], lastUser.id)
  },

  editLast() {
    const conversation = get().conversation
    const lastUser = conversation ? [...conversation.messages].reverse().find((m) => m.role === 'user') : undefined
    if (!lastUser) return
    set({
      composerSeed: { text: lastUser.text, attachments: lastUser.attachments ?? [], truncateFrom: lastUser.id },
    })
  },

  async setModel(model) {
    const { conversation, mode, settings } = get()
    if (conversation) {
      await api.conversations.update(conversation.id, { model })
      set({ conversation: { ...conversation, model } })
    }
    if (settings) {
      const next = { ...settings, defaultModel: { ...settings.defaultModel, [mode]: model } }
      set({ settings: next })
      if (!conversation) await api.settings.update({ defaultModel: next.defaultModel })
    }
    await get().refreshMetas()
  },

  async setTools(patch) {
    const { conversation, draft } = get()
    if (conversation) {
      const tools = { ...conversation.tools, ...patch }
      set({ conversation: { ...conversation, tools } })
      await api.conversations.update(conversation.id, { tools })
    } else {
      set({ draft: { ...draft, tools: { ...draft.tools, ...patch } } })
    }
  },

  async setEffort(effort) {
    const { conversation, draft } = get()
    if (conversation) {
      set({ conversation: { ...conversation, effort } })
      await api.conversations.update(conversation.id, { effort })
    } else {
      set({ draft: { ...draft, effort } })
    }
  },

  async renameConversation(id, title) {
    await api.conversations.update(id, { title })
    const { conversation } = get()
    if (conversation?.id === id) set({ conversation: { ...conversation, title } })
    await get().refreshMetas()
  },

  async togglePin(id) {
    const meta = get().metas.find((m) => m.id === id)
    await api.conversations.update(id, { pinned: !meta?.pinned })
    await get().refreshMetas()
  },

  async removeConversation(id) {
    await api.conversations.remove(id)
    if (get().conversation?.id === id) set({ conversation: null, artifact: null })
    await get().refreshMetas()
  },

  async refreshMetas() {
    set({ metas: await api.conversations.list() })
  },

  async refreshProjects() {
    set({ projects: await api.projects.list() })
  },

  async refreshKeys() {
    set({ keys: await api.keys.status() })
  },

  async refreshModels() {
    const [claude, chatgpt] = await Promise.all([api.models.list('claude'), api.models.list('chatgpt')])
    set({ models: { claude, chatgpt } })
  },

  async updateSettings(patch) {
    const settings = await api.settings.update(patch)
    set({ settings })
    if (patch.credits) set({ spend: await api.usage.summary() })
  },

  openArtifact(artifact) {
    set({ artifact })
  },

  openSettings(tab) {
    set({ modal: 'settings', settingsTab: tab ?? get().settingsTab })
  },

  closeModal() {
    set({ modal: null })
  },

  notify(text, tone = 'info') {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { text, tone } })
    toastTimer = setTimeout(() => set({ toast: null }), tone === 'error' ? 7000 : 3500)
  },

  clearSeed() {
    set({ composerSeed: null })
  },
}))

// ---------- events from the main process ----------

// Text arrives many times a second; collect it and update the screen once per frame.
const pendingText = new Map<string, { text: string; thinking: string }>()
let frame = 0

function flushText(): void {
  frame = 0
  if (pendingText.size === 0) return
  useApp.setState((state) => {
    const streaming = { ...state.streaming }
    for (const [id, delta] of pendingText) {
      const current = streaming[id]
      if (current) {
        streaming[id] = { ...current, text: current.text + delta.text, thinking: current.thinking + delta.thinking }
      }
    }
    pendingText.clear()
    return { streaming }
  })
}

function queueText(conversationId: string, kind: 'text' | 'thinking', delta: string): void {
  const entry = pendingText.get(conversationId) ?? { text: '', thinking: '' }
  entry[kind] += delta
  pendingText.set(conversationId, entry)
  if (!frame) frame = requestAnimationFrame(flushText)
}

function patchStreaming(conversationId: string, patch: (current: Streaming) => Streaming): void {
  useApp.setState((state) => {
    const current = state.streaming[conversationId]
    if (!current) return state
    return { streaming: { ...state.streaming, [conversationId]: patch(current) } }
  })
}

function upsertMeta(metas: ConversationMeta[], meta: ConversationMeta): ConversationMeta[] {
  const rest = metas.filter((m) => m.id !== meta.id)
  return [meta, ...rest].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function handleChatEvent(event: ChatEvent): void {
  switch (event.type) {
    case 'user':
      useApp.setState((state) => {
        if (state.conversation?.id !== event.conversationId) return state
        return { conversation: { ...state.conversation, messages: [...state.conversation.messages, event.message] } }
      })
      break
    case 'start':
      useApp.setState((state) => ({
        streaming: {
          ...state.streaming,
          [event.conversationId]: {
            messageId: event.messageId,
            model: event.model,
            text: '',
            thinking: '',
            events: [],
            usage: null,
          },
        },
      }))
      break
    case 'text':
      queueText(event.conversationId, 'text', event.delta)
      break
    case 'thinking':
      queueText(event.conversationId, 'thinking', event.delta)
      break
    case 'event':
      patchStreaming(event.conversationId, (current) => {
        const index = current.events.findIndex((e) => e.id === event.event.id)
        const events = [...current.events]
        if (index === -1) events.push(event.event)
        else events[index] = event.event
        return { ...current, events }
      })
      break
    case 'usage':
      patchStreaming(event.conversationId, (current) => ({ ...current, usage: event.usage }))
      break
    case 'done':
      pendingText.delete(event.conversationId)
      useApp.setState((state) => {
        const streaming = { ...state.streaming }
        delete streaming[event.conversationId]
        const metas = upsertMeta(state.metas, event.meta)
        if (state.conversation?.id !== event.conversationId) return { streaming, metas }
        const messages = state.conversation.messages.filter((m) => m.id !== event.message.id)
        return {
          streaming,
          metas,
          conversation: {
            ...state.conversation,
            title: event.meta.title,
            costUsd: event.meta.costUsd,
            updatedAt: event.meta.updatedAt,
            messages: [...messages, event.message],
          },
        }
      })
      break
    case 'meta':
      useApp.setState((state) => ({
        metas: upsertMeta(state.metas, event.meta),
        conversation:
          state.conversation?.id === event.conversationId
            ? { ...state.conversation, title: event.meta.title, costUsd: event.meta.costUsd }
            : state.conversation,
      }))
      break
    case 'error':
      useApp.getState().notify(event.error, 'error')
      break
  }
}

export function activeModel(state: Pick<State, 'conversation' | 'settings' | 'mode'>): string {
  return state.conversation?.model ?? state.settings?.defaultModel[state.mode] ?? DEFAULT_MODEL[state.mode]
}
