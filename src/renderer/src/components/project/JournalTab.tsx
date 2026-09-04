import { useState } from 'react'
import type { Activity, JournalEntry } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { formatDate, relativeFromIso, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { ConfirmButton, EmptyState } from '@/components/primitives'

/**
 * Append-only, dated. The current-state block stays true; this remembers how you
 * got there — which is what you actually want when a decision needs re-explaining.
 */
export function JournalTab({
  projectId,
  entries
}: {
  projectId: string
  entries: JournalEntry[]
}): React.JSX.Element {
  const save = useApiMutation('journal:save')
  const remove = useApiMutation('journal:delete')
  const [body, setBody] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayStr())

  const submit = async (): Promise<void> => {
    if (!body.trim()) return
    await save.mutateAsync({ projectId, body: body.trim(), occurredOn })
    setBody('')
    setOccurredOn(todayStr())
  }

  return (
    <div>
      <div className="hairline mb-6 rounded-box border bg-base-100 p-3">
        <textarea
          className="w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed outline-none placeholder:text-base-content/35"
          rows={3}
          placeholder="What happened? Write it the way you would tell a colleague — the detail you skip is the one you will want."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <DateField
            value={occurredOn}
            onChange={setOccurredOn}
            allowClear={false}
            className="w-44"
          />
          <button
            className="btn btn-primary btn-xs ml-auto"
            disabled={!body.trim()}
            onClick={() => void submit()}
          >
            Add entry
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon="journal" title="No entries yet." hint="One paragraph after a meeting is usually enough." />
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <div key={entry.id} className="group flex gap-4">
              <div className="w-20 shrink-0 pt-0.5 text-[11px] tabular-nums text-base-content/40">
                {formatDate(entry.occurredOn)}
              </div>
              <div className="hairline min-w-0 flex-1 border-l pl-4">
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{entry.body}</p>
              </div>
              <div className="shrink-0 opacity-0 transition group-hover:opacity-100">
                <ConfirmButton onConfirm={() => remove.mutate({ id: entry.id })} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ACTIVITY_ICON: Record<string, Parameters<typeof Icon>[0]['name']> = {
  task_created: 'plus',
  task_completed: 'check',
  note: 'note',
  decision: 'decision',
  journal: 'journal',
  state_updated: 'edit',
  person_added: 'people',
  link_added: 'link',
  lane_added: 'lane',
  project_created: 'sparkle'
}

export function ActivityTab({ activity }: { activity: Activity[] }): React.JSX.Element {
  if (activity.length === 0) {
    return <EmptyState icon="clock" title="Nothing recorded yet." />
  }
  return (
    <div className="hairline overflow-hidden rounded-box border bg-base-100">
      {activity.map((item) => (
        <div key={item.id} className="hairline flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
          <Icon name={ACTIVITY_ICON[item.kind] ?? 'dot'} size={13} className="text-base-content/30" />
          <span className="min-w-0 flex-1 truncate text-[12px]">{item.summary}</span>
          <span className="shrink-0 text-[11px] text-base-content/35">{relativeFromIso(item.createdAt)}</span>
        </div>
      ))}
    </div>
  )
}
