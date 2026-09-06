import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { useApi, useApiMutation, usePrefetch } from '@/lib/api'
import { ENTER, EXIT } from '@/lib/motion'
import { projectColor, STATUS_LABEL } from '@/lib/format'
import { useWorkspace, useWorkspaces } from '@/lib/workspace'
import { PanelResizeHandle, useResizablePanel } from '@/lib/resize'
import { Icon, type IconName } from './Icon'
import { Brand } from './Logo'
import { Mark } from './Mark'
import { WorkspaceModal } from './WorkspaceModal'

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Today', icon: 'today', end: true },
  { to: '/projects', label: 'Projects', icon: 'projects' },
  { to: '/people', label: 'People', icon: 'people' }
]

const listVariants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.028, delayChildren: 0.05 } }
}

const itemVariants = {
  hidden: { opacity: 0, y: 5 },
  shown: { opacity: 1, y: 0, transition: EXIT }
}

export function Sidebar(): React.JSX.Element {
  const workspace = useWorkspace()
  const inProject = useMatch('/projects/:id/*')
  const projectId = inProject?.params.id
  const reduceMotion = useReducedMotion() ?? false
  const { width, dragging, ref, onGrab, onReset } = useResizablePanel<HTMLElement>('sidebar')

  /*
    Inside a project the sidebar belongs to that project, so the tint follows it —
    but only when the project has a colour of its own. `projectColor()` is not what
    is wanted here: its fallback would hand back the workspace colour anyway, and
    reading the column directly is what keeps a colourless project looking exactly
    as it did before. The same recipe either way, so a project's tint is no louder
    than the workspace's, and the colour crossfades rather than snapping as you walk
    in and out.
  */
  const project = useApi('project:get', { id: projectId ?? '' }, { enabled: !!projectId })
  const tint = project.data?.project.color || workspace.color

  return (
    <aside
      ref={ref}
      className="sidebar-surface glass-chrome hairline relative flex shrink-0 flex-col border-r transition-[background-color] duration-500 ease-out"
      style={{
        width,
        /*
         * An ambient tint, so which area you are working in is answered by the whole
         * column rather than by reading the mark at the top of it. Enough of the colour
         * to be told apart from the workspace next door at a glance, and no more: it is
         * still a surface the sidebar's own text and marks have to read against, which
         * is what keeps this a mix into base-200 rather than the colour itself.
         */
        //
        // A custom property rather than the background itself, because Liquid Glass
        // has to make this same colour translucent and an inline style is the one
        // thing a stylesheet cannot argue with. `.sidebar-surface` paints it.
        //
        // `oklab`, not `oklch`, and that is the whole difference between orange and
        // pink. `oklch` is polar, so mixing interpolates the *hue angle*: base-200 is
        // a barely-there blue at h=265, an orange sits at h≈41, and the short way
        // round the wheel from one to the other runs up through 360 — so 30% of the
        // way lands at h≈306, which is magenta. The chroma is right, the hue is a
        // different colour entirely. `oklab` is rectangular; it scales the a/b of the
        // hue towards a near-neutral instead of rotating it, which is what "a little
        // of this colour" has always meant. Any mix of two real colours here wants
        // oklab. Mixing with `transparent` is unaffected — there is no second hue to
        // travel to — which is why the glass rules can stay as they are.
        ['--glass-tint' as string]: `color-mix(in oklab, ${tint} 30%, var(--color-base-200))`
      } as React.CSSProperties}
    >
      <PanelResizeHandle
        side="left"
        dragging={dragging}
        onGrab={onGrab}
        onReset={onReset}
        label="Resize the sidebar"
      />

      {/*
        The strip the traffic lights float over was empty; the app's own name belongs
        there. It is indented past them on macOS and sits at the normal gutter
        everywhere else, so nothing ever lands underneath a window control.
      */}
      <div
        className="drag-region flex h-[52px] shrink-0 items-center"
        style={{ paddingLeft: window.api.platform === 'darwin' ? 94 : 14 }}
      >
        <Brand size={17} />
      </div>

      {/*
        Entering a project is a drill-down, so the panels move like one: the workspace
        list leaves to the left, the project's own navigation arrives from the right,
        and its items settle in sequence. `mode="wait"` keeps the two from overlapping
        in a fixed-width column where they would collide.
      */}
      <div className="overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {projectId ? (
            <motion.div
              key={`project-${projectId}`}
              initial={{ x: reduceMotion ? 0 : 26, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: reduceMotion ? 0 : 26, opacity: 0 }}
              transition={ENTER}
            >
              <ProjectNav projectId={projectId} />
            </motion.div>
          ) : (
            <motion.div
              key="workspace"
              initial={{ x: reduceMotion ? 0 : -26, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: reduceMotion ? 0 : -26, opacity: 0 }}
              transition={ENTER}
            >
              <WorkspaceNav />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1" />
      {/*
        Only inside a project. The app's own settings hang off the ⋯ menu at the top
        right of the window, and a workspace's live in the switcher below it — on the
        workspace they belong to. A project's stay here because while you are in one
        this column *is* the project.
      */}
      {projectId && (
        <div className="px-3 pb-2">
          <NavLink
            to={`/projects/${projectId}/settings`}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-field px-2.5 py-[7px] text-[13px] transition ${
                isActive ? 'glass-lift bg-base-100 font-medium shadow-sm' : 'text-base-content/60 hover:bg-base-content/5'
              }`
            }
          >
            <Icon name="settings" size={15} className="opacity-70" />
            Project settings
          </NavLink>
        </div>
      )}
      <WorkspaceSwitcher />
    </aside>
  )
}

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `mb-0.5 flex items-center gap-2.5 rounded-field px-2.5 py-[7px] text-[13px] transition ${
    isActive
      ? 'glass-lift bg-base-100 font-medium text-base-content shadow-sm'
      : 'text-base-content/65 hover:bg-base-content/5'
  }`

function WorkspaceNav(): React.JSX.Element {
  const workspace = useWorkspace()
  const prefetch = usePrefetch()
  const todayView = useApi('dashboard:today', { workspaceId: workspace.id })
  const dueCount = (todayView.data?.overdue.length ?? 0) + (todayView.data?.dueToday.length ?? 0)

  /** Fetch what a link leads to while the pointer is still on its way to it. */
  const warm = (to: string): void => {
    if (to === '/projects') {
      prefetch('project:list', { workspaceId: workspace.id, status: 'all', archived: false })
      prefetch('folder:list', { workspaceId: workspace.id })
    } else if (to === '/people') prefetch('person:list', { workspaceId: workspace.id, query: '' })
  }

  return (
    <motion.nav className="px-3" variants={listVariants} initial="hidden" animate="shown">
      {NAV.map((item) => (
        <motion.div key={item.to} variants={itemVariants}>
          <NavLink to={item.to} end={item.end} className={linkClass} onPointerEnter={() => warm(item.to)}>
            <Icon name={item.icon} size={15} className="opacity-70" />
            <span className="flex-1">{item.label}</span>
            {item.to === '/' && dueCount > 0 && (
              <span className="rounded-full bg-error/12 px-1.5 text-[10px] font-semibold tabular-nums text-error">
                {dueCount}
              </span>
            )}
          </NavLink>
        </motion.div>
      ))}
    </motion.nav>
  )
}

const PROJECT_NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '', label: 'Today', icon: 'today', end: true },
  { to: 'kanban', label: 'Kanban', icon: 'board' },
  { to: 'meetings', label: 'Meetings', icon: 'people' },
  { to: 'notes', label: 'Notes', icon: 'note' },
  { to: 'decisions', label: 'Decisions', icon: 'decision' },
  { to: 'people', label: 'People', icon: 'inbox' }
]

/**
 * Inside a project the sidebar belongs to the project. One thing at a time is the
 * whole point — the way out is the button at the top, not a competing list of
 * everything else you could be doing instead.
 */
function ProjectNav({ projectId }: { projectId: string }): React.JSX.Element {
  const workspace = useWorkspace()
  const { data } = useApi('project:get', { id: projectId })

  const counts: Record<string, number | undefined> = {
    kanban: data?.tasks.filter((t) => t.status === 'open').length,
    meetings: data?.meetings.length,
    notes: data?.notes.length,
    decisions: data?.decisions.length,
    people: data?.cast.length
  }

  return (
    <>
      <div className="px-3">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ENTER}>
          <NavLink
            to="/projects"
            className="group mb-3 flex items-center gap-1.5 rounded-field px-2.5 py-[6px] text-[12px] text-base-content/55 transition hover:bg-base-content/5 hover:text-base-content"
          >
            <Icon
              name="arrowLeft"
              size={13}
              className="transition-transform group-hover:-translate-x-0.5"
            />
            {workspace.name}
          </NavLink>
        </motion.div>

        <motion.div
          className="mb-3 flex items-center gap-2.5 px-1"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...ENTER, delay: 0.03 }}
        >
          <Mark
            name={data?.project.name ?? '?'}
            color={data ? projectColor(data.project) : workspace.color}
            icon={data?.project.icon ?? null}
            size={28}
            rounded="rounded-[8px]"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold leading-tight">
              {data?.project.name ?? '…'}
            </div>
            {data && data.project.status !== 'active' && (
              <div className="mt-0.5 text-[11px] text-base-content/45">
                {STATUS_LABEL[data.project.status]}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <motion.nav className="px-3" variants={listVariants} initial="hidden" animate="shown">
        {PROJECT_NAV.map((item) => (
          <motion.div key={item.label} variants={itemVariants}>
            <NavLink
              to={item.to ? `/projects/${projectId}/${item.to}` : `/projects/${projectId}`}
              end={item.end}
              className={linkClass}
            >
              <Icon name={item.icon} size={15} className="opacity-70" />
              <span className="flex-1">{item.label}</span>
              {counts[item.to] !== undefined && counts[item.to]! > 0 && (
                <span className="text-[11px] tabular-nums text-base-content/35">{counts[item.to]}</span>
              )}
            </NavLink>
          </motion.div>
        ))}
      </motion.nav>
    </>
  )
}

function WorkspaceSwitcher(): React.JSX.Element {
  const { workspaces, archived, active, switchTo } = useWorkspaces()
  const restore = useApiMutation('workspace:setArchived')
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  if (!active) return <></>

  const close = (): void => setOpen(false)

  return (
    <div className="hairline relative border-t p-2">
      <button
        className="flex w-full items-center gap-2.5 rounded-field px-2 py-2 text-left transition hover:bg-base-content/5"
        onClick={() => setOpen((v) => !v)}
      >
        <Mark name={active.name} color={active.color} icon={active.icon} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{active.name}</span>
          <span className="block text-[10px] text-base-content/45">
            {workspaces.length === 1 ? 'Only workspace' : `${workspaces.length} workspaces`}
          </span>
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={13} className="text-base-content/35" />
      </button>

      {open && (
        <>
          {/* Click anywhere to dismiss, without stealing focus from the menu itself. */}
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="glass-raised rise hairline absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-50 overflow-hidden rounded-box border bg-base-100 shadow-xl shadow-black/10">
            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-base-content/35">
              Switch workspace
            </div>
            <div className="scroll-area max-h-64 pb-1">
              {workspaces.map((item) => (
                <button
                  key={item.id}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-base-200"
                  onClick={() => {
                    switchTo(item.id)
                    // Never leave the user inside a project belonging to the old workspace.
                    navigate('/')
                    close()
                  }}
                >
                  <Mark name={item.name} color={item.color} icon={item.icon} size={20} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
                  {item.id === active.id && <Icon name="check" size={13} className="text-primary" />}
                </button>
              ))}
            </div>
            {archived.length > 0 && (
              <div className="hairline border-t py-1">
                <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-base-content/35">
                  Archived
                </div>
                {archived.map((item) => (
                  <div key={item.id} className="group flex items-center gap-2.5 px-3 py-1.5">
                    <span className="opacity-45">
                      <Mark name={item.name} color={item.color} icon={item.icon} size={20} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-base-content/45">
                      {item.name}
                    </span>
                    <button
                      className="text-[11px] text-base-content/45 opacity-0 transition group-hover:opacity-100 hover:text-base-content"
                      onClick={async () => {
                        await restore.mutateAsync({ id: item.id, archived: false })
                        switchTo(item.id)
                        navigate('/')
                        close()
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="hairline border-t py-1">
              <button
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-base-content/70 transition hover:bg-base-200"
                onClick={() => {
                  navigate('/workspace')
                  close()
                }}
              >
                <Icon name="settings" size={14} className="opacity-60" />
                Workspace settings
              </button>
              <button
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-base-content/70 transition hover:bg-base-200"
                onClick={() => {
                  setCreating(true)
                  close()
                }}
              >
                <Icon name="plus" size={14} className="opacity-60" />
                New workspace
              </button>
            </div>
          </div>
        </>
      )}

      <WorkspaceModal
        open={creating}
        onClose={() => setCreating(false)}
        workspace={null}
        onSaved={(created) => {
          switchTo(created.id)
          navigate('/')
        }}
      />
    </div>
  )
}
