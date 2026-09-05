import { Link } from 'react-router-dom'
import type { ProjectSummary } from '@shared/types'
import { plural, projectColor, STATUS_LABEL } from '@/lib/format'
import { DeadlineBar } from '@/components/DeadlineBar'

/**
 * Where the project stands, in one sentence.
 *
 * `project.attention` is the single most pressing fact about the project, derived
 * from the work rather than typed in by anyone — but it is a fragment ("3 overdue
 * items, oldest 5 days past due") written for a list, and it is null when there is
 * nothing pressing. A front page has to say something either way, so the null cases
 * are answered here rather than left blank: a project that is quiet has earned being
 * told so, and a project that is paused or done is in that state deliberately and
 * should say which.
 */
function standingLine(project: ProjectSummary, open: number, owed: number): string {
  if (project.attention) {
    return `${project.attention.charAt(0).toUpperCase()}${project.attention.slice(1)}.`
  }
  if (project.status !== 'active') {
    return `This project is ${(STATUS_LABEL[project.status] ?? project.status).toLowerCase()}.`
  }
  /*
   * Attention is derived from dated work and deadlines, so it cannot see a to-do
   * agreed in a room — which is exactly the thing nothing else raises. Without this
   * the page would head itself "nothing is late" with four unclosed to-dos in red
   * directly underneath it.
   */
  if (owed > 0) {
    return `Nothing is late, but ${plural(owed, 'to-do')} agreed in a meeting ${
      owed === 1 ? 'is' : 'are'
    } still open.`
  }
  if (open === 0) return 'Nothing is open on this project.'
  return 'Nothing is late, and no deadline is close.'
}

function Figure({
  value,
  label,
  to,
  tone
}: {
  value: number
  label: string
  to: string
  /** Colour is for the number being a problem, never for the project having a state. */
  tone?: 'error' | 'owing'
}): React.JSX.Element {
  const lit = value > 0
  const colour = !lit
    ? 'text-base-content/25'
    : tone === 'error'
      ? 'text-error'
      : tone === 'owing'
        ? 'owing-text'
        : ''
  return (
    <Link to={to} className="group block">
      <div className={`text-[22px] font-semibold tabular-nums tracking-[-0.02em] ${colour}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-base-content/45 transition group-hover:text-base-content/70">
        {label}
      </div>
    </Link>
  )
}

/**
 * The masthead of a project's front page: what it is asking for, how much of its
 * run-up has gone, and the two or three numbers you would otherwise open the board
 * to find. Deliberately unboxed — it is the page speaking, not a panel on it.
 */
export function Standing({
  project,
  open,
  overdue,
  owed,
  hasMeetings
}: {
  project: ProjectSummary
  open: number
  overdue: number
  owed: number
  hasMeetings: boolean
}): React.JSX.Element {
  return (
    <div className="hairline mb-8 border-b pb-7">
      <p className="max-w-2xl text-[16px] leading-relaxed tracking-[-0.005em]">
        {standingLine(project, open, owed)}
      </p>

      {/*
        How much of the run-up has gone, measured from the day the project was created
        rather than from nothing — the same bar the project cards carry, so the answer
        does not change depending on which screen you read it from. A project with no
        deadline has no run-up, and gets no bar rather than an empty one.
      */}
      {project.deadline && (
        <div className="max-w-md">
          <DeadlineBar
            deadline={project.deadline}
            createdAt={project.createdAt}
            color={projectColor(project)}
          />
        </div>
      )}

      <div className="mt-6 flex gap-11">
        <Figure value={overdue} label="overdue" to={`/projects/${project.id}/kanban`} tone="error" />
        {hasMeetings && (
          <Figure
            value={owed}
            label="owed from meetings"
            to={`/projects/${project.id}/meetings`}
            tone="owing"
          />
        )}
        <Figure value={open} label="open items" to={`/projects/${project.id}/kanban`} />
      </div>
    </div>
  )
}
