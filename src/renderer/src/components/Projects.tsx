import { useEffect, useState } from 'react'
import { formatUsd } from '@shared/pricing'
import { MODE_NAME, fileSize, shortDate } from '../lib/format'
import { useApp } from '../state'
import { Icon } from './Icon'

const api = window.twofold

export function ProjectsList() {
  const mode = useApp((s) => s.mode)
  const projects = useApp((s) => s.projects)
  const metas = useApp((s) => s.metas)
  const refresh = useApp((s) => s.refreshProjects)
  const setView = useApp((s) => s.setView)
  const [name, setName] = useState('')
  const mine = projects.filter((p) => p.provider === mode)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const project = await api.projects.create(mode, name.trim())
    setName('')
    await refresh()
    setView({ kind: 'project', id: project.id })
  }

  return (
    <section className="page">
      <header className="topbar">
        <span className="topbar-title muted">Projects</span>
      </header>
      <div className="page-body">
        <h1>Projects</h1>
        <p className="lead">
          A project keeps instructions and reference files together. Every chat started inside it gets them
          automatically. These are your {MODE_NAME[mode]} mode projects.
        </p>
        <div className="key-row">
          <input
            className="input"
            placeholder="New project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
            <Icon name="plus" size={16} /> Create project
          </button>
        </div>
        {mine.length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <div className="project-grid">
            {mine.map((project) => {
              const chats = metas.filter((m) => m.projectId === project.id).length
              return (
                <button key={project.id} className="project-card" onClick={() => setView({ kind: 'project', id: project.id })}>
                  <Icon name="folder" size={20} />
                  <strong>{project.name}</strong>
                  <small>
                    {chats} chat{chats === 1 ? '' : 's'} · {project.files.length} file{project.files.length === 1 ? '' : 's'} ·
                    updated {shortDate(project.updatedAt)}
                  </small>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

export function ProjectView({ id }: { id: string }) {
  const project = useApp((s) => s.projects.find((p) => p.id === id))
  const metas = useApp((s) => s.metas)
  const refresh = useApp((s) => s.refreshProjects)
  const refreshMetas = useApp((s) => s.refreshMetas)
  const setView = useApp((s) => s.setView)
  const newChat = useApp((s) => s.newChat)
  const open = useApp((s) => s.openConversation)
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => setInstructions(project?.instructions ?? ''), [project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <section className="page">
        <header className="topbar" />
        <div className="page-body">
          <p className="muted">This project no longer exists.</p>
        </div>
      </section>
    )
  }
  const chats = metas.filter((m) => m.projectId === project.id)

  return (
    <section className="page">
      <header className="topbar">
        <button className="crumb" onClick={() => setView({ kind: 'projects' })}>
          <Icon name="folder" size={14} /> Projects
        </button>
        <span className="topbar-title muted">{project.name}</span>
      </header>
      <div className="page-body">
        <div className="project-head">
          <input
            className="project-name"
            defaultValue={project.name}
            key={project.id}
            onBlur={async (event) => {
              if (event.target.value.trim() && event.target.value.trim() !== project.name) {
                await api.projects.update(project.id, { name: event.target.value.trim() })
                await refresh()
              }
            }}
          />
          <button className="btn primary" onClick={() => newChat(project.id)}>
            <Icon name="edit" size={16} /> New chat in project
          </button>
        </div>

        <div className="project-columns">
          <div>
            <h3>Instructions</h3>
            <p className="muted small">How the model should behave in this project. Applies to chats started from now on.</p>
            <textarea
              className="input area"
              rows={8}
              placeholder="For example: You are helping me write product documentation. Use a plain, technical tone…"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              onBlur={async () => {
                if (instructions !== project.instructions) {
                  await api.projects.update(project.id, { instructions })
                  await refresh()
                }
              }}
            />

            <h3>Chats</h3>
            {chats.length === 0 ? (
              <p className="muted">No chats in this project yet.</p>
            ) : (
              <div className="project-chats">
                {chats.map((meta) => (
                  <button key={meta.id} className="project-chat" onClick={() => void open(meta.id)}>
                    <span>{meta.title}</span>
                    <small>
                      {shortDate(meta.updatedAt)} · {formatUsd(meta.costUsd)}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3>Files</h3>
            <p className="muted small">
              Sent at the start of every chat in this project, so large files add to the cost of each message (cached
              after the first).
            </p>
            <button
              className="btn"
              onClick={async () => {
                await api.projects.addFiles(project.id)
                await refresh()
              }}
            >
              <Icon name="plus" size={16} /> Add files
            </button>
            <ul className="file-list">
              {project.files.map((file) => (
                <li key={file.id}>
                  <Icon name="file" size={16} />
                  <span>{file.name}</span>
                  <small>{fileSize(file.size)}</small>
                  <button
                    className="icon-btn"
                    title="Remove"
                    onClick={async () => {
                      await api.projects.removeFile(project.id, file.id)
                      await refresh()
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>

            <div className="danger-zone">
              {confirming ? (
                <button
                  className="btn danger"
                  onClick={async () => {
                    await api.projects.remove(project.id)
                    await Promise.all([refresh(), refreshMetas()])
                    setView({ kind: 'projects' })
                  }}
                >
                  Delete the project (its chats are kept)
                </button>
              ) : (
                <button className="btn ghost danger" onClick={() => setConfirming(true)}>
                  <Icon name="trash" size={15} /> Delete project
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
