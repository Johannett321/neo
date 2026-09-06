import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Workspace } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { Panel } from '@/components/primitives'

/**
 * What this working life is worth being interrupted about.
 *
 * The workspace's half of notifications. Whether this *machine* may show one at all,
 * and at what hour, is in app settings, because that is a question about the computer
 * and the week you are having; this is a question about the work, and the day job and
 * a client can reasonably want different answers to it — a week's warning on a client
 * deadline, nothing at all from the thing you tinker with on Sundays.
 *
 * Nothing here is a reminder. There is no list to keep, nothing to snooze and nothing
 * to dismiss: every switch reads a deadline or a due date that already exists, which
 * is the same rule the attention line follows. Forgetting to set one costs you a
 * nudge, never an answer.
 *
 * The preview at the bottom is the reason `notification:pending` is a channel rather
 * than something the delivery loop works out privately. Notification settings are
 * abstract by nature — five switches about hypothetical mornings — and one line
 * showing the sentence you would actually be handed today is worth more than any
 * amount of prose explaining them.
 */
export function NotificationPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const settings = useApi('settings:get')
  const machineOff = settings.data ? !settings.data.notifications : false

  const on = workspace.notify

  return (
    <div className="space-y-4">
      {machineOff && (
        <Panel className="border-warning/40">
          <div className="flex items-start gap-3">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-[12px] leading-relaxed text-base-content/70">
              Notifications are switched off for this machine, so nothing below is shown
              whatever it says. Turn them back on in{' '}
              <Link
                to="/settings?pane=notifications"
                className="underline decoration-base-content/25 hover:decoration-current"
              >
                app settings
              </Link>
              .
            </p>
          </div>
        </Panel>
      )}

      <Panel>
        <label className="flex cursor-pointer items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Let {workspace.name} interrupt me</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-base-content/55">
              Each area answers this for itself. Off, and this workspace never says
              anything — its deadlines are still on Today, where you go and look.
            </span>
          </span>
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={on}
            onChange={(e) => save.mutate({ id: workspace.id, notify: e.target.checked })}
          />
        </label>
      </Panel>

      <div className={on ? '' : 'pointer-events-none opacity-40'}>
        <Panel padded={false}>
          <div className="hairline border-b px-4 py-3">
            <div className="text-[13px] font-medium">Project deadlines</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
              The date on the project itself.
            </p>
          </div>

          <AheadRow
            label="Coming up"
            hint="Said once, on that exact morning — not every day until it arrives."
            days={workspace.notifyProjectAheadDays}
            fallback={7}
            onChange={(notifyProjectAheadDays) =>
              save.mutate({ id: workspace.id, notifyProjectAheadDays })
            }
          />
          <SwitchRow
            label="On the day"
            hint="The morning the deadline falls."
            checked={workspace.notifyProjectOnTheDay}
            onChange={(notifyProjectOnTheDay) =>
              save.mutate({ id: workspace.id, notifyProjectOnTheDay })
            }
          />
        </Panel>

        <Panel padded={false} className="mt-4">
          <div className="hairline border-b px-4 py-3">
            <div className="text-[13px] font-medium">Cards and to-dos</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
              Due dates on the board. Everything due on the same morning arrives as one
              notification, however many there are.
            </p>
          </div>

          <AheadRow
            label="Coming up"
            hint="A day ahead is the useful one: it is still possible to do something about it."
            days={workspace.notifyTaskAheadDays}
            fallback={1}
            onChange={(notifyTaskAheadDays) => save.mutate({ id: workspace.id, notifyTaskAheadDays })}
          />
          <SwitchRow
            label="On the day"
            hint="The morning it is due."
            checked={workspace.notifyTaskOnTheDay}
            onChange={(notifyTaskOnTheDay) => save.mutate({ id: workspace.id, notifyTaskOnTheDay })}
          />
          <SwitchRow
            label="The morning after, if it is still open"
            hint="Once. Something that has been late for a fortnight is a fact about the project, and Today is where it lives."
            checked={workspace.notifyTaskDayAfter}
            onChange={(notifyTaskDayAfter) => save.mutate({ id: workspace.id, notifyTaskDayAfter })}
          />
        </Panel>
      </div>

      <Preview workspace={workspace} />

      <p className="px-1 text-[12px] leading-relaxed text-base-content/45">
        A paused project says nothing at all, exactly as it asks nothing of Today. Archived
        projects and finished ones are silent too.
      </p>
    </div>
  )
}

/**
 * A row whose switch and whose number are the same setting.
 *
 * Zero days means never, so the toggle writes zero and writing a number turns it back
 * on. Two controls over one column rather than a boolean beside an integer, which is
 * the arrangement where "on, nought days before" becomes possible and means nothing.
 */
function AheadRow({
  label,
  hint,
  days,
  fallback,
  onChange
}: {
  label: string
  hint: string
  days: number
  /** What turning it back on restores, since zero is the off position. */
  fallback: number
  onChange: (days: number) => void
}): React.JSX.Element {
  const on = days > 0
  /*
   * Typed here and written on the way out, exactly as the name field is and for the
   * same reason: every save invalidates the whole query cache, and typing "14" would
   * otherwise mean saving 1 and then 14. It follows the setting whenever the switch
   * moves it, so turning the row off and on again shows the number it restored.
   */
  const [typed, setTyped] = useState(String(on ? days : fallback))
  useEffect(() => setTyped(String(on ? days : fallback)), [days, on, fallback])

  const commit = (): void => {
    const next = Math.min(90, Math.max(1, Math.round(Number(typed) || fallback)))
    setTyped(String(next))
    if (next !== days) onChange(next)
  }

  return (
    <div className="hairline flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] text-base-content/45">{hint}</span>
      </span>

      <span className={`flex shrink-0 items-center gap-1.5 ${on ? '' : 'opacity-35'}`}>
        <input
          type="number"
          min={1}
          max={90}
          className="input input-bordered input-sm w-[62px] text-center tabular-nums"
          value={typed}
          disabled={!on}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="text-[12px] text-base-content/50">days before</span>
      </span>

      <input
        type="checkbox"
        className="toggle toggle-sm shrink-0"
        checked={on}
        onChange={(e) => onChange(e.target.checked ? fallback : 0)}
        aria-label={label}
      />
    </div>
  )
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  return (
    <label className="hairline flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] text-base-content/45">{hint}</span>
      </span>
      <input
        type="checkbox"
        className="toggle toggle-sm shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

/**
 * The sentences this workspace would hand you this morning, exactly as written.
 *
 * It is the same channel the delivery loop reads, so this is not an illustration of
 * what might happen — it is the thing itself, minus the desktop. Nothing today is the
 * ordinary answer and is drawn as such: a quiet day is what these settings are tuned
 * to produce, not a failure of the preview.
 */
function Preview({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const pending = useApi('notification:pending', { workspaceId: workspace.id })
  const items = pending.data ?? []

  return (
    <Panel>
      <div className="mb-3">
        <div className="text-[13px] font-medium">This morning</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
          What these settings would have said today, given what is actually in{' '}
          {workspace.name}.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-[12.5px] text-base-content/45">
          <Icon name="check" size={14} className="opacity-60" />
          Nothing to say today.
        </div>
      ) : (
        <div className="hairline overflow-hidden rounded-box border">
          {items.map((item) => (
            <div key={item.kind} className="hairline flex gap-2.5 border-b px-3 py-2.5 last:border-b-0">
              <Icon name="bell" size={14} className="mt-px shrink-0 text-base-content/35" />
              <div className="min-w-0">
                <div className="text-[13px]">{item.title}</div>
                <div className="text-[11.5px] text-base-content/45">{item.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
