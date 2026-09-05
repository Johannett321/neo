import { useEffect, useMemo, useState } from 'react'
import type { ProjectSummary } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { differs, projectColor, todayStr } from '@/lib/format'
import { useToast } from '@/lib/toast'
import { useWorkspace } from '@/lib/workspace'
import { Icon, type IconName } from './Icon'
import { Avatar, Field, Modal } from './primitives'
import { DateField } from './DateField'
import { Mark } from './Mark'

type Kind = 'task' | 'decision' | 'journal' | 'meeting'

const KINDS: { kind: Kind; label: string; icon: IconName; hint: string }[] = [
  { kind: 'task', label: 'Task', icon: 'check', hint: 'Something that needs doing.' },
  { kind: 'decision', label: 'Decision', icon: 'decision', hint: 'Something that was settled, and why.' },
  { kind: 'journal', label: 'Log entry', icon: 'journal', hint: 'What happened, dated.' },
  { kind: 'meeting', label: 'Meeting', icon: 'people', hint: 'A meeting to record. Details can come later.' }
]

interface Draft {
  title: string
  note: string
  assigneePersonId: string
  dueDate: string
  date: string
}

const blank = (): Draft => ({
  title: '',
  note: '',
  assigneePersonId: '',
  dueDate: '',
  date: todayStr()
})

/**
 * One dialog for the four things worth capturing in a hurry. The project comes first
 * and is deliberately not shaped like the fields under it — it is the question you
 * answer before any of them, and inside a project it is already answered, so it is
 * not asked at all.
 */
export function CreateDialog({
  open,
  onClose,
  projectId,
  columnId,
  only
}: {
  open: boolean
  onClose: () => void
  /** Set when opened from inside a project: the chooser disappears entirely. */
  projectId?: string
  /** Which board column a new task lands in. Without one it goes to the first. */
  columnId?: string
  /** Lock the dialog to one kind, for entry points where it cannot be anything else. */
  only?: Kind
}): React.JSX.Element {
  const workspace = useWorkspace()
  const projects = useApi('project:list', { workspaceId: workspace.id }, { enabled: open })
  const people = useApi('person:list', { workspaceId: workspace.id }, { enabled: open })

  const saveTask = useApiMutation('task:save')
  const saveDecision = useApiMutation('decision:save')
  const saveJournal = useApiMutation('journal:save')
  const saveMeeting = useApiMutation('meeting:save')

  const toast = useToast()
  const [kind, setKind] = useState<Kind>('task')
  const [chosen, setChosen] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(blank())
  // Whether the project on show was chosen or merely offered — it changes what the
  // row is allowed to say about itself, and nothing else.
  const [picked, setPicked] = useState(false)

  const me = useMemo(() => (people.data ?? []).find((p) => p.isMe), [people.data])

  useEffect(() => {
    if (!open) return
    setKind(only ?? 'task')
    setDraft(blank())
    setPickerOpen(false)
    setChosen(projectId ?? '')
    setPicked(false)
  }, [open, projectId, only])

  /**
   * The project you had open last, offered as the answer rather than asked for.
   *
   * An empty chooser makes the first thing in the dialog a decision, and a decision
   * before you have typed the thing you opened it to type. Nine times in ten this is
   * already the right project — you pressed ⌘N seconds after closing it — so it
   * arrives filled in, says where it came from, and is one click from any other.
   */
  const suggested = useMemo(() => {
    const opened = (projects.data ?? []).filter((p) => p.lastOpenedAt)
    if (opened.length > 0) {
      const [first] = [...opened].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
      return first ? { id: first.id, why: 'Last opened' } : null
    }
    // Nothing has been opened yet, so the list's own order — pinned, then whatever
    // moved most recently — is the best guess available, and says so.
    const first = projects.data?.[0]
    return first ? { id: first.id, why: 'Most recent' } : null
  }, [projects.data])

  useEffect(() => {
    if (!open || projectId || chosen || picked || !suggested) return
    setChosen(suggested.id)
  }, [open, projectId, chosen, picked, suggested])

  const targetProject = projectId ?? chosen
  const project: ProjectSummary | undefined = (projects.data ?? []).find((p) => p.id === targetProject)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  // A meeting needs nothing but its date; everything else needs something written down.
  const canSave = Boolean(targetProject) && (kind === 'meeting' || draft.title.trim() || draft.note.trim())

  const submit = async (): Promise<void> => {
    if (!canSave) return
    const where = project?.name ?? 'the project'
    if (kind === 'task') {
      const assignedElsewhere = Boolean(draft.assigneePersonId) && draft.assigneePersonId !== me?.id
      await saveTask.mutateAsync({
        projectId: targetProject,
        title: draft.title.trim(),
        details: draft.note,
        // Work you handed to someone else is tracked differently from your own.
        kind: assignedElsewhere ? 'delegated' : 'task',
        assigneePersonId: draft.assigneePersonId || null,
        dueDate: draft.dueDate || null,
        ...(columnId ? { columnId } : {})
      })
      toast({
        title: `Task added to ${where}`,
        detail: draft.title.trim(),
        icon: 'check',
        to: `/projects/${targetProject}/kanban`
      })
    } else if (kind === 'decision') {
      await saveDecision.mutateAsync({
        projectId: targetProject,
        title: draft.title.trim(),
        rationale: draft.note,
        decidedOn: draft.date
      })
      toast({
        title: `Decision logged in ${where}`,
        detail: draft.title.trim(),
        icon: 'decision',
        to: `/projects/${targetProject}/decisions`
      })
    } else if (kind === 'journal') {
      await saveJournal.mutateAsync({
        projectId: targetProject,
        body: draft.note.trim() || draft.title.trim(),
        occurredOn: draft.date
      })
      toast({
        title: `Log entry added to ${where}`,
        detail: (draft.note.trim() || draft.title.trim()).slice(0, 60),
        icon: 'journal',
        to: `/projects/${targetProject}`
      })
    } else {
      const created = await saveMeeting.mutateAsync({
        projectId: targetProject,
        title: draft.title.trim(),
        occurredOn: draft.date
      })
      // Straight to the page it will be written up on, which is the next thing to do.
      toast({
        title: `Meeting added to ${where}`,
        detail: draft.title.trim() || 'Untitled — add the notes when you have them',
        icon: 'people',
        to: `/projects/${targetProject}/meetings/${created.id}`
      })
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={only ? `New ${KINDS.find((k) => k.kind === only)?.label.toLowerCase()}` : 'New'}
      onSubmit={() => void submit()}
      isDirty={differs(draft, blank())}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!canSave} onClick={() => void submit()}>
            Add
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Which project — asked first, and only when it is still an open question. */}
        {!projectId && (
          <div className="relative">
            <button
              type="button"
              className={`flex w-full items-center gap-3 rounded-box border px-3 py-2.5 text-left transition ${
                project
                  ? 'hairline bg-base-200/50 hover:bg-base-200'
                  : 'border-primary/40 bg-primary/[0.04] hover:bg-primary/[0.07]'
              }`}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {project ? (
                <Mark
                  name={project.name}
                  color={projectColor(project)}
                  icon={project.icon}
                  size={30}
                  rounded="rounded-[8px]"
                />
              ) : (
                <span className="flex size-[30px] items-center justify-center rounded-[8px] bg-primary/10 text-primary">
                  <Icon name="projects" size={15} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.09em] text-base-content/40">
                  Project
                </span>
                <span className={`block truncate text-[14px] ${project ? 'font-medium' : 'text-primary'}`}>
                  {project?.name ?? 'Choose a project'}
                </span>
              </span>
              {/* A default you cannot see the reason for is a default you distrust. */}
              {project && !picked && suggested?.id === project.id && (
                <span className="shrink-0 text-[11px] text-base-content/35">{suggested.why}</span>
              )}
              <Icon name={pickerOpen ? 'chevronUp' : 'chevronDown'} size={14} className="text-base-content/35" />
            </button>

            {pickerOpen && (
              <div className="rise hairline scroll-area absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-box border bg-base-100 py-1 shadow-xl shadow-black/10">
                {(projects.data ?? []).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-base-200"
                    onClick={() => {
                      setChosen(option.id)
                      setPicked(true)
                      setPickerOpen(false)
                    }}
                  >
                    <Mark
                      name={option.name}
                      color={projectColor(option)}
                      icon={option.icon}
                      size={20}
                      rounded="rounded-[6px]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{option.name}</span>
                    {option.id === targetProject && <Icon name="check" size={13} className="text-primary" />}
                  </button>
                ))}
                {(projects.data ?? []).length === 0 && (
                  <p className="px-3 py-3 text-[12px] text-base-content/45">
                    No active projects in {workspace.name} yet.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* What kind of thing — skipped where there is only one answer. */}
        {!only && (
          <>
        <div className="grid grid-cols-4 gap-1.5">
          {KINDS.map((option) => (
            <button
              key={option.kind}
              type="button"
              className={`flex flex-col items-center gap-1 rounded-field border px-2 py-2.5 text-[11px] transition ${
                kind === option.kind
                  ? 'border-primary/45 bg-primary/[0.07] font-medium text-primary'
                  : 'hairline text-base-content/60 hover:bg-base-200/60'
              }`}
              onClick={() => setKind(option.kind)}
            >
              <Icon name={option.icon} size={15} />
              {option.label}
            </button>
          ))}
        </div>
        <p className="-mt-3 text-[11px] text-base-content/40">
          {KINDS.find((k) => k.kind === kind)?.hint}
        </p>
          </>
        )}

        {kind === 'task' && (
          <>
            <Field label="What needs doing">
              <input
                autoFocus
                className="input input-bordered w-full"
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field label="Note" hint="Anything you will want when you come back to this.">
              <textarea
                className="textarea textarea-bordered min-h-20 w-full text-sm"
                value={draft.note}
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Assigned to">
                <div className="flex items-center gap-2">
                  {draft.assigneePersonId && (
                    <Avatar
                      name={
                        (people.data ?? []).find((p) => p.id === draft.assigneePersonId)?.name ?? ''
                      }
                      color={
                        (people.data ?? []).find((p) => p.id === draft.assigneePersonId)?.avatarColor ??
                        '#64748b'
                      }
                      image={(people.data ?? []).find((p) => p.id === draft.assigneePersonId)?.avatar}
                      size={26}
                    />
                  )}
                  <select
                    className="select select-bordered w-full"
                    value={draft.assigneePersonId}
                    onChange={(e) => set('assigneePersonId', e.target.value)}
                  >
                    <option value="">Nobody yet</option>
                    {me && <option value={me.id}>Me</option>}
                    {(people.data ?? [])
                      .filter((p) => !p.isMe)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
              </Field>
              <Field label="Due date" hint="Optional — dated items show up on Today.">
                <DateField value={draft.dueDate} onChange={(v) => set('dueDate', v)} />
              </Field>
            </div>
          </>
        )}

        {kind === 'decision' && (
          <>
            <Field label="What was decided">
              <input
                autoFocus
                className="input input-bordered w-full"
                placeholder="Roll out market by market rather than all at once"
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field label="Why" hint="The reasoning, including the constraint that forced it.">
              <textarea
                className="textarea textarea-bordered min-h-24 w-full text-sm"
                value={draft.note}
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
            <Field label="Decided on">
              <DateField
                value={draft.date}
                onChange={(v) => set('date', v)}
                allowClear={false}
                className="w-52"
              />
            </Field>
          </>
        )}

        {kind === 'journal' && (
          <>
            <Field label="What happened">
              <textarea
                autoFocus
                className="textarea textarea-bordered min-h-28 w-full text-sm leading-relaxed"
                placeholder="Write it the way you would tell a colleague — the detail you skip is the one you will want."
                value={draft.note}
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
            <Field label="Date">
              <DateField
                value={draft.date}
                onChange={(v) => set('date', v)}
                allowClear={false}
                className="w-52"
              />
            </Field>
          </>
        )}

        {kind === 'meeting' && (
          <>
            <Field label="Name" hint="Optional — you can fill in the notes and who was there afterwards.">
              <input
                autoFocus
                className="input input-bordered w-full"
                placeholder="Weekly sync"
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field label="Date">
              <DateField
                value={draft.date}
                onChange={(v) => set('date', v)}
                allowClear={false}
                className="w-52"
              />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
