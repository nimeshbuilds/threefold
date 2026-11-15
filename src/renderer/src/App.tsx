import { useEffect } from 'react'
import { handleChatEvent, useApp } from './state'
import { ArtifactPanel } from './components/ArtifactPanel'
import { ChatView } from './components/ChatView'
import { CodeView } from './components/CodeView'
import { HandoffModal } from './components/Handoff'
import { Onboarding } from './components/Onboarding'
import { ProjectView, ProjectsList } from './components/Projects'
import { SettingsModal } from './components/Settings'
import { Sidebar } from './components/Sidebar'

const api = window.threefold

function useTheme(): void {
  const mode = useApp((s) => s.mode)
  const theme = useApp((s) => s.settings?.theme ?? 'system')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.documentElement.dataset.mode = mode
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode, theme])
}

export function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const modal = useApp((s) => s.modal)
  const toast = useApp((s) => s.toast)
  const hasArtifact = useApp((s) => s.artifact !== null)
  useTheme()

  useEffect(() => {
    const store = useApp.getState()
    void store.init()
    const offChat = api.chat.onEvent(handleChatEvent)
    const offUsage = api.usage.onUpdate((spend) => useApp.setState({ spend }))
    const offMenu = api.onMenu((command) => {
      const state = useApp.getState()
      if (command === 'new-chat') state.newChat()
      else if (command === 'settings') state.openSettings()
      else if (command === 'mode-claude') state.setMode('claude')
      else if (command === 'mode-chatgpt') state.setMode('chatgpt')
      else if (command === 'mode-gemini') state.setMode('gemini')
      else if (command === 'threefold') state.openThreefold()
      else if (command === 'paste-handoff') state.openHandoffModal()
    })
    return () => {
      offChat()
      offUsage()
      offMenu()
    }
  }, [])

  if (!ready) return <div className="boot" />

  return (
    <div className={`app ${hasArtifact ? 'with-artifact' : ''}`}>
      <Sidebar />
      <main className="main">
        {(view.kind === 'chat' || view.kind === 'threefold') && <ChatView />}
        {view.kind === 'projects' && <ProjectsList />}
        {view.kind === 'project' && <ProjectView id={view.id} />}
        {view.kind === 'code' && <CodeView />}
      </main>
      <ArtifactPanel />
      {modal === 'settings' && <SettingsModal />}
      {modal === 'onboarding' && <Onboarding />}
      {modal === 'handoff' && <HandoffModal />}
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
