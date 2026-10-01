import { NotesTab } from '@/components/project/NotesTab'
import { DecisionsTab } from '@/components/project/DecisionsTab'
import { useProject } from './ProjectLayout'

export function ProjectNotes(): React.JSX.Element {
  const { project, notes, canvases, noteFolders } = useProject()
  return <NotesTab projectId={project.id} notes={notes} canvases={canvases} folders={noteFolders} />
}

export function ProjectDecisions(): React.JSX.Element {
  const { project, decisions, openQuestions } = useProject()
  return <DecisionsTab projectId={project.id} decisions={decisions} openQuestions={openQuestions} />
}
