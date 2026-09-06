import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi, useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import type { ProjectSummary } from '@shared/types'
import { daysBetween, dueLabel, projectColor, relativeFromIso, STATUS_LABEL, todayStr } from '@/lib/format'
import { DeadlineBar } from './DeadlineBar'
import { MoveToFolderModal } from './FolderPicker'
import { Icon } from './Icon'
import { Mark } from './Mark'

function Initial({
  name,
  color,
  image
}: {
  name: string
  color: string
  image: string | null
}): React.JSX.Element {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        title={name}
        className="size-[22px] shrink-0 rounded-full object-cover ring-2 ring-base-100"
      />
    )
  }
  return (
    <span
      className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[9px] font-medium text-white ring-2 ring-base-100"
      style={{ backgroundColor: color }}
      title={name}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * The card carries what a project manager checks before opening anything: what it is,
 * how its deadline is going, what it is asking for, how much is open and who is on it.
 * Everything else waits until you are inside.
 */
export function ProjectCard({ project }: { project: ProjectSummary }): React.JSX.Element {
  const navigate = useNavigate()
  const openMenu = useContextMenu()
  const save = useApiMutation('project:save')
  const setArchived = useApiMutation('project:setArchived')
  const remove = useApiMutation('project:delete')
  const [moving, setMoving] = useState(false)
  // The card is on Today and in search results as well as on the projects page, so
  // filing is offered wherever the card is. Nothing is drawn for it until there is
  // somewhere to file it.
  const folders = useApi('folder:list', { workspaceId: project.workspaceId }).data ?? []
  const dueIn = project.nextDue ? daysBetween(todayStr(), project.nextDue) : null
  const color = projectColor(project)
  const paused = project.status === 'paused'

  return (
    <>
      <Link
        to={`/projects/${project.id}`}
        /*
         * An anchor drags its own URL, and what that looks like is a browser dragging a
         * link — a ghost of the text and a URL badge — rather than a person picking a
         * card up. Turning it off here lets whatever wraps the card be the drag source,
         * so what follows the pointer is the card. Nothing in a desktop app wants a
         * link dragged out of it anyway.
         */
        draggable={false}
        className={`hairline group relative flex flex-col overflow-hidden rounded-box border bg-base-100 p-4 transition hover:border-base-content/20 hover:shadow-sm ${
          // A paused card is meant to be scanned past, so the whole of it steps back —
          // outline, contents and band together, because dimming the parts unevenly is
          // what made the band shout. Pointing at it brings all of it back: quieter,
          // never harder to read.
          paused ? 'opacity-50 hover:opacity-100' : ''
        }`}
        onContextMenu={(e) =>
          openMenu(e, [
            // Nothing here opens the project: clicking the card already does that, and
            // a menu whose first item repeats the gesture that opened it is filler.
            { label: 'Project settings', icon: 'settings', onSelect: () => navigate(`/projects/${project.id}/settings`) },
            'separator',
            ...(folders.length > 0
              ? [
                  {
                    label: project.folderId ? 'Move to another folder…' : 'Move to a folder…',
                    icon: 'folder' as const,
                    onSelect: () => setMoving(true)
                  }
                ]
              : []),
            {
              label: project.isPinned ? 'Unpin' : 'Pin to the top',
              icon: 'pin',
              onSelect: () => save.mutate({ id: project.id, isPinned: !project.isPinned })
            },
            {
              label: paused ? 'Pick it back up' : 'Pause project',
              icon: 'pause',
              onSelect: () => save.mutate({ id: project.id, status: paused ? 'active' : 'paused' })
            },
            {
              label: project.archivedAt ? 'Restore from archive' : 'Archive',
              icon: 'archive',
              onSelect: () => setArchived.mutate({ id: project.id, archived: !project.archivedAt })
            },
            'separator',
            {
              label: 'Delete project',
              icon: 'trash',
              danger: true,
              onSelect: () => remove.mutate({ id: project.id }),
              confirm: {
                title: `Delete ${project.name}?`,
                body: 'Its items, notes, meetings, decisions and log go with it. Archiving hides it instead, and keeps everything.',
                confirmLabel: 'Delete project'
              }
            }
          ])
        }
      >
        {/*
          A paused project is a card you scan past, so it says so before it is read:
          one banded corner, clipped by the card's own rounding, carrying the word
          itself. It replaces the status pill rather than sitting above one — the same
          fact twice on one card is one too many.

          Neutral, and deliberately no hue at all: every colour in this app already
          means something — warm means a signal, and a project's own colour means which
          project. A paused one is neither, so its band is the text colour used as a
          fill and inverts with the theme, graphite on white and ivory on black.

          It fades with the rest of the card rather than staying lit above it: the band
          is there to be recognised out of the corner of your eye, not read, and a mark
          at full strength on a card that has stepped back draws more attention than the
          projects still running — the opposite of what pausing one is for.

          The geometry is arithmetic rather than taste: the band's centre sits at
          (23, 23) from the corner, so the word is centred on the corner's own bisector,
          and both ends run past an edge to be cut off by `overflow-hidden`.
        */}
        {paused && (
          <span className="pointer-events-none absolute -right-[37px] top-[14px] flex h-[18px] w-[120px] rotate-45 items-center justify-center bg-base-content/75 text-[8px] font-semibold uppercase tracking-[0.14em] text-base-100">
            Paused
          </span>
        )}

        <div className="mb-2.5 flex items-start gap-3">
          <Mark
            name={project.name}
            color={color}
            icon={project.icon}
            size={34}
            rounded="rounded-[9px]"
          />
          <div className={`min-w-0 flex-1 ${paused ? 'pr-11' : ''}`}>
            <div className="flex items-center gap-1.5">
              {project.isPinned && <Icon name="pin" size={11} className="shrink-0 text-base-content/30" />}
              <span className="truncate text-[14px] font-medium tracking-[-0.01em]">{project.name}</span>
            </div>
            {project.status !== 'active' && !paused && (
              <div className="mt-1">
                <span className="hairline rounded-full border px-1.5 py-px text-[10px] text-base-content/45">
                  {STATUS_LABEL[project.status]}
                </span>
              </div>
            )}
          </div>
        </div>

        <p className="line-clamp-2 min-h-[2.4em] text-[12px] leading-[1.45] text-base-content/60">
          {project.summary || 'No summary yet.'}
        </p>

        {project.deadline && (
          <DeadlineBar deadline={project.deadline} createdAt={project.createdAt} color={color} />
        )}

        {project.attention && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-base-content/50">
            <Icon name="arrowRight" size={11} className="mt-[3px] shrink-0 opacity-60" />
            <span className="line-clamp-1">{project.attention}</span>
          </p>
        )}

        <div className="min-h-3 flex-1" />

        <div className="hairline flex items-center gap-2 border-t pt-2.5">
          {project.castPreview.length > 0 ? (
            <span className="flex -space-x-1.5">
              {project.castPreview.slice(0, 4).map((member) => (
                <Initial key={member.name} name={member.name} color={member.color} image={member.avatar} />
              ))}
              {project.peopleCount > 4 && (
                <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-base-300 text-[9px] font-medium text-base-content/60 ring-2 ring-base-100">
                  +{project.peopleCount - 4}
                </span>
              )}
            </span>
          ) : (
            <span className="text-[11px] text-base-content/30">No people yet</span>
          )}

          <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums">
            {project.overdueTasks > 0 ? (
              <span className="font-medium text-error">{project.overdueTasks} overdue</span>
            ) : (
              <span className="text-base-content/45">{project.openTasks} open</span>
            )}
            <span className="text-base-content/35">{relativeFromIso(project.lastActivityAt)}</span>
            {dueIn !== null && (
              <span
                className={
                  dueIn < 0 ? 'text-error' : dueIn <= 2 ? 'text-warning' : 'text-base-content/45'
                }
                title={project.nextDue ?? undefined}
              >
                {dueLabel(dueIn)}
              </span>
            )}
          </span>
        </div>

      </Link>

      {moving && (
        <MoveToFolderModal
          open
          onClose={() => setMoving(false)}
          folders={folders.map((f) => ({
            id: f.id,
            name: f.name,
            depth: f.depth,
            count: f.projectCount
          }))}
          title={`Move ${project.name}`}
          description="Filing only. Nothing about the project itself changes."
          current={project.folderId}
          onMove={(folderId) => save.mutate({ id: project.id, folderId })}
        />
      )}
    </>
  )
}
