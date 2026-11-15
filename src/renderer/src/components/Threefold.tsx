// The Threefold tab: one model answers, others review, the first one rewrites.
// These are its controls, its billing notice and the per-step breakdown.

import { useState } from 'react'
import type { ModelRef, PanelStep, Provider } from '@shared/types'
import { findModel, formatUsd, modelLabel } from '@shared/pricing'
import { API_NAME, MODE_NAME } from '../lib/format'
import { activeModel, activeReviewers, connectedProviders, useApp } from '../state'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { Popover } from './Popover'

const MAX_REVIEWERS = 4

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** How many requests each provider gets per message: the answering model twice, each reviewer once. */
export function requestsPerProvider(answering: ModelRef, reviewers: ModelRef[]): Array<{ provider: Provider; count: number }> {
  const counts = new Map<Provider, number>([[answering.provider, reviewers.length > 0 ? 2 : 1]])
  for (const reviewer of reviewers) counts.set(reviewer.provider, (counts.get(reviewer.provider) ?? 0) + 1)
  return [...counts.entries()].map(([provider, count]) => ({ provider, count }))
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Model list grouped by provider, used for both the answering model and the reviewers. */
function GroupedModels({
  providers,
  isSelected,
  isDisabled,
  onPick,
}: {
  providers: Provider[]
  isSelected: (ref: ModelRef) => boolean
  isDisabled: (ref: ModelRef) => string | null
  onPick: (ref: ModelRef) => void
}) {
  const models = useApp((s) => s.models)
  return (
    <div className="grouped-models">
      {providers.map((provider) => (
        <div key={provider}>
          <div className="menu-label">
            {MODE_NAME[provider]} · billed by {API_NAME[provider]}
          </div>
          {models[provider].map((option) => {
            const ref = { provider, model: option.id }
            const info = findModel(option.id)
            const blocked = isDisabled(ref)
            return (
              <button
                key={option.id}
                className={`menu-item model-item ${isSelected(ref) ? 'selected' : ''}`}
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => onPick(ref)}
              >
                <span className="model-item-main">
                  <strong>{option.label}</strong>
                  <small>{blocked ?? option.blurb}</small>
                </span>
                {info && (
                  <span className="model-item-price">
                    ${info.rates.input} in · ${info.rates.output} out
                  </span>
                )}
                {isSelected(ref) && <Icon name="check" size={15} />}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Picks the answering model and the reviewers. */
export function PanelBar() {
  const mode = useApp((s) => s.mode)
  const keys = useApp((s) => s.keys)
  const model = useApp(activeModel)
  const reviewers = useApp(activeReviewers)
  const locked = useApp((s) => Boolean(s.conversation))
  const busy = useApp((s) => (s.conversation ? Boolean(s.streaming[s.conversation.id]) : false))
  const setAnswering = useApp((s) => s.setAnswering)
  const setReviewers = useApp((s) => s.setReviewers)
  const connected = connectedProviders(keys)
  const answering: ModelRef = { provider: mode, model }

  return (
    <div className="panel-bar">
      <span className="panel-bar-label">Answer</span>
      <Popover
        trigger={({ toggle }) => (
          <button className="panel-chip answering" onClick={toggle} disabled={busy} title="The model that drafts and writes the final answer">
            <span className={`mode-dot mode-${mode}`} />
            {modelLabel(model)}
            <Icon name="chevronDown" size={13} />
          </button>
        )}
      >
        {(close) => (
          <GroupedModels
            providers={connected}
            isSelected={(ref) => sameModel(ref, answering)}
            isDisabled={(ref) =>
              locked && ref.provider !== mode ? 'Start a new Threefold chat to answer with another provider' : null
            }
            onPick={(ref) => {
              void setAnswering(ref)
              close()
            }}
          />
        )}
      </Popover>

      <span className="panel-bar-label">Reviewed by</span>
      {reviewers.map((reviewer) => (
        <span key={`${reviewer.provider}:${reviewer.model}`} className="panel-chip">
          <span className={`mode-dot mode-${reviewer.provider}`} />
          {modelLabel(reviewer.model)}
          <button
            aria-label={`Remove ${modelLabel(reviewer.model)}`}
            disabled={busy}
            onClick={() => void setReviewers(reviewers.filter((r) => !sameModel(r, reviewer)))}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      {reviewers.length === 0 && <span className="panel-none">nobody yet</span>}
      <Popover
        trigger={({ toggle }) => (
          <button className="panel-chip add" onClick={toggle} disabled={busy}>
            <Icon name="plus" size={13} /> {reviewers.length === 0 ? 'Add a reviewer' : 'Change'}
          </button>
        )}
      >
        {() => (
          <GroupedModels
            providers={connected}
            isSelected={(ref) => reviewers.some((r) => sameModel(r, ref))}
            isDisabled={(ref) =>
              sameModel(ref, answering)
                ? 'This is the answering model'
                : reviewers.length >= MAX_REVIEWERS && !reviewers.some((r) => sameModel(r, ref))
                  ? `Up to ${MAX_REVIEWERS} reviewers`
                  : null
            }
            onPick={(ref) => {
              const selected = reviewers.some((r) => sameModel(r, ref))
              void setReviewers(selected ? reviewers.filter((r) => !sameModel(r, ref)) : [...reviewers, ref])
            }}
          />
        )}
      </Popover>
    </div>
  )
}

/** Plain statement of who gets billed. Shown every time the tab is opened, until it is acknowledged. */
export function PanelNotice() {
  const mode = useApp((s) => s.mode)
  const model = useApp(activeModel)
  const reviewers = useApp(activeReviewers)
  const read = useApp((s) => s.panelNoticeRead)
  const acknowledge = useApp((s) => s.readPanelNotice)
  if (read) return null
  const billing = requestsPerProvider({ provider: mode, model }, reviewers)
  const requests = billing.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <div className="panel-notice" role="note">
      <div className="panel-notice-icon">
        <Icon name="layers" size={20} />
      </div>
      <div className="panel-notice-body">
        <strong>A quick note on cost before you start</strong>
        <p>
          Every message here is answered in three steps. <b>{modelLabel(model)}</b> writes a draft
          {reviewers.length > 0 ? (
            <>
              , <b>{list(reviewers.map((r) => modelLabel(r.model)))}</b> review{reviewers.length === 1 ? 's' : ''} it, and
              then <b>{modelLabel(model)}</b> writes the final answer.
            </>
          ) : (
            <>. Add at least one reviewer to get the review and the final rewrite.</>
          )}
        </p>
        <p>
          That is {requests} API request{requests === 1 ? '' : 's'} for each message, and{' '}
          <b>every model you pick bills you for its part</b>:{' '}
          {list(billing.map((entry) => `${API_NAME[entry.provider]} for ${entry.count}`))}. Expect a message here to cost a few
          times what a normal chat message does. The total is shown live while it runs, with each step's cost listed
          under the answer.
        </p>
        <button className="btn primary" onClick={acknowledge}>
          Got it
        </button>
      </div>
    </div>
  )
}

/** One-line reminder under the composer. */
export function PanelBilling() {
  const mode = useApp((s) => s.mode)
  const model = useApp(activeModel)
  const reviewers = useApp(activeReviewers)
  const billing = requestsPerProvider({ provider: mode, model }, reviewers)
  return (
    <p className="panel-billing">
      <Icon name="info" size={13} /> Each message is billed by{' '}
      {list(billing.map((entry) => `${API_NAME[entry.provider]} (${entry.count} request${entry.count === 1 ? '' : 's'})`))}.
    </p>
  )
}

const ROLE_LABEL: Record<PanelStep['role'], string> = { draft: 'Draft', critique: 'Review', final: 'Final answer' }

function StepRow({ step, live }: { step: PanelStep; live: boolean }) {
  // A running step shows its text as it arrives; finished steps fold away.
  const [open, setOpen] = useState<boolean | null>(null)
  const running = step.status === 'running'
  const isFinal = step.role === 'final'
  const expanded = !isFinal && (open ?? (live && running))
  const expandable = !isFinal && Boolean(step.text || step.error)
  return (
    <div className={`step step-${step.status}`}>
      <button className="step-head" disabled={!expandable} onClick={() => setOpen(!expanded)}>
        <span className={`mode-dot mode-${step.provider}`} />
        <strong className={running ? 'shimmer' : ''}>{ROLE_LABEL[step.role]}</strong>
        <span className="step-model">{modelLabel(step.model)}</span>
        {step.status === 'error' && <span className="step-flag">failed</span>}
        {step.status === 'skipped' && <span className="step-flag">skipped</span>}
        <span className="topbar-spacer" />
        {step.usage && (
          <span className="step-cost">
            {step.usage.priced ? formatUsd(step.usage.costUsd, { estimated: step.usage.estimated }) : 'cost unknown'}
          </span>
        )}
        {expandable && <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />}
      </button>
      {expanded && (
        <div className="step-body">
          {step.text && <Markdown text={step.text} streaming={running} />}
          {step.error && <div className="msg-error">{step.error}</div>}
        </div>
      )}
    </div>
  )
}

export function PanelSteps({ steps, live = false }: { steps: PanelStep[]; live?: boolean }) {
  if (steps.length === 0) return null
  return (
    <div className="steps-list">
      {steps.map((step) => (
        <StepRow key={step.id} step={step} live={live} />
      ))}
    </div>
  )
}
