import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MeetingView, RecordingView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { formatBytes, formatDate, plural } from '@/lib/format'
import { excerpt } from '@/lib/markdown'
import { Icon } from '@/components/Icon'
import { Avatar, EmptyState } from '@/components/primitives'
import { MoveToFolderModal } from '@/components/FolderPicker'
import { FolderTrail } from '@/components/FolderTrail'
import {
  CarryableRow, ContentFolderRow, FilingDialogs, useFiling
} from '@/components/ContentFolders'
import { useProject } from './ProjectLayout'

/**
 * A meeting is a note that knows when it happened and who was there. That is the
 * difference that matters: months later the question is never "what was written",
 * it is "who was in the room when we agreed this".
 *
 * The list is an index rather than an editor — a meeting opens on its own page, the
 * same way a note does. What it has to answer without being opened is whether the
 * meeting left anything behind, so an unfinished item is said in words on the row.
 *
 * And it files exactly the way the notes do, through the same code: a folder is a row
 * in this list, the trail across the top is the way back out, and with no folders at
 * all the page is precisely the list it has always been.
 */
export function ProjectMeetings(): React.JSX.Element {
  const { project, meetings, meetingFolders } = useProject()
  const remove = useApiMutation('meeting:delete')
  const openMenu = useContextMenu()
  const navigate = useNavigate()
  const filing = useFiling('meeting', meetingFolders)
  const [moving, setMoving] = useState<MeetingView | null>(null)

  // A meeting logged inside a folder is filed there, so the URL carries where you are.
  const href = (meetingId: string): string =>
    `/projects/${project.id}/meetings/${meetingId}${filing.openFolderId ? `?in=${filing.openFolderId}` : ''}`

  const here = filing.here(meetings)
  /*
   * What is still owed is counted across the whole project rather than this folder.
   * Filing is where you put a meeting, not whether it still owes you something — a
   * count that quietly dropped what is filed elsewhere would be the page lying about
   * the work while looking exactly the same.
   */
  const owing = meetings.reduce((total, m) => total + m.openTodos, 0)

  const pageMenu: MenuItem[] = [
    {
      label: 'New',
      icon: 'plus',
      items: [
        { label: 'Meeting', icon: 'people', onSelect: () => navigate(href('new')) },
        filing.newFolderItem
      ]
    }
  ]

  return (
    <>
      {/* The whole pane is the target, empty space included, which is why the handler
          sits on a wrapper with a floor under its height. Rows and folders stop the
          event at their own menu on the way up. */}
      <div className="min-h-[60vh]" onContextMenu={(e) => openMenu(e, pageMenu)}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Link className="btn btn-primary btn-sm gap-1.5" to={href('new')}>
            <Icon name="plus" size={13} />
            Log a meeting
          </Link>
          <button
            className="btn btn-ghost btn-sm gap-1.5"
            onClick={() => filing.setNewFolderIn(filing.openFolderId)}
          >
            <Icon name="folder" size={13} />
            New folder
          </button>
          {/*
            When the last meeting was and who was in it are both on the rows below, and
            neither is something you act on. What is still owed is, so it is the only
            thing standing next to the button.
          */}
          {owing > 0 && (
            <span className="owing badge badge-sm gap-1 font-medium">
              <Icon name="checkbox" size={11} />
              {plural(owing, 'open to-do', 'open to-dos')}
            </span>
          )}
          {filing.crumbs.length > 0 && (
            <span className="min-w-0 text-[12px] text-base-content/50">
              <FolderTrail
                crumbs={filing.crumbs}
                folders={filing.folders}
                dragged={filing.dragged}
                rootLabel="All meetings"
                onOpen={filing.open}
                onMoveHere={filing.moveHere}
              />
            </span>
          )}
        </div>

        {filing.subfolders.length > 0 && (
          <div className="mb-4 space-y-2">
            {filing.subfolders.map((folder) => (
              <ContentFolderRow key={folder.id} folder={folder} filing={filing} noun="meeting" />
            ))}
          </div>
        )}

        {here.length === 0 && filing.subfolders.length === 0 ? (
          <EmptyState
            icon={filing.openFolderId ? 'folder' : 'people'}
            title={filing.openFolderId ? 'Nothing in this folder yet.' : 'No meetings recorded.'}
            hint={
              filing.openFolderId
                ? 'Drag a meeting onto a folder to file it, or log one in here.'
                : 'Who was there, what was said and what came out of it. Five minutes afterwards saves an hour later.'
            }
          />
        ) : (
          <div className="space-y-2.5">
            {here.map((meeting) => (
              <CarryableRow key={meeting.id} id={meeting.id} filing={filing}>
                <Link
                  to={href(meeting.id)}
                  draggable={false}
                  className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: 'Open', icon: 'edit', onSelect: () => navigate(href(meeting.id)) },
                      { label: 'Move to…', icon: 'folder', onSelect: () => setMoving(meeting) },
                      'separator',
                      {
                        label: 'Delete meeting',
                        icon: 'trash',
                        danger: true,
                        onSelect: () => remove.mutate({ id: meeting.id }),
                        confirm: {
                          title: 'Delete this meeting?',
                          body: meeting.title || formatDate(meeting.occurredOn)
                        }
                      }
                    ])
                  }
                >
                  <div className="flex items-baseline gap-3">
                    <span className="flex-1 truncate text-[13px] font-medium">
                      {meeting.title || 'Meeting'}
                    </span>
                    {meeting.openTodos > 0 && (
                      <span className="owing-soft flex shrink-0 items-center gap-1.5 rounded-full px-2 py-px text-[10.5px] font-medium">
                        <Icon name="checkbox" size={10} />
                        {plural(meeting.openTodos, 'open to-do', 'open to-dos')}
                      </span>
                    )}
                    {meeting.recording && <RecordingBadge recording={meeting.recording} />}
                    <span className="shrink-0 text-[11px] tabular-nums text-base-content/45">
                      {formatDate(meeting.occurredOn)}
                    </span>
                  </div>

                  <div className="mt-1.5 flex items-center gap-2">
                    {meeting.attendees.length > 0 ? (
                      <span className="flex -space-x-1.5">
                        {meeting.attendees.slice(0, 5).map((person) => (
                          <span key={person.id} className="rounded-full ring-2 ring-base-100">
                            <Avatar name={person.name} color={person.color} image={person.avatar} size={20} />
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-[11px] text-base-content/30">Nobody recorded</span>
                    )}
                    {meeting.todos.length > 0 && meeting.openTodos === 0 && (
                      <span className="text-[11px] text-base-content/35">
                        {plural(meeting.todos.length, 'item')}, all done
                      </span>
                    )}
                  </div>

                  {meeting.body && (
                    <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-base-content/60">
                      {excerpt(meeting.body)}
                    </p>
                  )}
                </Link>
              </CarryableRow>
            ))}
          </div>
        )}
      </div>

      {/* Outside the wrapper above: a right-click in a text field belongs to the field. */}
      <FilingDialogs projectId={project.id} filing={filing} noun="meeting" />

      {moving && (
        <MoveToFolderModal
          key={moving.id}
          open
          onClose={() => setMoving(null)}
          folders={filing.pickable}
          title={`Move ${moving.title || 'this meeting'}`}
          description="Filing only. Nothing about the meeting itself changes."
          current={moving.folderId}
          onMove={(folderId) => filing.file(moving.id, folderId)}
        />
      )}
    </>
  )
}

/**
 * A recorded meeting says so on its row, and says what state the recording is in —
 * because the work happens without you watching it, and "is that transcript ready
 * yet" is otherwise a question you can only answer by opening the meeting.
 */
function RecordingBadge({ recording }: { recording: RecordingView }): React.JSX.Element {
  const [label, tone] =
    recording.captureState === 'recording'
      ? ['Recording', 'text-error']
      : recording.captureState === 'interrupted'
        ? ['Interrupted', 'text-warning']
        : recording.transcriptState === 'failed' || recording.summaryState === 'failed'
          ? ['Needs a look', 'text-warning']
          : recording.summaryState === 'done'
            ? [recording.audioDeletedAt ? 'Transcript' : formatBytes(recording.bytes), 'text-base-content/45']
            : recording.transcriptState === 'done'
              ? ['Writing the recap…', 'text-base-content/45']
              : ['Transcribing…', 'text-base-content/45']

  return (
    <span className={`flex shrink-0 items-center gap-1 text-[10.5px] ${tone}`}>
      <Icon name={recording.captureState === 'recording' ? 'mic' : 'waveform'} size={11} />
      {label}
    </span>
  )
}
