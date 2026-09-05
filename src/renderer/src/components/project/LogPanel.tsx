import { useState } from 'react'
import type { JournalEntry } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { formatDate, plural, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { ConfirmButton, Section } from '@/components/primitives'

/** How much of the log a front page shows before you ask for the rest. */
const PREVIEW = 6

/**
 * Append-only, dated. The current-state block stays true; this remembers how you
 * got there — which is what you actually want when a decision needs re-explaining.
 *
 * The composer is folded away until you press Add entry. It used to sit open at the
 * top of the project's front page, which spent the best space on the screen on an
 * empty box: reading a project is the common case and writing to it is the rare one,
 * so the entries come first and the form arrives when it is asked for.
 */
export function LogPanel({
  projectId,
  entries
}: {
  projectId: string
  entries: JournalEntry[]
}): React.JSX.Element {
  const save = useApiMutation('journal:save')
  const remove = useApiMutation('journal:delete')
  const [composing, setComposing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayStr())

  const submit = async (): Promise<void> => {
    if (!body.trim()) return
    await save.mutateAsync({ projectId, body: body.trim(), occurredOn })
    setBody('')
    setOccurredOn(todayStr())
    setComposing(false)
  }

  const shown = expanded ? entries : entries.slice(0, PREVIEW)

  return (
    <Section
      title="Log"
      count={entries.length}
      action={
        !composing && (
          <button className="btn btn-ghost btn-xs gap-1" onClick={() => setComposing(true)}>
            <Icon name="plus" size={12} />
            Add entry
          </button>
        )
      }
    >
      {composing && (
        <div className="rise hairline mb-6 rounded-box border bg-base-100 p-3">
          <textarea
            autoFocus
            className="w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed outline-none placeholder:text-base-content/35"
            rows={3}
            placeholder="What happened? Write it the way you would tell a colleague — the detail you skip is the one you will want."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              // Nothing typed yet means nothing to lose, so Escape just puts it away.
              if (e.key === 'Escape' && !body.trim()) setComposing(false)
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <DateField value={occurredOn} onChange={setOccurredOn} allowClear={false} className="w-44" />
            <button
              className="btn btn-ghost btn-xs ml-auto"
              onClick={() => {
                setBody('')
                setComposing(false)
              }}
            >
              Cancel
            </button>
            <button className="btn btn-primary btn-xs" disabled={!body.trim()} onClick={() => void submit()}>
              Add entry
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 && !composing ? (
        /*
          The invitation and the button are the same thing, so an empty log is one
          quiet line rather than a framed announcement that nothing is there.
        */
        <button
          className="hairline row-hover block w-full rounded-box border border-dashed px-4 py-3 text-left text-[12px] text-base-content/45"
          onClick={() => setComposing(true)}
        >
          Nothing in the log yet — one paragraph after a meeting is usually enough.
        </button>
      ) : (
        <>
          <div className="space-y-4">
            {shown.map((entry) => (
              <div key={entry.id} className="group flex gap-4">
                <div className="w-16 shrink-0 pt-0.5 text-[11px] tabular-nums text-base-content/40">
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

          {entries.length > PREVIEW && (
            <button
              className="mt-4 ml-20 text-[11.5px] text-base-content/45 transition hover:text-base-content"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? 'Show less'
                : `Show ${plural(entries.length - PREVIEW, 'earlier entry', 'earlier entries')}`}
            </button>
          )}
        </>
      )}
    </Section>
  )
}
