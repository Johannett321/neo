import { useEffect, useState } from 'react'
import type { Decision, OpenQuestion } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { differs, dueLabel, formatDate, todayStr } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { Avatar, ConfirmButton, EmptyState, Field, Modal } from '@/components/primitives'
import { stableKey } from '@/lib/sync'

/**
 * Decisions get their own record because they are the thing you re-litigate most.
 * "We chose this on that date, for this reason, having rejected that" ends an
 * argument in one sentence six months later.
 *
 * Above them sit the questions not settled yet — what the decisions are waiting to
 * be. They come first because they are the part that still needs something from you;
 * the log below is reference. Deciding one happens where it is, in the row, and the
 * decision it becomes keeps the question on it.
 */
export function DecisionsTab({
  projectId,
  decisions,
  openQuestions = []
}: {
  projectId: string
  decisions: Decision[]
  openQuestions?: OpenQuestion[]
}): React.JSX.Element {
  const [editing, setEditing] = useState<Decision | null>(null)
  const [creating, setCreating] = useState(false)
  const [asking, setAsking] = useState<OpenQuestion | 'new' | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const remove = useApiMutation('decision:delete')
  const openMenu = useContextMenu()
  const hasQuestions = openQuestions.length > 0

  return (
    <div className="max-w-3xl">
      <div className="mb-5 flex items-center gap-2">
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}>
          <Icon name="plus" size={13} />
          Log a decision
        </button>
        <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => setAsking('new')}>
          <Icon name="question" size={14} />
          Ask an open question
        </button>
      </div>

      {hasQuestions && (
        <section className="mb-8">
          <GroupHeading title="Open questions" count={openQuestions.length} />
          <ul className="hairline overflow-hidden rounded-box border bg-base-100">
            {openQuestions.map((question) => (
              <QuestionRow
                key={question.id}
                question={question}
                deciding={deciding === question.id}
                onDecide={() => setDeciding(question.id)}
                onDone={() => setDeciding(null)}
                onEdit={() => setAsking(question)}
              />
            ))}
          </ul>
        </section>
      )}

      {hasQuestions && decisions.length > 0 && <GroupHeading title="Decided" count={decisions.length} />}

      {decisions.length === 0 ? (
        !hasQuestions && (
          <EmptyState
            icon="decision"
            title="No decisions logged."
            hint="Record what was decided, why, and what you turned down. Something still undecided? Ask it as an open question, and decide it here when the answer comes."
          />
        )
      ) : (
        <ol className="relative ml-2 border-l border-base-content/10 pl-6">
          {decisions.map((decision) => (
            <li key={stableKey(decision.id)} className="relative mb-5 last:mb-0">
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
                {decision.question && (
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] text-base-content/40">
                    <Icon name="question" size={11} className="shrink-0" />
                    <span className="truncate">{decision.question}</span>
                  </div>
                )}
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

      <QuestionModal
        open={asking !== null}
        onClose={() => setAsking(null)}
        question={asking === 'new' ? null : asking}
        projectId={projectId}
      />
    </div>
  )
}

function GroupHeading({ title, count }: { title: string; count: number }): React.JSX.Element {
  return (
    <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-base-content/45">
      {title}
      <span className="rounded-full bg-base-content/8 px-1.5 py-px text-[10px] font-medium tabular-nums text-base-content/55">
        {count}
      </span>
    </h2>
  )
}

/**
 * One unsettled question. The open ring is the landmark — a decision on the line below
 * is a filled dot, a question is the same dot not filled in yet. Owner and due date sit
 * on the right edge where a task row keeps them; the due date only takes a colour once
 * it is today or late.
 */
function QuestionRow({
  question,
  deciding,
  onDecide,
  onDone,
  onEdit
}: {
  question: OpenQuestion
  deciding: boolean
  onDecide: () => void
  onDone: () => void
  onEdit: () => void
}): React.JSX.Element {
  const remove = useApiMutation('openQuestion:delete')
  const openMenu = useContextMenu()
  const late = question.daysUntilDue !== null && question.daysUntilDue < 0
  const today = question.daysUntilDue === 0

  return (
    <li
      className="hairline border-b last:border-b-0"
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Decide…', icon: 'decision', onSelect: onDecide },
          { label: 'Edit…', icon: 'edit', onSelect: onEdit },
          'separator',
          {
            label: 'Drop question',
            icon: 'trash',
            danger: true,
            onSelect: () => remove.mutate({ id: question.id }),
            confirm: {
              title: 'Drop this question without deciding it?',
              body: question.question,
              confirmLabel: 'Drop'
            }
          }
        ])
      }
    >
      <div className="row-hover group flex items-center gap-3 px-3 py-2.5">
        <span className="size-[14px] shrink-0 rounded-full border-[1.5px] border-dashed border-base-content/35" />
        <button className="flex min-w-0 flex-1 flex-col items-start text-left" onClick={onEdit}>
          <span className="w-full truncate text-[13px] font-medium">{question.question}</span>
          {question.context && (
            <span className="w-full truncate text-[11px] text-base-content/45">
              {question.context.split('\n')[0]}
            </span>
          )}
        </button>
        {question.ownerName && (
          <span className="shrink-0" title={`${question.ownerName} is getting it answered`}>
            <Avatar
              name={question.ownerName}
              color={question.ownerColor ?? '#64748b'}
              image={question.ownerAvatar}
              size={20}
            />
          </span>
        )}
        {question.dueDate && (
          <span
            className={`shrink-0 text-xs tabular-nums ${
              late ? 'font-medium text-error' : today ? 'font-medium text-warning' : 'text-base-content/40'
            }`}
            title={formatDate(question.dueDate)}
          >
            {dueLabel(question.daysUntilDue)}
          </span>
        )}
        {!deciding && (
          <button className="btn btn-ghost btn-xs shrink-0 text-base-content/60" onClick={onDecide}>
            Decide
          </button>
        )}
      </div>
      {deciding && <DecideForm question={question} onDone={onDone} />}
    </li>
  )
}

/**
 * Turning a question into a decision, in the row it was asked in. The question stays
 * on screen as the heading of the form, so the one field to fill — what was decided —
 * reads as its answer. What was known while it was open becomes the reasoning, ready
 * to be edited rather than retyped; the owner, if there was one, is who decided.
 */
function DecideForm({ question, onDone }: { question: OpenQuestion; onDone: () => void }): React.JSX.Element {
  const decide = useApiMutation('openQuestion:decide')
  const [form, setForm] = useState({
    title: '',
    rationale: question.context,
    decidedBy: question.ownerName ?? '',
    decidedOn: todayStr()
  })
  const set = (key: keyof typeof form, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (): Promise<void> => {
    if (!form.title.trim() || decide.isPending) return
    await decide.mutateAsync({ id: question.id, ...form, title: form.title.trim() })
    onDone()
  }
  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onDone()
    }
  }

  return (
    <div className="space-y-3 bg-base-content/[0.025] px-3 pb-3 pl-[42px] pt-1" onKeyDown={keys}>
      <input
        autoFocus
        className="input input-bordered input-sm w-full"
        placeholder="The answer, in one line — what was decided"
        value={form.title}
        onChange={(e) => set('title', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <textarea
        className="textarea textarea-bordered min-h-16 w-full text-[12px] leading-relaxed"
        placeholder="Why — the reasoning, and the constraint that forced it."
        value={form.rationale}
        onChange={(e) => set('rationale', e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <DateField value={form.decidedOn} onChange={(v) => set('decidedOn', v)} allowClear={false} className="w-36" />
        <input
          className="input input-bordered input-sm w-44"
          placeholder="Decided by"
          value={form.decidedBy}
          onChange={(e) => set('decidedBy', e.target.value)}
        />
        <span className="ml-auto text-[10px] text-base-content/35">⌘↵</span>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!form.title.trim() || decide.isPending}
          onClick={() => void submit()}
        >
          Log decision
        </button>
      </div>
    </div>
  )
}

function QuestionModal({
  open,
  onClose,
  question,
  projectId
}: {
  open: boolean
  onClose: () => void
  question: OpenQuestion | null
  projectId: string
}): React.JSX.Element {
  const workspace = useWorkspace()
  // The people on this project, the same set a card can be given to.
  const people = useApi('person:list', { workspaceId: workspace.id, projectId }, { enabled: open })
  const save = useApiMutation('openQuestion:save')
  const remove = useApiMutation('openQuestion:delete')
  const initial = {
    question: question?.question ?? '',
    context: question?.context ?? '',
    ownerPersonId: question?.ownerPersonId ?? '',
    dueDate: question?.dueDate ?? ''
  }
  const [form, setForm] = useState(initial)

  useEffect(() => {
    if (open) setForm(initial)
  }, [open, question]) // `initial` is derived from `question`, and a new object every render

  const set = (key: keyof typeof form, value: string): void => setForm((f) => ({ ...f, [key]: value }))
  const owner = (people.data ?? []).find((p) => p.id === form.ownerPersonId)

  const submit = async (): Promise<void> => {
    if (!form.question.trim()) return
    await save.mutateAsync({
      id: question?.id,
      projectId,
      question: form.question.trim(),
      context: form.context,
      ownerPersonId: form.ownerPersonId || null,
      dueDate: form.dueDate || null
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={question ? 'Open question' : 'Ask an open question'}
      description="Something not settled yet. It waits at the top of Decisions until it is."
      onSubmit={() => void submit()}
      isDirty={differs(form, initial)}
      footer={
        <>
          {question && (
            <ConfirmButton
              label="Drop"
              title="Drop this question without deciding it?"
              body={question.question}
              className="btn btn-ghost btn-sm mr-auto text-base-content/50 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: question.id })
                onClose()
              }}
            />
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!form.question.trim()} onClick={() => void submit()}>
            {question ? 'Save' : 'Ask'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="The question">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Do we launch in Sweden before or after the summer?"
            value={form.question}
            onChange={(e) => set('question', e.target.value)}
          />
        </Field>
        <Field label="What is known so far" hint="The options on the table and what each one costs.">
          <textarea
            className="textarea textarea-bordered min-h-24 w-full text-sm leading-relaxed"
            value={form.context}
            onChange={(e) => set('context', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Getting it answered">
            <div className="flex items-center gap-2">
              {owner && <Avatar name={owner.name} color={owner.avatarColor} image={owner.avatar} size={26} />}
              <select
                className="select select-bordered w-full"
                value={form.ownerPersonId}
                onChange={(e) => set('ownerPersonId', e.target.value)}
              >
                <option value="">Nobody yet</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isMe ? 'Me' : p.name}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Settle by">
            <DateField value={form.dueDate} onChange={(v) => set('dueDate', v)} />
          </Field>
        </div>
      </div>
    </Modal>
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

  const submit = (): void => {
    if (!form.title.trim()) return
    save.mutate({ id: decision?.id, projectId, ...form, title: form.title.trim() })
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
              onConfirm={() => {
                remove.mutate({ id: decision.id })
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
