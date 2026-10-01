import { useState } from 'react'
import type { TaskView, TodayAcross, WorkspaceDay } from '@shared/types'
import { useApi } from '@/lib/api'
import { formatLongDate, plural } from '@/lib/format'
import { useGoIn, useWorkspaces } from '@/lib/workspace'
import { Dot, EmptyState, PageHeader, Panel, Section } from '@/components/primitives'
import { Icon } from '@/components/Icon'
import { Mark } from '@/components/Mark'
import { Pending } from '@/components/PageTransition'
import { TaskDialog } from '@/components/TaskDialog'
import { TaskList } from '@/components/TaskRow'

/**
 * Today, across every workspace — the one screen that mixes them, and on purpose.
 *
 * Everything else in the app is fenced to the workspace you are in, and that is what
 * makes switching between working lives feel like closing one door and opening
 * another. The cost is that a card going late in the workspace you are *not* in says
 * nothing until you happen to look, and a deadline in the other life is precisely the
 * one you miss. So this answers a single question — is anything late or due anywhere —
 * and nothing more: no attention list, no stats, no front block, none of the things
 * that make a workspace's Today feel like that workspace. Each workspace's own Today
 * stays pure.
 *
 * Grouped by urgency first, because that is what you came here to find; the workspace
 * is what each row says about itself — its colour down the left and its name before
 * the project's. Every way out of a row (opening it, the board, the meeting) switches
 * to the row's workspace first, through `useGoIn()`, so you arrive in the right life.
 */
export function EverywherePage(): React.JSX.Element {
  const { data } = useApi('dashboard:everywhere')
  const { workspaces } = useWorkspaces()
  const goIn = useGoIn()
  const [editing, setEditing] = useState<TaskView | null>(null)

  if (!data) return <Pending />

  /*
   * A workspace that has switched off "next seven days" or the meeting to-dos on its
   * own Today has said it does not want to be asked about them in the morning, and
   * this is the same morning. Overdue and due today have no switch anywhere.
   */
  const settings = new Map(workspaces.map((w) => [w.id, w]))
  const soon = data.soon.filter((t) => settings.get(t.workspaceId)?.todayShowSoon ?? true)
  const owed = data.owedFromMeetings.filter(
    (m) => settings.get(m.workspaceId)?.todayShowMeetingTodos ?? true
  )
  const clear = data.overdue.length === 0 && data.dueToday.length === 0 && soon.length === 0

  return (
    <>
      <PageHeader
        title="All workspaces"
        subtitle={`${formatLongDate(data.today)} · What is late or due, everywhere at once.`}
      />

      <Summary
        days={data.workspaces}
        onOpen={(day) => goIn(day.workspaceId, '/')}
      />

      {clear && owed.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing is late or due in any workspace."
          hint="Nothing overdue and nothing due in the next week, anywhere. Each workspace's own Today still has the rest."
        />
      ) : (
        <>
          {data.overdue.length > 0 && (
            <Section title="Overdue" count={data.overdue.length} tone="danger">
              <TaskList tasks={data.overdue} showWorkspace onEdit={setEditing} />
            </Section>
          )}

          {data.dueToday.length > 0 && (
            <Section title="Due today" count={data.dueToday.length}>
              <TaskList tasks={data.dueToday} showWorkspace onEdit={setEditing} />
            </Section>
          )}

          {soon.length > 0 && (
            <Section title="Next seven days" count={soon.length}>
              <TaskList tasks={soon} showWorkspace onEdit={setEditing} />
            </Section>
          )}

          {owed.length > 0 && (
            <Section
              title="Open to-dos from meetings"
              count={owed.reduce((total, m) => total + m.openTodos, 0)}
              tone="danger"
            >
              <Panel padded={false}>
                {owed.map((meeting) => (
                  <MeetingRow
                    key={meeting.meetingId}
                    meeting={meeting}
                    onOpen={() =>
                      goIn(
                        meeting.workspaceId,
                        `/projects/${meeting.projectId}/meetings/${meeting.meetingId}`
                      )
                    }
                  />
                ))}
              </Panel>
            </Section>
          )}
        </>
      )}

      <TaskDialog open={editing !== null} onClose={() => setEditing(null)} task={editing} />
    </>
  )
}

/**
 * One tile per workspace, in the switcher's order, quiet ones included — the strip
 * is also the answer to "and the others are fine?", which a list of only the noisy
 * ones cannot give. Pressing one goes to that workspace's own Today.
 *
 * The counts are grey unless they mean something: a red number only where something
 * is late, so a row of tiles with nothing wrong in them reads as calm at a glance.
 */
function Summary({
  days,
  onOpen
}: {
  days: WorkspaceDay[]
  onOpen: (day: WorkspaceDay) => void
}): React.JSX.Element {
  return (
    <div className="mb-9 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
      {days.map((day) => (
        <button
          key={day.workspaceId}
          onClick={() => onOpen(day)}
          className="hairline group flex items-center gap-3 rounded-box border bg-base-100 px-3 py-2.5 text-left transition hover:bg-base-200"
          title={`Open ${day.name}'s Today`}
        >
          <Mark name={day.name} color={day.color} icon={day.icon} size={30} rounded="rounded-[8px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{day.name}</span>
            <span className="mt-0.5 block truncate text-[11.5px] tabular-nums">
              <Counts day={day} />
            </span>
          </span>
          <Icon
            name="chevronRight"
            size={13}
            className="shrink-0 text-base-content/30 opacity-0 transition group-hover:opacity-100"
          />
        </button>
      ))}
    </div>
  )
}

function Counts({ day }: { day: WorkspaceDay }): React.JSX.Element {
  if (day.overdue === 0 && day.dueToday === 0) {
    return (
      <span className="text-base-content/40">
        {day.soon > 0 ? `${day.soon} this week` : 'Nothing due'}
      </span>
    )
  }
  return (
    <>
      {day.overdue > 0 && <span className="font-medium text-error">{day.overdue} overdue</span>}
      {day.overdue > 0 && day.dueToday > 0 && <span className="text-base-content/25"> · </span>}
      {day.dueToday > 0 && <span className="text-base-content/70">{day.dueToday} today</span>}
    </>
  )
}

/** A meeting still owing to-dos, with the workspace it is in said first. */
function MeetingRow({
  meeting,
  onOpen
}: {
  meeting: TodayAcross['owedFromMeetings'][number]
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onOpen}
      className="row-hover hairline group flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-b-0"
      style={{ boxShadow: `inset 2px 0 0 ${meeting.workspaceColor}` }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{meeting.title || 'Meeting'}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-base-content/45">
          <Dot color={meeting.workspaceColor} size={5} />
          <span className="shrink-0 text-base-content/60">{meeting.workspaceName}</span>
          <span className="text-base-content/25">·</span>
          <span className="truncate">{meeting.projectName}</span>
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-error">
        {plural(meeting.openTodos, 'open to-do', 'open to-dos')}
      </span>
      <Icon
        name="chevronRight"
        size={13}
        className="shrink-0 text-base-content/30 opacity-0 transition group-hover:opacity-100"
      />
    </button>
  )
}
