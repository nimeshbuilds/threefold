// Updates on screen: the button in the sidebar that appears when a newer
// version has been released, the dialog that installs it, and the lines in
// Settings → About.

import { useEffect } from 'react'
import { megabytes, type UpdateState } from '@shared/update'
import { useApp } from '../state'
import { Icon } from './Icon'

const api = window.threefold

const WORKING: Partial<Record<UpdateState['status'], string>> = {
  downloading: 'Downloading',
  verifying: 'Checking the download',
  installing: 'Restarting',
}

function percent(update: UpdateState): number {
  const progress = update.progress
  return progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0
}

/** Sidebar: shown only while a newer version is on offer or is being installed. */
export function UpdateButton() {
  const update = useApp((s) => s.update)
  const open = useApp((s) => s.openUpdate)
  if (!update?.latest) return null
  const working = WORKING[update.status]
  return (
    <button className={`update-pill ${working ? 'working' : ''}`} onClick={open} title={`Threefold ${update.latest.version} is available. You have ${update.current}.`}>
      <Icon name="update" size={16} />
      <span>
        {working
          ? `${working}${update.status === 'downloading' ? ` ${percent(update)}%` : '…'}`
          : `Update to ${update.latest.version}`}
      </span>
    </button>
  )
}

export function UpdateModal() {
  const update = useApp((s) => s.update)
  const close = useApp((s) => s.closeModal)
  const install = useApp((s) => s.installUpdate)
  const writing = useApp((s) => Object.keys(s.streaming).length > 0 || Object.keys(s.handoffs).length > 0)
  const working = update ? WORKING[update.status] : undefined

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !working) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, working])

  if (!update?.latest) return null
  const { latest } = update
  const done = percent(update)

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !working && close()}>
      <div className="modal handoff-modal update-modal" role="dialog" aria-label="Update Threefold">
        {!working && (
          <button className="icon-btn modal-close" onClick={close} aria-label="Later">
            <Icon name="close" size={18} />
          </button>
        )}
        <h2>Threefold {latest.version} is available</h2>
        <p className="lead">
          You have {update.current}. The update is {megabytes(latest.sizeBytes)}.{' '}
          <button className="inline-link" onClick={() => void api.app.openExternal(latest.notesUrl)}>
            See what is new
          </button>
        </p>

        {update.manual ? (
          <>
            <p className="update-note">{update.manual}</p>
            <div className="handoff-modal-actions">
              <button className="btn ghost" onClick={close}>
                Later
              </button>
              <span className="handoff-spacer" />
              <button className="btn primary" onClick={() => void api.app.openExternal(latest.notesUrl)}>
                <Icon name="external" size={15} /> Open the download page
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="steps update-steps">
              <li>Threefold downloads the new version from its release page on GitHub.</li>
              <li>It checks the download against the checksum published with the release, and that it is Threefold.</li>
              <li>It closes, swaps the new version in and opens again. The old copy goes to the Trash.</li>
            </ol>
            {working && (
              <div className="update-progress" role="status">
                <div className="update-bar">
                  <div className="update-fill" style={{ width: `${update.status === 'downloading' ? done : 100}%` }} />
                </div>
                <span>
                  {working}
                  {update.status === 'downloading' && update.progress
                    ? ` · ${megabytes(update.progress.received)} of ${megabytes(update.progress.total)}`
                    : '…'}
                </span>
              </div>
            )}
            {update.error && !working && (
              <p className="update-note error" role="alert">
                {update.error}
              </p>
            )}
            {!working && (
              <div className="handoff-modal-actions">
                <button className="btn ghost" onClick={close}>
                  Later
                </button>
                <span className="handoff-spacer" />
                <button className="btn primary" disabled={writing} onClick={() => void install()}>
                  <Icon name="update" size={15} /> Update and restart
                </button>
              </div>
            )}
            <p className="muted small">
              {writing ? 'A reply is still being written. Update when it has finished. ' : ''}
              Your chats, settings and API keys are kept: they are stored outside the app. macOS may ask once for your
              login password so that the new version can read your saved keys; choose Always Allow. Like the app itself,
              the update is not signed by Apple.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** Settings → About: the version, whether a newer one exists, and whether to look for one. */
export function UpdateSettings() {
  const update = useApp((s) => s.update)
  const auto = useApp((s) => s.settings?.updates.auto ?? true)
  const saveSettings = useApp((s) => s.updateSettings)
  const check = useApp((s) => s.checkForUpdates)
  const open = useApp((s) => s.openUpdate)
  if (!update) return null
  const checked = update.checkedAt ? new Date(update.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null

  return (
    <div className="credit-fields update-settings">
      <h3>Updates</h3>
      <div className="update-row">
        <span>
          {update.latest ? (
            <strong>Threefold {update.latest.version} is available.</strong>
          ) : update.status === 'checking' ? (
            'Asking GitHub…'
          ) : checked ? (
            <>Threefold {update.current} is the newest version. Checked {checked}.</>
          ) : (
            <>You have Threefold {update.current}.</>
          )}
        </span>
        {update.latest ? (
          <button className="btn small primary" onClick={open}>
            <Icon name="update" size={14} /> Update…
          </button>
        ) : (
          <button className="btn small" disabled={update.status === 'checking'} onClick={() => void check()}>
            Check now
          </button>
        )}
      </div>
      <label className="toggle-row">
        <span>
          <strong>Look for updates automatically</strong>
          <small>
            When Threefold opens, and a few times a day after that, it asks GitHub for the number of the newest
            release. Nothing about you or your chats is sent. An update is only ever installed when you click.
          </small>
        </span>
        <button
          className={`switch ${auto ? 'on' : ''}`}
          role="switch"
          aria-checked={auto}
          aria-label="Look for updates automatically"
          onClick={() => void saveSettings({ updates: { auto: !auto } })}
        />
      </label>
    </div>
  )
}
