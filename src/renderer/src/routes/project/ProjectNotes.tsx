import { NotesTab } from '@/components/project/NotesTab'
import { DecisionsTab } from '@/components/project/DecisionsTab'
import { CastPanel } from '@/components/project/CastPanel'
import { useProject } from './ProjectLayout'

export function ProjectNotes(): React.JSX.Element {
  const { project, notes } = useProject()
  return <NotesTab projectId={project.id} notes={notes} />
}

export function ProjectDecisions(): React.JSX.Element {
  const { project, decisions } = useProject()
  return <DecisionsTab projectId={project.id} decisions={decisions} />
}

export function ProjectPeople(): React.JSX.Element {
  const { project, cast } = useProject()
  return <CastPanel projectId={project.id} cast={cast} />
}
