import type {
  Activity, BoardColumn, CastMember, Decision, JournalEntry, Link, Membership, MeetingView, Note,
  Person, PersonProject, Project, ProjectStatus, Task, TaskView, Workspace
} from '@shared/types'
import { daysBetween, iso, isoOrNull, today } from './client'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

export const mapWorkspace = (r: Row, icon: string | null = null): Workspace => ({
  id: r.id,
  name: r.name,
  color: r.color,
  iconPath: r.icon_path ?? '',
  icon,
  sortOrder: r.sort_order,
  archivedAt: isoOrNull(r.archived_at),
  createdAt: iso(r.created_at)
})

export const mapProject = (r: Row, icon: string | null = null): Project => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  summary: r.summary,
  iconPath: r.icon_path ?? '',
  icon,
  color: r.color ?? '',
  deadline: r.deadline ?? null,
  status: r.status as ProjectStatus,
  isPinned: r.is_pinned,
  lastOpenedAt: isoOrNull(r.last_opened_at),
  previousOpenedAt: isoOrNull(r.previous_opened_at),
  lastActivityAt: iso(r.last_activity_at),
  createdAt: iso(r.created_at),
  archivedAt: isoOrNull(r.archived_at)
})

export const mapColumn = (r: Row): BoardColumn => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  sortOrder: r.sort_order,
  isDone: r.is_done,
  createdAt: iso(r.created_at)
})

export const mapPerson = (r: Row, avatar: string | null = null): Person => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  org: r.org,
  email: r.email,
  phone: r.phone,
  timezone: r.timezone,
  avatarColor: r.avatar_color,
  avatarPath: r.avatar_path ?? '',
  avatar,
  isMe: r.is_me ?? false,
  howToWorkWith: r.how_to_work_with,
  notes: r.notes,
  createdAt: iso(r.created_at)
})

export const mapMembership = (r: Row): Membership => ({
  id: r.id,
  personId: r.person_id,
  projectId: r.project_id,
  role: r.role,
  note: r.note,
  createdAt: iso(r.created_at)
})

export const mapCast = (r: Row, avatar: string | null = null): CastMember => ({
  ...mapMembership(r),
  name: r.name,
  org: r.org,
  email: r.email,
  avatarColor: r.avatar_color,
  avatar,
  isMe: r.is_me ?? false,
  howToWorkWith: r.how_to_work_with
})

export const mapPersonProject = (r: Row): PersonProject => ({
  ...mapMembership(r),
  projectName: r.project_name,
  projectStatus: r.project_status as ProjectStatus,
  workspaceName: r.workspace_name,
  workspaceColor: r.workspace_color
})

export const mapTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  details: r.details,
  kind: r.kind,
  status: r.status,
  columnId: r.column_id ?? null,
  dueDate: r.due_date,
  assigneePersonId: r.assignee_person_id ?? null,
  completedAt: isoOrNull(r.completed_at),
  sortOrder: r.sort_order,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapTaskView = (r: Row): TaskView => {
  const now = today()
  return {
    ...mapTask(r),
    projectName: r.project_name,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    workspaceColor: r.workspace_color,
    assigneeName: r.assignee_name ?? null,
    assigneeAvatar: r.assignee_avatar ?? null,
    assigneeColor: r.assignee_color ?? null,
    assigneeIsMe: r.assignee_is_me ?? false,
    daysUntilDue: r.due_date ? daysBetween(now, r.due_date) : null
  }
}

export const mapNote = (r: Row): Note => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  body: r.body,
  isPinned: r.is_pinned,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapMeeting = (r: Row): MeetingView => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  occurredOn: r.occurred_on,
  startsAt: r.starts_at,
  location: r.location,
  agenda: r.agenda,
  body: r.body,
  actions: r.actions,
  attendees: r.attendees ?? [],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapDecision = (r: Row): Decision => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  rationale: r.rationale,
  alternatives: r.alternatives,
  decidedBy: r.decided_by,
  decidedOn: r.decided_on,
  createdAt: iso(r.created_at)
})

export const mapLink = (r: Row): Link => ({
  id: r.id,
  projectId: r.project_id,
  label: r.label,
  url: r.url,
  kind: r.kind,
  sortOrder: r.sort_order
})

export const mapJournal = (r: Row): JournalEntry => ({
  id: r.id,
  projectId: r.project_id,
  body: r.body,
  occurredOn: r.occurred_on,
  createdAt: iso(r.created_at)
})

export const mapActivity = (r: Row): Activity => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  summary: r.summary,
  createdAt: iso(r.created_at)
})
