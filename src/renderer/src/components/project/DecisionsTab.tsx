import { useEffect, useState } from 'react'
import type { Decision } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { differs, formatDate, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { ConfirmButton, EmptyState, Field, Modal } from '@/components/primitives'

/**
 * Decisions get their own record because they are the thing you re-litigate most.
 * "We chose this on that date, for this reason, having rejected that" ends an
 * argument in one sentence six months later.
 */
export function DecisionsTab({
  projectId,
  decisions
}: {
  projectId: string
  decisions: Decision[]
}): React.JSX.Element {
  const [editing, setEditing] = useState<Decision | null>(null)
  const [creating, setCreating] = useState(false)
  const remove = useApiMutation('decision:delete')
  const openMenu = useContextMenu()

  return (
    <div>
      <button className="btn btn-primary btn-sm mb-4 gap-1.5" onClick={() => setCreating(true)}>
        <Icon name="plus" size={13} />
        Log a decision
      </button>

      {decisions.length === 0 ? (
        <EmptyState
          icon="decision"
          title="No decisions logged."
          hint="Record what was decided, why, and what you turned down. The rejected options are the half everyone forgets."
        />
      ) : (
        <ol className="relative ml-2 border-l border-base-content/10 pl-6">
          {decisions.map((decision) => (
            <li key={decision.id} className="relative mb-5 last:mb-0">
              <span className="absolute -left-[29px] top-2 size-2 rounded-full bg-base-content/25 ring-4 ring-base-100" />
              <button
                className="hairline row-hover w-full rounded-box border bg-base-100 px-4 py-3 text-left"
                onClick={() => setEditing(decision)}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: 'Edit…', icon: 'edit', onSelect: () => setEditing(decision) },
                    'separator',
                    {
                      label: 'Delete decision',
                      icon: 'trash',
                      danger: true,
                      onSelect: () => remove.mutate({ id: decision.id }),
                      confirm: { title: 'Delete this decision?', body: decision.title }
                    }
                  ])
                }
              >
                <div className="flex items-baseline gap-3">
                  <span className="flex-1 text-[13px] font-medium">{decision.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-base-content/40">
                    {formatDate(decision.decidedOn)}
                  </span>
                </div>
                {decision.decidedBy && (
                  <div className="mt-0.5 text-[11px] text-base-content/45">Decided by {decision.decidedBy}</div>
                )}
                {decision.rationale && (
                  <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-base-content/65">
                    {decision.rationale}
                  </p>
                )}
                {decision.alternatives && (
                  <p className="mt-2 text-[11px] leading-relaxed text-base-content/45">
                    <span className="font-medium">Rejected:</span> {decision.alternatives}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      <DecisionModal
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        decision={editing}
        projectId={projectId}
      />
    </div>
  )
}

function DecisionModal({
  open,
  onClose,
  decision,
  projectId
}: {
  open: boolean
  onClose: () => void
  decision: Decision | null
  projectId: string
}): React.JSX.Element {
  const save = useApiMutation('decision:save')
  const remove = useApiMutation('decision:delete')
  const [form, setForm] = useState({ title: '', rationale: '', alternatives: '', decidedBy: '', decidedOn: '' })

  useEffect(() => {
    if (!open) return
    setForm({
      title: decision?.title ?? '',
      rationale: decision?.rationale ?? '',
      alternatives: decision?.alternatives ?? '',
      decidedBy: decision?.decidedBy ?? '',
      decidedOn: decision?.decidedOn ?? todayStr()
    })
  }, [open, decision])

  const set = (key: keyof typeof form, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (): Promise<void> => {
    if (!form.title.trim()) return
    await save.mutateAsync({ id: decision?.id, projectId, ...form, title: form.title.trim() })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={decision ? 'Decision' : 'Log a decision'}
      description="Write it so it settles the question when someone reopens it next quarter."
      width="max-w-2xl"
      isDirty={differs(form, {
        title: decision?.title ?? '',
        rationale: decision?.rationale ?? '',
        alternatives: decision?.alternatives ?? '',
        decidedBy: decision?.decidedBy ?? '',
        decidedOn: decision?.decidedOn ?? todayStr()
      })}
      footer={
        <>
          {decision && (
            <ConfirmButton
              label="Delete"
              className="btn btn-ghost btn-sm mr-auto text-base-content/50 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: decision.id })
                onClose()
              }}
            />
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!form.title.trim()} onClick={() => void submit()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What was decided">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Roll out market by market rather than all at once"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date">
            <DateField value={form.decidedOn} onChange={(v) => set('decidedOn', v)} allowClear={false} />
          </Field>
          <Field label="Decided by">
            <input
              className="input input-bordered w-full"
              placeholder="Me, with the tech lead"
              value={form.decidedBy}
              onChange={(e) => set('decidedBy', e.target.value)}
            />
          </Field>
        </div>
        <Field label="Why">
          <textarea
            className="textarea textarea-bordered min-h-28 w-full text-sm leading-relaxed"
            placeholder="The reasoning, including the constraint that actually forced it."
            value={form.rationale}
            onChange={(e) => set('rationale', e.target.value)}
          />
        </Field>
        <Field label="Alternatives rejected" hint="The half everyone forgets, and the half that gets re-proposed.">
          <textarea
            className="textarea textarea-bordered min-h-20 w-full text-sm leading-relaxed"
            value={form.alternatives}
            onChange={(e) => set('alternatives', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
