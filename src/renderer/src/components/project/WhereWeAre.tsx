import { useEffect, useState } from 'react'
import type { ProjectSummary } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { AutoTextarea } from '@/components/primitives'

const BLOCKS = [
  {
    key: 'currentState' as const,
    label: 'Where we are',
    placeholder:
      'The honest state of things right now. Write it for yourself in three weeks, not for a status report.'
  },
  {
    key: 'nextAction' as const,
    label: 'Next action',
    placeholder: 'The one thing that moves this forward. Concrete enough to just start.'
  },
  {
    key: 'openQuestions' as const,
    label: 'Open questions',
    placeholder: 'What is unresolved, and who could resolve it.'
  }
]

/**
 * A snapshot, deliberately overwritten — not a log. The journal keeps history;
 * this stays true. Saving happens on blur so it never feels like a form.
 */
export function WhereWeAre({ project }: { project: ProjectSummary }): React.JSX.Element {
  const save = useApiMutation('project:save')
  const [draft, setDraft] = useState({
    currentState: project.currentState,
    nextAction: project.nextAction,
    openQuestions: project.openQuestions
  })

  useEffect(() => {
    setDraft({
      currentState: project.currentState,
      nextAction: project.nextAction,
      openQuestions: project.openQuestions
    })
  }, [project.id, project.currentState, project.nextAction, project.openQuestions])

  const commit = (key: (typeof BLOCKS)[number]['key']): void => {
    if (draft[key] === project[key]) return
    save.mutate({ id: project.id, [key]: draft[key] })
  }

  return (
    <div className="mb-9 grid gap-5 sm:grid-cols-2">
      {BLOCKS.map((block, index) => (
        <div key={block.key} className={index === 0 ? 'sm:col-span-2' : ''}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-base-content/45">
            {block.label}
          </div>
          <AutoTextarea
            value={draft[block.key]}
            onChange={(value) => setDraft((d) => ({ ...d, [block.key]: value }))}
            onBlur={() => commit(block.key)}
            placeholder={block.placeholder}
            minRows={index === 0 ? 3 : 2}
            className="quiet-input"
          />
        </div>
      ))}
    </div>
  )
}
